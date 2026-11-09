/**
 * 商品ごとの広告費（商品別レポートの集計）
 *
 * 楽天RPP の商品別は「商品管理番号（商品ページ）」単位で、SKU ごとの内訳は無い。
 * 1つの商品ページに SKU ごとの別商品がある場合（例：ism_3mainpage → r-sku001/002/003）は、
 * その期間の楽天の売上の比率で各商品に按分する（売上が無ければ均等に分ける）。
 * Amazon は SKU 単位なので、そのまま商品に付ける。
 */

export interface ProductAd { cost: number; sales: number; clicks: number; orders: number;
  /** モール別の内訳（amazon / rakuten） */
  byMall?: Record<string, { cost: number; sales: number }> }

const n = (v: unknown) => Number(v ?? 0) || 0;

/** 商品管理番号 → その番号で登録された商品の一覧（楽天） */
export async function rakutenPages(db: D1Database, caseId: string): Promise<Map<string, string[]>> {
  const { results } = await db.prepare(
    `SELECT l.external_id AS num, l.product_id FROM product_listings l JOIN products p ON p.id = l.product_id
      WHERE l.mall = 'rakuten' AND p.case_id = ?`
  ).bind(caseId).all<{ num: string; product_id: string }>();
  const m = new Map<string, string[]>();
  for (const r of results) {
    const a = m.get(r.num) ?? [];
    if (!a.includes(r.product_id)) a.push(r.product_id);
    m.set(r.num, a);
  }
  return m;
}

/** 期間の楽天の売上（商品ごと）。按分の重みに使う */
export async function rakutenRevenueByProduct(db: D1Database, caseId: string, from: string, to: string): Promise<Map<string, number>> {
  const { results } = await db.prepare(
    `SELECT product_id, SUM(revenue) AS revenue FROM daily_sales
      WHERE case_id = ? AND mall = 'rakuten' AND date BETWEEN ? AND ? AND product_id IS NOT NULL GROUP BY product_id`
  ).bind(caseId, from, to).all<{ product_id: string; revenue: number }>();
  return new Map(results.map((r) => [r.product_id, n(r.revenue)]));
}

/** 商品ページの各商品への按分比率（合計1） */
export function shares(pids: string[], revenue: Map<string, number>): Array<[string, number]> {
  const tot = pids.reduce((s, p) => s + (revenue.get(p) ?? 0), 0);
  return pids.map((p) => [p, tot > 0 ? (revenue.get(p) ?? 0) / tot : 1 / pids.length]);
}

export async function productAdTotals(db: D1Database, caseId: string, from: string, to: string): Promise<Map<string, ProductAd>> {
  const out = new Map<string, ProductAd>();
  const add = (pid: string, a: ProductAd, k = 1, mall = "amazon") => {
    const c = out.get(pid) ?? { cost: 0, sales: 0, clicks: 0, orders: 0, byMall: {} };
    c.cost += a.cost * k; c.sales += a.sales * k; c.clicks += a.clicks * k; c.orders += a.orders * k;
    const m = (c.byMall![mall] ??= { cost: 0, sales: 0 });
    m.cost += a.cost * k; m.sales += a.sales * k;
    out.set(pid, c);
  };

  const { results: amz } = await db.prepare(
    `SELECT product_id, SUM(cost) AS cost, SUM(sales) AS sales, SUM(clicks) AS clicks, SUM(orders) AS orders FROM daily_ads
      WHERE case_id = ? AND mall = 'amazon' AND level = 'product' AND date BETWEEN ? AND ? AND product_id IS NOT NULL
      GROUP BY product_id`
  ).bind(caseId, from, to).all<Record<string, string | number | null>>();
  for (const r of amz) add(String(r.product_id), { cost: n(r.cost), sales: n(r.sales), clicks: n(r.clicks), orders: n(r.orders) });

  const { results: rak } = await db.prepare(
    `SELECT external_id AS num, MAX(product_id) AS product_id, SUM(cost) AS cost, SUM(sales) AS sales, SUM(clicks) AS clicks, SUM(orders) AS orders
       FROM daily_ads WHERE case_id = ? AND mall = 'rakuten' AND level = 'product' AND date BETWEEN ? AND ?
      GROUP BY external_id`
  ).bind(caseId, from, to).all<Record<string, string | number | null>>();
  if (rak.length) {
    const pages = await rakutenPages(db, caseId);
    const revenue = await rakutenRevenueByProduct(db, caseId, from, to);
    for (const r of rak) {
      const a = { cost: n(r.cost), sales: n(r.sales), clicks: n(r.clicks), orders: n(r.orders) };
      const pids = pages.get(String(r.num ?? "")) ?? (r.product_id ? [String(r.product_id)] : []);
      for (const [pid, k] of shares(pids, revenue)) add(pid, a, k, "rakuten");
    }
  }
  for (const v of out.values()) {
    v.cost = Math.round(v.cost); v.sales = Math.round(v.sales);
    for (const m of Object.values(v.byMall ?? {})) { m.cost = Math.round(m.cost); m.sales = Math.round(m.sales); }
  }
  return out;
}
