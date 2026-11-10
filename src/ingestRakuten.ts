/**
 * 楽天の売上・在庫の取り込み
 *
 * 売上は楽天ペイ受注APIから。注文番号を検索して、明細をまとめて取る。
 * 在庫は在庫API 2.0 から全件取る。
 *
 * Amazonと違い、楽天には手数料の明細APIがない（請求データはAPI非対応）。
 * なので楽天の手数料は、案件ごとの料率設定からの概算になる。
 */

import { writeRakutenCustomers } from "./repeat";
import { readCreds, type ConnEnv } from "./connections";
import { rms, searchOrders, errorMessage, type RmsCreds } from "./rakuten";

export interface RakutenEnv extends ConnEnv {
  FILES: R2Bucket;
}

export interface RakutenOutcome {
  caseId: string;
  kind: "sales" | "inventory";
  status: "done" | "error";
  message: string;
  rows?: number;
  unknown?: string[];
}

const jstDate = (offsetDays = 0) =>
  new Date(Date.now() + 9 * 3600 * 1000 - offsetDays * 24 * 3600 * 1000).toISOString().slice(0, 10);

async function credsOf(env: RakutenEnv, caseId: string): Promise<RmsCreds | null> {
  const c = await readCreds(env, caseId, "rakuten");
  if (!c?.service_secret || !c?.license_key) return null;
  return { service_secret: c.service_secret, license_key: c.license_key };
}

/**
 * 楽天の出品 → 商品ID の引き当て。案件ごとに店舗が別なので、その案件の分だけ読む。
 * 1つの商品管理番号（商品ページ）に複数の SKU があり、SKU ごとに別の商品になっていることがあるので
 *   1. 商品管理番号＋SKU管理番号 が一致する商品
 *   2. 商品管理番号だけで登録された商品（SKU管理番号が空＝商品ページ単位）
 *   3. SKU管理番号だけが一致する商品（商品管理番号の書き間違いの救済）
 * の順に探す
 */
interface RakutenResolver {
  find(num: string, sku: string | null): string | null;
  /** SKU単位で登録されている商品管理番号か（在庫を SKU ごとに分けるかどうか） */
  skuLevel(num: string): boolean;
}
export async function rakutenResolver(db: D1Database, caseId: string): Promise<RakutenResolver> {
  const { results } = await db
    .prepare(
      `SELECT l.external_id AS num, l.sku_id AS sku, l.product_id FROM product_listings l
         JOIN products p ON p.id = l.product_id
        WHERE l.mall = 'rakuten' AND p.case_id = ?`
    )
    .bind(caseId)
    .all<{ num: string; sku: string; product_id: string }>();
  const both = new Map<string, string>(), page = new Map<string, string>(), bySku = new Map<string, string>();
  const skuNums = new Set<string>();
  for (const r of results) {
    if (r.sku) { both.set(`${r.num}\u0000${r.sku}`, r.product_id); bySku.set(r.sku, r.product_id); skuNums.add(r.num); }
    else page.set(r.num, r.product_id);
  }
  return {
    find: (num, sku) => (sku ? both.get(`${num}\u0000${sku}`) : undefined) ?? page.get(num) ?? (sku ? bySku.get(sku) : undefined) ?? null,
    skuLevel: (num) => skuNums.has(num),
  };
}

/** 注文明細の SKU管理番号（v7 の SkuModelList）。無ければ null */
export const skuOf = (it: RItem): string | null => {
  const m = (it.SkuModelList ?? [])[0];
  return (m?.variantId ?? m?.merchantDefinedSkuId ?? "").trim() || null;
};

/* ───────── 売上 ───────── */

interface RItem {
  itemNumber?: string;
  manageNumber?: string;
  itemName?: string;
  units?: number;
  price?: number;
  /** SKU の情報（version 7）。variantId が RMS の「SKU管理番号」 */
  SkuModelList?: Array<{ variantId?: string; merchantDefinedSkuId?: string; skuInfo?: string }>;
}
interface RPackage { ItemModelList?: RItem[] }
/**
 * クーポン。couponCapital はクーポンの原資（0＝店舗、1＝メーカー、2＝楽天）。
 * 店舗の値引きとして売上から引くのは、店舗が負担した分だけ。
 * 楽天・メーカー負担の分は、あとで楽天から「販促クーポン代金」として店舗に支払われるので、店舗の売上は減らない
 */
interface RCoupon { couponTotalPrice?: number; couponCapital?: number | string; couponName?: string }
interface ROrder {
  orderNumber?: string;
  orderDatetime?: string;          // 2026-10-30 12:34:56（日本時間）
  orderProgress?: number;
  PackageModelList?: RPackage[];
  CouponModelList?: RCoupon[];
}

/**
 * 指定した期間の受注を取り込む。
 * 期間の全量をその都度入れ直すので、何度実行しても二重にならない
 */
export async function ingestRakutenSales(
  env: RakutenEnv,
  caseId: string,
  from: string,
  to: string
): Promise<RakutenOutcome> {
  const creds = await credsOf(env, caseId);
  if (!creds) return { caseId, kind: "sales", status: "error", message: "楽天の接続情報が未登録です" };

  // 1. 注文番号を集める
  const numbers: string[] = [];
  for (let page = 1; page <= 20; page++) {
    const r = await searchOrders(creds, new Date(`${from}T00:00:00+09:00`), new Date(`${to}T23:59:59+09:00`),
      { page, perPage: 1000 });
    if (!r.ok) {
      return { caseId, kind: "sales", status: "error", message: `受注の検索に失敗：${errorMessage(r.body)}` };
    }
    const b = r.body as { orderNumberList?: string[]; PaginationResponseModel?: { totalPages?: number } };
    numbers.push(...(b.orderNumberList ?? []));
    if (page >= (b.PaginationResponseModel?.totalPages ?? 1)) break;
    await new Promise((res) => setTimeout(res, 400));
  }

  // 2. 明細を100件ずつ取る
  const orders: ROrder[] = [];
  for (let i = 0; i < numbers.length; i += 100) {
    const r = await rms(creds, "/2.0/order/getOrder/", {
      method: "POST",
      body: { orderNumberList: numbers.slice(i, i + 100), version: "7" },
    });
    if (!r.ok) {
      return { caseId, kind: "sales", status: "error", message: `受注の取得に失敗：${errorMessage(r.body)}` };
    }
    orders.push(...((r.body as { OrderModelList?: ROrder[] }).OrderModelList ?? []));
    await new Promise((res) => setTimeout(res, 400));
  }

  // 生データは残す。あとから計算をやり直せるようにするため
  const r2Key = `raw/rakuten/orders/${caseId}/${from}_${to}.json`;
  await env.FILES.put(r2Key, JSON.stringify(orders), { httpMetadata: { contentType: "application/json" } });

  // 3. 日 × 商品にまとめる
  const resolver = await rakutenResolver(env.DB, caseId);
  const agg = new Map<string, { date: string; productId: string; units: number; revenue: number; discounts: number }>();
  const unknown = new Set<string>();
  const dates = new Set<string>();

  let couponShop = 0, couponOther = 0;
  for (const o of orders) {
    if (o.orderProgress === 900) continue;                 // キャンセル確定は数えない
    const date = (o.orderDatetime ?? "").slice(0, 10);
    if (!date) continue;
    dates.add(date);

    const items: Array<{ productId: string | null; units: number; revenue: number }> = [];
    for (const p of o.PackageModelList ?? []) {
      for (const it of p.ItemModelList ?? []) {
        const num = (it.manageNumber ?? it.itemNumber ?? "").trim();
        const sku = skuOf(it);
        const units = Math.round(Number(it.units ?? 0));
        const revenue = Math.round(Number(it.price ?? 0)) * units;
        const productId = num ? resolver.find(num, sku) : null;
        if (num && !productId) unknown.add(sku ? `${num}（SKU ${sku}）` : num);
        items.push({ productId, units, revenue });
      }
    }

    // クーポンは注文単位で返るので、商品の売上に応じて割り振る
    // 原資が分からない（項目が無い）クーポンは、少なく見積もらないよう店舗負担として数える
    let coupon = 0;
    for (const c of o.CouponModelList ?? []) {
      const amt = Math.round(Number(c.couponTotalPrice ?? 0));
      const cap = c.couponCapital == null || c.couponCapital === "" ? 0 : Number(c.couponCapital);
      if (cap === 0) { coupon += amt; couponShop += amt; } else couponOther += amt;
    }
    const total = items.reduce((n, i) => n + i.revenue, 0);

    for (const it of items) {
      if (!it.productId) continue;
      const key = `${date}\u0000${it.productId}`;
      const a = agg.get(key) ?? { date, productId: it.productId, units: 0, revenue: 0, discounts: 0 };
      a.units += it.units;
      a.revenue += it.revenue;
      a.discounts += total > 0 ? Math.round((coupon * it.revenue) / total) : 0;
      agg.set(key, a);
    }
  }

  // 4. 期間ぶんを入れ直す
  const statements: D1PreparedStatement[] = [
    env.DB
      .prepare("DELETE FROM daily_sales WHERE case_id = ? AND mall = 'rakuten' AND date BETWEEN ? AND ?")
      .bind(caseId, from, to),
  ];
  for (const a of agg.values()) {
    statements.push(
      env.DB
        .prepare(
          `INSERT INTO daily_sales (case_id, mall, product_id, date, units, revenue, discounts, source)
           VALUES (?, 'rakuten', ?, ?, ?, ?, ?, 'api')`
        )
        .bind(caseId, a.productId, a.date, a.units, a.revenue, a.discounts)
    );
  }
  await env.DB.batch(statements);

  const notes: string[] = [];
  if (unknown.size) notes.push(`商品マスタに無い商品管理番号が ${unknown.size} 件：${[...unknown].slice(0, 10).join(", ")}`);
  // クーポンの内訳を残す（店舗負担だけを値引きに数えていることを、連携ステータスで確かめられるように）
  if (couponShop || couponOther) notes.push(`クーポン：店舗負担 ${couponShop.toLocaleString("ja-JP")}円（値引きに計上）／楽天・メーカー負担 ${couponOther.toLocaleString("ja-JP")}円（計上しない）`);
  // リピート率のための購入者の印（個人情報は保存しない。repeat.ts）
  // 失敗したとき（D1 の更新前など）は parser を 1 のままにして、あとで R2 の生データから作り直す
  let custParser = 2;
  const cust = await writeRakutenCustomers(env, caseId, from, to, orders)
    .catch((e) => { custParser = 1; return { note: `リピート判定は後で行います（${String(e).slice(0, 60)}）` }; });
  if (cust.note) notes.push(cust.note);
  const note = notes.length ? notes.join(" ／ ") : null;
  await env.DB.prepare(
    `INSERT INTO ingests (id, case_id, mall, kind, period_start, period_end, rows, status, error, r2_key, source, parser)
     VALUES (?, ?, 'rakuten', 'orders', ?, ?, ?, 'ok', ?, ?, 'api', ?)`
  ).bind(crypto.randomUUID(), caseId, from, to, agg.size, note, r2Key, custParser).run();

  return {
    caseId, kind: "sales", status: "done", rows: agg.size, unknown: [...unknown],
    message: `注文 ${orders.length} 件から ${agg.size} 行を取り込みました${note ? `（${note}）` : ""}`,
  };
}

/* ───────── 在庫 ───────── */

interface RInventory {
  manageNumber?: string;
  variantId?: string;
  quantity?: number;
}

/** 在庫を全件取る。商品管理番号ごとに合計する（バリエーションは足し合わせ） */
export async function ingestRakutenInventory(env: RakutenEnv, caseId: string): Promise<RakutenOutcome> {
  const creds = await credsOf(env, caseId);
  if (!creds) return { caseId, kind: "inventory", status: "error", message: "楽天の接続情報が未登録です" };

  const r = await rms(creds, "/2.0/inventories/bulk-get/range?minQuantity=0");
  if (!r.ok) {
    return { caseId, kind: "inventory", status: "error", message: `在庫の取得に失敗：${errorMessage(r.body)}` };
  }
  const list = ((r.body as { inventories?: RInventory[] }).inventories ?? []);

  const resolver = await rakutenResolver(env.DB, caseId);
  const byProduct = new Map<string, number>();
  const unknown = new Set<string>();
  for (const inv of list) {
    const num = (inv.manageNumber ?? "").trim();
    if (!num) continue;
    // SKU単位で登録された商品はその SKU の在庫だけ、商品ページ単位の商品は全 SKU の合計
    const productId = resolver.find(num, resolver.skuLevel(num) ? (inv.variantId ?? "").trim() || null : null);
    if (!productId) {
      if ((inv.quantity ?? 0) > 0) unknown.add(num);
      continue;
    }
    byProduct.set(productId, (byProduct.get(productId) ?? 0) + Math.round(Number(inv.quantity ?? 0)));
  }

  // 直近28日の販売ペース。データのある日数で割る（取り込めていない日を0として数えない）
  const since = jstDate(28);
  const { results: vel } = await env.DB
    .prepare(
      `SELECT product_id, SUM(units) AS units, COUNT(DISTINCT date) AS days
         FROM daily_sales
        WHERE case_id = ? AND mall = 'rakuten' AND date >= ? AND product_id IS NOT NULL
        GROUP BY product_id`
    )
    .bind(caseId, since)
    .all<{ product_id: string; units: number; days: number }>();
  const velocity = new Map(vel.filter((v) => v.days > 0).map((v) => [v.product_id, v.units / v.days]));

  const date = jstDate();
  const statements: D1PreparedStatement[] = [
    env.DB.prepare("DELETE FROM daily_inventory WHERE case_id = ? AND mall = 'rakuten' AND date = ?")
      .bind(caseId, date),
  ];
  for (const [productId, qty] of byProduct) {
    const v = velocity.get(productId) ?? null;
    const dos = v && v > 0 ? Math.round((qty / v) * 10) / 10 : null;
    statements.push(
      env.DB
        .prepare(
          `INSERT INTO daily_inventory
             (case_id, mall, product_id, date, qty, days_of_supply, inbound, reserved, unfulfillable, total, velocity)
           VALUES (?, 'rakuten', ?, ?, ?, ?, 0, 0, 0, ?, ?)`
        )
        .bind(caseId, productId, date, qty, dos, qty, v)
    );
  }
  await env.DB.batch(statements);

  const note = unknown.size
    ? `商品マスタに無い商品管理番号が ${unknown.size} 件：${[...unknown].slice(0, 10).join(", ")}`
    : null;
  await env.DB.prepare(
    `INSERT INTO ingests (id, case_id, mall, kind, rows, status, error, source)
     VALUES (?, ?, 'rakuten', 'inventory', ?, 'ok', ?, 'api')`
  ).bind(crypto.randomUUID(), caseId, byProduct.size, note).run();

  return {
    caseId, kind: "inventory", status: "done", rows: byProduct.size, unknown: [...unknown],
    message: `${byProduct.size} 商品ぶんの在庫を取り込みました${note ? `（${note}）` : ""}`,
  };
}

/* ───────── 全案件 ───────── */

export async function pumpRakuten(
  env: RakutenEnv,
  opts: { days?: number } = {}
): Promise<RakutenOutcome[]> {
  const days = opts.days ?? 7;
  const { results: cases } = await env.DB.prepare(
    `SELECT c.id FROM cases c
       JOIN case_malls m ON m.case_id = c.id AND m.mall = 'rakuten' AND m.credentials_enc IS NOT NULL
      WHERE c.status = 'active'`
  ).all<{ id: string }>();

  const out: RakutenOutcome[] = [];
  for (const c of cases) {
    out.push(await ingestRakutenSales(env, c.id, jstDate(days), jstDate(0)));
    out.push(await ingestRakutenInventory(env, c.id));
  }
  return out;
}
