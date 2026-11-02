/**
 * 楽天の商品情報との照合（商品API 2.0）
 *
 * 商品API 2.0 のうち無料なのは items.search と inv-settings.get の2つ。
 * items.get と items.bulk.get は別料金なので使わない。
 * そこで search で店舗の商品を全件めくって、商品管理番号で突き合わせる。
 * 店舗の商品数は数十なので、全件取っても1〜2回の呼び出しで済む。
 *
 * ここでやるのは3つ。
 *   1. マスタの商品管理番号がモールに実在するかの確認（打ち間違いの発見）
 *   2. 販売価格の取得（粗利の確認と、値下げの検知に使う）
 *   3. 店舗にあるのにマスタに無い商品の洗い出し（登録漏れの発見）
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

/**
 * 検索結果の1要素から商品を取り出す。
 * 楽天は results の要素を { item: {...} } のように包んで返すことがあるので、
 * 包まれていればひとつ潜る。どちらの形でも読めるようにしておく
 */
function asItem(el: unknown): RItem | null {
  if (!el || typeof el !== "object") return null;
  const o = el as Record<string, unknown>;
  if (typeof o.manageNumber === "string") return o as RItem;
  for (const v of Object.values(o)) {
    if (v && typeof v === "object" && typeof (v as Record<string, unknown>).manageNumber === "string") {
      return v as RItem;
    }
  }
  return null;
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

  // 店舗の商品を全件めくる。search は無料で使える
  const found = new Map<string, RItem>();
  let numFound = 0;
  for (let page = 0; page < 30; page++) {
    const r = await rms(creds, `/2.0/items/search?hits=100&offset=${page * 100}`);
    if (!r.ok) {
      const hint = r.status === 401
        ? "（RMS のアプリ一覧で itemapi_2.0.items.search にチェックが入っているか確認してください）"
        : "";
      return { caseId, status: "error", message: `商品情報の取得に失敗：${errorMessage(r.body)}${hint}` };
    }
    const b = r.body as { numFound?: number; results?: unknown[]; items?: unknown[] };
    numFound = b.numFound ?? 0;
    const list = b.results ?? b.items ?? [];
    for (const el of list) {
      const it = asItem(el);
      if (it?.manageNumber) found.set(it.manageNumber, it);
    }
    if (!list.length || (page + 1) * 100 >= numFound) break;
    await new Promise((res) => setTimeout(res, 400));
  }

  // 1件も返ってこなかったときに全部を「見つかりません」と書き込むと、
  // マスタが間違っているように見えてしまう。取得そのものを失敗として扱う
  if (found.size === 0) {
    return {
      caseId, status: "error",
      message: numFound > 0
        ? `店舗には ${numFound} 件ありますが、中身を読み取れませんでした。` +
          "応答の形が想定と違う可能性があります。接続タブの「APIを一通り試す」で中身を確認してください。" +
          "商品管理番号の判定は行っていません"
        : "店舗の商品が0件でした。接続している店舗が合っているかを確認してください。" +
          "商品管理番号の判定は行っていません",
    };
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

  // 店舗にあるのにマスタに無い商品（登録漏れ）
  const registered = new Set(listings.map((l) => l.num));
  const missingFromMaster = [...found.keys()].filter((n) => !registered.has(n));

  const notes: string[] = [];
  if (notFound.length) {
    notes.push(`楽天に見つからない商品管理番号が ${notFound.length} 件：${notFound.slice(0, 10).join(", ")}`);
  }
  if (missingFromMaster.length) {
    notes.push(`店舗にあるのにマスタに無い商品が ${missingFromMaster.length} 件：${missingFromMaster.slice(0, 10).join(", ")}`);
  }
  // 1件も一致しないときは、店舗側の番号の例を出す。
  // 書式の食い違い（大文字小文字・前後の空白など）に気づけるようにするため
  if (notFound.length === listings.length) {
    notes.push(`店舗側の番号の例：${[...found.keys()].slice(0, 5).join(", ")}`);
  }
  const note = notes.length ? notes.join(" ／ ") : null;
  await env.DB.prepare(
    `INSERT INTO ingests (id, case_id, mall, kind, rows, status, error, source)
     VALUES (?, ?, 'rakuten', 'items', ?, ?, ?, 'api')`
  ).bind(crypto.randomUUID(), caseId, listings.length, notFound.length ? "error" : "ok", note).run();

  return {
    caseId, status: "done", checked: listings.length, notFound,
    message: `マスタ ${listings.length} 件 / 店舗 ${numFound} 件を照合しました${note ? `／${note}` : "／すべて一致"}`,
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
