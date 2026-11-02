/**
 * 楽天の商品情報との照合（商品API 2.0）
 *
 * 商品API 2.0 のうち有料なのは items.search と inv-settings.get の2つだけで、
 * items.get / items.bulk.get は無料で使える。
 * 商品管理番号は商品マスタに持っているので検索は要らず、この2つで足りる。
 *
 * ここでやるのは2つ。
 *   1. マスタの商品管理番号がモールに実在するかの確認（打ち間違いの発見）
 *   2. 販売価格の取得（粗利の確認と、値下げの検知に使う）
 */

import { readCreds, type ConnEnv } from "./connections";
import { rms, errorMessage, type RmsCreds } from "./rakuten";

export interface ItemsEnv extends ConnEnv {}

export interface ItemsOutcome {
  caseId: string;
  status: "done" | "error";
  message: string;
  checked?: number;
  notFound?: string[];
}

interface RVariant { standardPrice?: string | number }
interface RItem {
  manageNumber?: string;
  title?: string;
  variants?: Record<string, RVariant>;
}

/** バリエーションの中でいちばん安い価格。1つしかなければその価格 */
function lowestPrice(item: RItem): number | null {
  const prices = Object.values(item.variants ?? {})
    .map((v) => Math.round(Number(v.standardPrice ?? NaN)))
    .filter((n) => Number.isFinite(n));
  return prices.length ? Math.min(...prices) : null;
}

/** 1案件ぶんを照合する。商品管理番号は50件ずつ送れる */
export async function syncRakutenItems(env: ItemsEnv, caseId: string): Promise<ItemsOutcome> {
  const c = await readCreds(env, caseId, "rakuten");
  if (!c?.service_secret || !c?.license_key) {
    return { caseId, status: "error", message: "楽天の接続情報が未登録です" };
  }
  const creds: RmsCreds = { service_secret: c.service_secret, license_key: c.license_key };

  const { results: listings } = await env.DB
    .prepare(
      `SELECT l.id, l.external_id AS num FROM product_listings l
         JOIN products p ON p.id = l.product_id
        WHERE l.mall = 'rakuten' AND p.case_id = ? AND p.status = 'active'`
    )
    .bind(caseId)
    .all<{ id: string; num: string }>();

  if (!listings.length) {
    return { caseId, status: "done", checked: 0, message: "照合する商品がありません（楽天の商品管理番号が未登録です）" };
  }

  const found = new Map<string, RItem>();
  for (let i = 0; i < listings.length; i += 50) {
    const batch = listings.slice(i, i + 50).map((l) => l.num);
    const r = await rms(creds, "/2.0/items/bulk-get", {
      method: "POST",
      body: { manageNumbers: batch },
    });
    if (!r.ok) {
      return { caseId, status: "error", message: `商品情報の取得に失敗：${errorMessage(r.body)}` };
    }
    for (const it of ((r.body as { result?: RItem[] }).result ?? [])) {
      if (it.manageNumber) found.set(it.manageNumber, it);
    }
    if (i + 50 < listings.length) await new Promise((res) => setTimeout(res, 400));
  }

  const now = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 19).replace("T", " ");
  const statements: D1PreparedStatement[] = [];
  const notFound: string[] = [];

  for (const l of listings) {
    const it = found.get(l.num);
    if (!it) {
      notFound.push(l.num);
      statements.push(
        env.DB
          .prepare("UPDATE product_listings SET checked_at = ?, check_status = 'not_found' WHERE id = ?")
          .bind(now, l.id)
      );
      continue;
    }
    statements.push(
      env.DB
        .prepare(
          `UPDATE product_listings
              SET price = ?, mall_name = ?, checked_at = ?, check_status = 'ok'
            WHERE id = ?`
        )
        .bind(lowestPrice(it), it.title ?? null, now, l.id)
    );
  }
  await env.DB.batch(statements);

  const note = notFound.length
    ? `楽天に見つからない商品管理番号が ${notFound.length} 件：${notFound.slice(0, 10).join(", ")}`
    : null;
  await env.DB.prepare(
    `INSERT INTO ingests (id, case_id, mall, kind, rows, status, error, source)
     VALUES (?, ?, 'rakuten', 'items', ?, ?, ?, 'api')`
  ).bind(crypto.randomUUID(), caseId, listings.length, notFound.length ? "error" : "ok", note).run();

  return {
    caseId, status: "done", checked: listings.length, notFound,
    message: `${listings.length} 件を照合しました${note ? `（${note}）` : "（すべて一致）"}`,
  };
}

/** 全案件ぶん */
export async function pumpRakutenItems(env: ItemsEnv): Promise<ItemsOutcome[]> {
  const { results: cases } = await env.DB.prepare(
    `SELECT c.id FROM cases c
       JOIN case_malls m ON m.case_id = c.id AND m.mall = 'rakuten' AND m.credentials_enc IS NOT NULL
      WHERE c.status = 'active'`
  ).all<{ id: string }>();

  const out: ItemsOutcome[] = [];
  for (const c of cases) out.push(await syncRakutenItems(env, c.id));
  return out;
}
