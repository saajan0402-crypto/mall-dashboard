/**
 * 案件の状況をまとめる
 *
 * ダッシュボードの画面と、AIに読ませる文章の両方がここを使う。
 * 同じ数字を2か所で別々に計算すると、いずれ食い違うので、計算はここに1つだけ置く。
 */

import { feeLabel, isKnownFee } from "./feeNames";
import { inventoryStatus, type InventoryRow } from "./ingestInventory";
import { resolveSettings } from "./settings";

/** 日本時間で n 日前の日付 */
export const jst = (n = 0) =>
  new Date(Date.now() + 9 * 3600 * 1000 - n * 86400000).toISOString().slice(0, 10);

const n = (v: unknown) => Number(v ?? 0);
const round1 = (v: number) => Math.round(v * 10) / 10;
const round2 = (v: number) => Math.round(v * 100) / 100;

/* ───────── 期間の損益 ───────── */

export interface MallPL {
  mall: string;
  units: number; revenue: number; returns: number; discounts: number;
  cost: number; fees: number; feesEst: number; feesAllocated: number;
  revenueWithoutCost: number; rowsWithoutActual: number; rowsTotal: number;
  /** 広告費を引く前の粗利。原価が分からない行は含めない */
  gross: number;
}

export interface PeriodSummary {
  from: string; to: string;
  byMall: MallPL[];
  units: number; revenue: number; returns: number; discounts: number;
  cost: number; fees: number; feesEst: number; feesAllocated: number;
  otherFees: number; gross: number;
  grossRate: number | null;
  /** 1 ÷ 広告費を除いた粗利率。ROASがこれを下回ると広告で赤字 */
  breakEvenRoas: number | null;
  revenueWithoutCost: number;
  actual: { missing: number; total: number };
  breakdown: Array<{ name: string; label: string; known: boolean; amount: number; count: number }>;
}

/** 期間の損益。モールごとに出してから合計する */
export async function periodSummary(db: D1Database, caseId: string, from: string, to: string): Promise<PeriodSummary> {
  // 原価が分からない行（要手計算・未登録・マスタに無いSKU）は粗利から外す。
  // 0円として数えると粗利が実態よりよく見え、損益分岐ROASも甘くなるため
  const { results: rows } = await db.prepare(
    `WITH r AS (
       SELECT s.*, COALESCE(s.fee_actual, s.fee_est, 0) AS fee,
         COALESCE(
           (SELECT unit_cost FROM cost_history h
             WHERE h.product_id = s.product_id AND h.effective_from <= s.date
             ORDER BY h.effective_from DESC LIMIT 1),
           (SELECT unit_cost FROM cost_history h
             WHERE h.product_id = s.product_id ORDER BY h.effective_from ASC LIMIT 1)) AS uc
         FROM daily_sales s
        WHERE s.case_id = ? AND s.date BETWEEN ? AND ?)
     SELECT mall,
       COALESCE(SUM(units), 0)     AS units,
       COALESCE(SUM(revenue), 0)   AS revenue,
       COALESCE(SUM(returns), 0)   AS returns,
       COALESCE(SUM(discounts), 0) AS discounts,
       COALESCE(SUM(COALESCE(uc, 0) * units), 0) AS cost,
       COALESCE(SUM(fee), 0) AS fees,
       COALESCE(SUM(CASE WHEN fee_actual IS NULL THEN COALESCE(fee_est, 0) ELSE 0 END), 0) AS fees_est,
       COALESCE(SUM(CASE WHEN fee_source = 'allocated' THEN COALESCE(fee_actual, 0) ELSE 0 END), 0) AS fees_allocated,
       COALESCE(SUM(CASE WHEN uc IS NULL THEN revenue ELSE 0 END), 0) AS revenue_without_cost,
       COALESCE(SUM(CASE WHEN uc IS NOT NULL
         THEN revenue - COALESCE(returns, 0) - COALESCE(discounts, 0) - fee - uc * units ELSE 0 END), 0) AS gross,
       SUM(CASE WHEN fee_actual IS NULL THEN 1 ELSE 0 END) AS rows_without_actual,
       COUNT(*) AS rows_total
     FROM r GROUP BY mall`
  ).bind(caseId, from, to).all<Record<string, number | string>>();

  const other = await db.prepare(
    `SELECT COALESCE(-SUM(amount), 0) AS amount FROM fee_events
      WHERE case_id = ? AND date BETWEEN ? AND ? AND product_id IS NULL AND kind = 'fee'`
  ).bind(caseId, from, to).first<{ amount: number }>();

  const { results: bd } = await db.prepare(
    `SELECT name, -SUM(amount) AS amount, COUNT(*) AS count FROM fee_events
      WHERE case_id = ? AND date BETWEEN ? AND ? AND kind IN ('fee', 'promotion', 'tax_withheld')
      GROUP BY name ORDER BY amount DESC`
  ).bind(caseId, from, to).all<{ name: string; amount: number; count: number }>();

  const byMall: MallPL[] = rows.map((r) => ({
    mall: String(r.mall),
    units: n(r.units), revenue: n(r.revenue), returns: n(r.returns), discounts: n(r.discounts),
    cost: n(r.cost), fees: n(r.fees), feesEst: n(r.fees_est), feesAllocated: n(r.fees_allocated),
    revenueWithoutCost: n(r.revenue_without_cost),
    rowsWithoutActual: n(r.rows_without_actual), rowsTotal: n(r.rows_total),
    gross: n(r.gross),
  }));

  const sum = (k: keyof MallPL) => byMall.reduce((t, m) => t + Number(m[k] ?? 0), 0);
  const revenue = sum("revenue");
  const otherFees = other?.amount ?? 0;
  const gross = sum("gross") - otherFees;
  /** 粗利を計算できた売上。粗利率と損益分岐ROASはこれを分母にする */
  const covered = revenue - sum("revenueWithoutCost");

  return {
    from, to, byMall,
    units: sum("units"), revenue, returns: sum("returns"), discounts: sum("discounts"),
    cost: sum("cost"), fees: sum("fees"), feesEst: sum("feesEst"), feesAllocated: sum("feesAllocated"),
    otherFees, gross,
    grossRate: covered > 0 ? round1((gross / covered) * 100) : null,
    breakEvenRoas: covered > 0 && gross > 0 ? round2(covered / gross) : null,
    revenueWithoutCost: sum("revenueWithoutCost"),
    actual: { missing: sum("rowsWithoutActual"), total: sum("rowsTotal") },
    breakdown: bd.map((b) => ({ ...b, label: feeLabel(b.name), known: isKnownFee(b.name) })),
  };
}

/* ───────── 広告 ───────── */

export interface AdTotal {
  mall: string;
  /** どの粒度で数えたか。キャンペーン別が無いときは商品別で代わりに数える */
  level: string;
  cost: number; sales: number; clicks: number; orders: number;
  roas: number | null;
  attribution: string;
}

/**
 * モールごとの広告費と広告経由売上。
 * 粒度を混ぜると同じ費用を何度も数えるので、モールごとに1つの粒度だけを使う
 */
async function adTotals(db: D1Database, caseId: string, from: string, to: string): Promise<AdTotal[]> {
  const { results } = await db.prepare(
    `SELECT mall, level, SUM(cost) AS cost, SUM(sales) AS sales, SUM(clicks) AS clicks, SUM(orders) AS orders,
            GROUP_CONCAT(DISTINCT ad_type) AS types, GROUP_CONCAT(DISTINCT attribution_days) AS attr
       FROM daily_ads WHERE case_id = ? AND date BETWEEN ? AND ?
      GROUP BY mall, level`
  ).bind(caseId, from, to).all<Record<string, string | number | null>>();

  const out: AdTotal[] = [];
  for (const mall of ["amazon", "rakuten"]) {
    const mine = results.filter((r) => r.mall === mall);
    const pick = ["campaign", "product", "keyword"].map((l) => mine.find((r) => r.level === l)).find(Boolean);
    if (!pick) continue;
    const cost = n(pick.cost), sales = n(pick.sales);
    out.push({
      mall, level: String(pick.level), cost, sales, clicks: n(pick.clicks), orders: n(pick.orders),
      roas: cost > 0 ? round2(sales / cost) : null,
      attribution: String(pick.attr ?? "").split(",").filter(Boolean).map((d) => `${d}日`).join("・"),
    });
  }
  return out;
}

/* ───────── まとめ ───────── */

export interface CaseSummary {
  caseId: string;
  caseName: string;
  asOf: string;
  generatedAt: string;
  malls: string[];
  sales: {
    yesterday: { date: string; revenue: number; units: number };
    last7: { revenue: number; units: number; sessions: number | null };
    prev7: { revenue: number; units: number };
    changeRate: number | null;
    trend: Array<{ date: string; revenue: number; units: number }>;
  };
  monthToDate: PeriodSummary;
  last30: PeriodSummary;
  ads: {
    last7: AdTotal[];
    last30: AdTotal[];
    tacos7: number | null;
    profitAfterAds30: number | null;
    campaigns: Array<{ mall: string; adType: string | null; name: string; cost: number; sales: number;
      roas: number | null; attribution: number | null; belowBreakEven: boolean; budgetCoverage: number | null }>;
    wastedTerms: Array<{ mall: string; adType: string; term: string; cost: number; clicks: number; impShare: number | null }>;
    winningTerms: Array<{ mall: string; adType: string; term: string; cost: number; sales: number; roas: number; orders: number }>;
    wastedKeywords: Array<{ term: string; product: string; cost: number; clicks: number }>;
  };
  products: Array<{ sku: string; name: string; units: number; revenue: number; gross: number | null;
    grossRate: number | null; adCost: number | null; costManual: boolean }>;
  inventory: InventoryRow[];
  freshness: Array<{ label: string; latest: string | null; daysAgo: number | null }>;
  warnings: string[];
  /** やること。画面とAIの両方に同じものを出す */
  todo: Todo[];
  settings: { targetMargin: number; stockAlertDays: number; rakutenFeeRate: number | null; amazonFeeRate: number | null;
    rakutenFeeFromDefault: boolean };
}

export interface Todo {
  /** high＝今週中、mid＝余裕があれば、info＝把握しておくこと */
  priority: "high" | "mid" | "info";
  area: "在庫" | "広告" | "売上" | "データ";
  text: string;
  /** 判断の根拠になった数字 */
  basis?: string;
}

const yenS = (v: number) => "¥" + Math.round(v).toLocaleString("ja-JP");
const MALL_JA: Record<string, string> = { amazon: "Amazon", rakuten: "楽天" };
const TYPE_JA: Record<string, string> = { sp: "SP", sb: "SB", sd: "SD", rpp: "RPP" };

/**
 * 決まりきった判断はここで出す。AIに任せるのはその先（優先順位づけ・打ち手の具体化）
 */
function buildTodo(s: Omit<CaseSummary, "todo">): Todo[] {
  const out: Todo[] = [];
  const be = s.last30.breakEvenRoas;

  // 売れている商品の在庫切れを先に出す。売れていない商品の在庫0は廃番のことが多い
  const outs = s.inventory.filter((x) => x.level === "out")
    .sort((a, b) => (b.velocity ?? 0) - (a.velocity ?? 0));
  for (const r of outs.slice(0, 8))
    out.push({ priority: (r.velocity ?? 0) > 0 || (r.subscriptions ?? 0) > 0 ? "high" : "mid", area: "在庫",
      text: `${MALL_JA[r.mall] ?? r.mall}「${r.name}」（${r.sku}）が在庫切れ。補充の手配を確認する`, basis: r.reason });
  if (outs.length > 8)
    out.push({ priority: "mid", area: "在庫", text: `ほかにも在庫切れが ${outs.length - 8} 件あります（在庫タブで確認）` });
  for (const r of s.inventory.filter((x) => x.level === "risk"))
    out.push({ priority: "high", area: "在庫", text: `${MALL_JA[r.mall] ?? r.mall}「${r.name}」（${r.sku}）が欠品間近。発注・納品のタイミングを決める`, basis: r.reason });

  const below = s.ads.campaigns.filter((c) => c.belowBreakEven && c.cost >= 3000);
  for (const c of below.slice(0, 5))
    out.push({
      priority: "high", area: "広告",
      text: `${MALL_JA[c.mall] ?? c.mall}${c.adType ? " " + (TYPE_JA[c.adType] ?? c.adType) : ""}「${c.name}」は広告で赤字。入札・対象キーワードを見直す`,
      basis: `直近30日 広告費 ${yenS(c.cost)} / ROAS ${c.roas} ＜ 損益分岐 ${be}`,
    });

  const wastedCost = s.ads.wastedTerms.reduce((t, w) => t + w.cost, 0);
  if (s.ads.wastedTerms.length && wastedCost >= 1000)
    out.push({
      priority: wastedCost >= 10000 ? "high" : "mid", area: "広告",
      text: `売上ゼロの検索語 ${s.ads.wastedTerms.length} 語を除外キーワードの候補として確認する（上位：${s.ads.wastedTerms.slice(0, 3).map((w) => w.term).join("、")}）`,
      basis: `直近30日で ${yenS(wastedCost)} を消化して売上0`,
    });

  const kwCost = s.ads.wastedKeywords.reduce((t, w) => t + w.cost, 0);
  if (s.ads.wastedKeywords.length && kwCost >= 1000)
    out.push({
      priority: "mid", area: "広告",
      text: `楽天RPPで売上ゼロのキーワード ${s.ads.wastedKeywords.length} 件の入札を下げるか外す（上位：${s.ads.wastedKeywords.slice(0, 3).map((w) => w.term).join("、")}）`,
      basis: `直近30日で ${yenS(kwCost)} を消化して売上0（楽天は30日帰属なので直近分はまだ増える可能性あり）`,
    });

  const short = s.ads.campaigns.filter((c) => c.budgetCoverage != null && c.budgetCoverage < 80 && !c.belowBreakEven && (c.roas ?? 0) > 0);
  for (const c of short.slice(0, 3))
    out.push({
      priority: "mid", area: "広告",
      text: `「${c.name}」は1日の途中で予算切れになっている。採算は取れているので予算の引き上げを検討する`,
      basis: `予算内に収まっていた時間 ${c.budgetCoverage}% / ROAS ${c.roas}${be ? `（損益分岐 ${be}）` : ""}`,
    });

  if (s.ads.winningTerms.length)
    out.push({
      priority: "mid", area: "広告",
      text: `成果の出ている検索語 ${s.ads.winningTerms.length} 語を完全一致で追加・入札強化の候補にする（上位：${s.ads.winningTerms.slice(0, 3).map((w) => w.term).join("、")}）`,
      basis: s.ads.winningTerms.slice(0, 3).map((w) => `${w.term} ROAS ${w.roas}・${w.orders}件`).join(" / "),
    });

  if (s.sales.changeRate != null && s.sales.changeRate <= -15)
    out.push({
      priority: "high", area: "売上",
      text: "直近7日の売上が前の7日より大きく落ちている。在庫・価格・広告の停止・検索順位のどれが原因か確認する",
      basis: `前週比 ${s.sales.changeRate}%（${yenS(s.sales.prev7.revenue)} → ${yenS(s.sales.last7.revenue)}）`,
    });

  for (const r of s.inventory.filter((x) => x.level === "watch").slice(0, 5))
    out.push({ priority: "mid", area: "在庫", text: `${MALL_JA[r.mall] ?? r.mall}「${r.name}」（${r.sku}）の在庫に注意`, basis: r.reason });

  for (const w of s.warnings) out.push({ priority: "info", area: "データ", text: w });
  const rank = { high: 0, mid: 1, info: 2 };
  return out.map((t, i) => ({ t, i })).sort((a, b) => rank[a.t.priority] - rank[b.t.priority] || a.i - b.i).map((x) => x.t);
}

const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

export async function buildCaseSummary(db: D1Database, caseId: string): Promise<CaseSummary | null> {
  const c = await db.prepare("SELECT id, name FROM cases WHERE id = ?").bind(caseId).first<{ id: string; name: string }>();
  if (!c) return null;

  const today = jst(0);
  const y = jst(1);
  const monthStart = `${y.slice(0, 7)}-01`;

  const { results: mallRows } = await db
    .prepare("SELECT mall FROM case_malls WHERE case_id = ? AND credentials_enc IS NOT NULL")
    .bind(caseId).all<{ mall: string }>();
  const malls = mallRows.map((m) => m.mall);

  /* 売上の推移 */
  const { results: trend } = await db.prepare(
    `SELECT date, SUM(revenue) AS revenue, SUM(units) AS units, SUM(sessions) AS sessions
       FROM daily_sales WHERE case_id = ? AND date BETWEEN ? AND ? GROUP BY date ORDER BY date`
  ).bind(caseId, jst(30), y).all<{ date: string; revenue: number; units: number; sessions: number | null }>();

  const inRange = (a: string, b: string) => trend.filter((t) => t.date >= a && t.date <= b);
  const sumOf = (list: typeof trend, k: "revenue" | "units") => list.reduce((s, t) => s + n(t[k]), 0);
  const last7 = inRange(jst(7), y), prev7 = inRange(jst(14), jst(8));
  const yd = trend.find((t) => t.date === y);
  const sessions7 = last7.reduce((s, t) => s + n(t.sessions), 0);

  const [mtd, l30] = await Promise.all([
    periodSummary(db, caseId, monthStart, y),
    periodSummary(db, caseId, jst(30), y),
  ]);

  /* 広告 */
  const [ads7, ads30] = await Promise.all([adTotals(db, caseId, jst(7), y), adTotals(db, caseId, jst(30), y)]);
  const adCost7 = ads7.reduce((s, a) => s + a.cost, 0);
  const adCost30 = ads30.reduce((s, a) => s + a.cost, 0);
  const be = l30.breakEvenRoas;

  const { results: camp } = await db.prepare(
    `SELECT mall, ad_type, campaign, SUM(cost) AS cost, SUM(sales) AS sales,
            MAX(attribution_days) AS attr, ROUND(AVG(budget_coverage), 1) AS cov
       FROM daily_ads WHERE case_id = ? AND level = 'campaign' AND date BETWEEN ? AND ?
      GROUP BY mall, ad_type, campaign HAVING SUM(cost) > 0 ORDER BY SUM(cost) DESC LIMIT 20`
  ).bind(caseId, jst(30), y).all<Record<string, string | number | null>>();

  const { results: wasted } = await db.prepare(
    `SELECT mall, ad_type, search_term, SUM(cost) AS cost, SUM(clicks) AS clicks, ROUND(AVG(imp_share), 1) AS share
       FROM daily_search_terms WHERE case_id = ? AND date BETWEEN ? AND ?
      GROUP BY mall, ad_type, search_term HAVING SUM(sales) = 0 AND SUM(cost) > 0
      ORDER BY SUM(cost) DESC LIMIT 10`
  ).bind(caseId, jst(30), y).all<Record<string, string | number | null>>();

  const { results: winning } = await db.prepare(
    `SELECT mall, ad_type, search_term, SUM(cost) AS cost, SUM(sales) AS sales, SUM(orders) AS orders
       FROM daily_search_terms WHERE case_id = ? AND date BETWEEN ? AND ?
      GROUP BY mall, ad_type, search_term HAVING SUM(cost) >= 500 AND SUM(orders) >= 2
      ORDER BY SUM(sales) * 1.0 / SUM(cost) DESC LIMIT 10`
  ).bind(caseId, jst(30), y).all<Record<string, string | number | null>>();

  const { results: wastedKw } = await db.prepare(
    `SELECT a.keyword, COALESCE(p.sku, a.external_id) AS product, SUM(a.cost) AS cost, SUM(a.clicks) AS clicks
       FROM daily_ads a LEFT JOIN products p ON p.id = a.product_id
      WHERE a.case_id = ? AND a.level = 'keyword' AND a.date BETWEEN ? AND ?
      GROUP BY a.keyword, a.external_id HAVING SUM(a.sales) = 0 AND SUM(a.cost) > 0
      ORDER BY SUM(a.cost) DESC LIMIT 10`
  ).bind(caseId, jst(30), y).all<Record<string, string | number | null>>();

  /* 商品別（直近30日） */
  const { results: prod } = await db.prepare(
    `SELECT p.id, p.sku, p.name, SUM(s.units) AS units, SUM(s.revenue) AS revenue,
            SUM(COALESCE(s.fee_actual, s.fee_est, 0)) AS fees,
            (SELECT unit_cost FROM cost_history h WHERE h.product_id = p.id
              ORDER BY h.effective_from DESC LIMIT 1) AS unit_cost,
            (SELECT needs_manual FROM cost_history h WHERE h.product_id = p.id
              ORDER BY h.effective_from DESC LIMIT 1) AS manual,
            (SELECT SUM(cost) FROM daily_ads a WHERE a.product_id = p.id AND a.level = 'product'
              AND a.date BETWEEN ? AND ?) AS ad_cost
       FROM daily_sales s JOIN products p ON p.id = s.product_id
      WHERE s.case_id = ? AND s.date BETWEEN ? AND ?
      GROUP BY p.id ORDER BY SUM(s.revenue) DESC LIMIT 15`
  ).bind(jst(30), y, caseId, jst(30), y).all<Record<string, string | number | null>>();

  const products = prod.map((p) => {
    const revenue = n(p.revenue);
    const gross = p.unit_cost == null ? null : revenue - n(p.unit_cost) * n(p.units) - n(p.fees);
    return {
      sku: String(p.sku), name: String(p.name), units: n(p.units), revenue,
      gross, grossRate: gross == null || !revenue ? null : round1((gross / revenue) * 100),
      adCost: p.ad_cost == null ? null : n(p.ad_cost),
      costManual: n(p.manual) === 1,
    };
  });

  /* 在庫 */
  const inventory = await inventoryStatus(db, caseId);

  /* データの鮮度 */
  const latest = async (sql: string) =>
    (await db.prepare(sql).bind(caseId).first<{ d: string | null }>())?.d ?? null;
  const sources: Array<[string, string, string]> = [
    ["Amazon 売上", "amazon", "SELECT MAX(date) AS d FROM daily_sales WHERE case_id = ? AND mall = 'amazon'"],
    ["Amazon 入金明細", "amazon", "SELECT MAX(date) AS d FROM fee_events WHERE case_id = ? AND mall = 'amazon'"],
    ["Amazon 在庫", "amazon", "SELECT MAX(date) AS d FROM daily_inventory WHERE case_id = ? AND mall = 'amazon'"],
    ["Amazon 広告", "amazon", "SELECT MAX(date) AS d FROM daily_ads WHERE case_id = ? AND mall = 'amazon'"],
    ["Amazon 検索用語", "amazon", "SELECT MAX(date) AS d FROM daily_search_terms WHERE case_id = ? AND mall = 'amazon'"],
    ["楽天 売上", "rakuten", "SELECT MAX(date) AS d FROM daily_sales WHERE case_id = ? AND mall = 'rakuten'"],
    ["楽天 在庫", "rakuten", "SELECT MAX(date) AS d FROM daily_inventory WHERE case_id = ? AND mall = 'rakuten'"],
    ["楽天 広告", "rakuten", "SELECT MAX(date) AS d FROM daily_ads WHERE case_id = ? AND mall = 'rakuten'"],
  ];
  const freshness = [];
  for (const [label, mall, sql] of sources) {
    if (malls.length && !malls.includes(mall)) continue;      // つないでいないモールは出さない
    const d = await latest(sql);
    freshness.push({ label, latest: d, daysAgo: d ? daysBetween(d, today) : null });
  }

  /* 設定 */
  const sAmz = await resolveSettings(db, { caseId, mall: "amazon" });
  const sRak = await resolveSettings(db, { caseId, mall: "rakuten" });
  const val = (list: { key: string; effective: number }[], k: string, d: number) =>
    list.find((s) => s.key === k)?.effective ?? d;
  const rate = (list: { isFeeRate: boolean; effective: number }[]) =>
    round1(list.filter((s) => s.isFeeRate).reduce((t, s) => t + s.effective, 0));
  const rakutenFeeFromDefault = sRak.caseMall.filter((s) => s.isFeeRate).every((s) => s.from === "既定");

  /* 気をつけること */
  const warnings: string[] = [];
  const manual = await db.prepare(
    `SELECT COUNT(*) AS c FROM products p WHERE p.case_id = ? AND p.status = 'active'
       AND (SELECT needs_manual FROM cost_history h WHERE h.product_id = p.id
             ORDER BY h.effective_from DESC LIMIT 1) = 1`
  ).bind(caseId).first<{ c: number }>();
  if (manual?.c) warnings.push(`原価が未確定（要手計算）の商品が ${manual.c} 件あります。その商品の粗利は計算に入っていません`);

  const noCost = await db.prepare(
    `SELECT COUNT(*) AS c FROM products p WHERE p.case_id = ? AND p.status = 'active'
       AND NOT EXISTS (SELECT 1 FROM cost_history h WHERE h.product_id = p.id)`
  ).bind(caseId).first<{ c: number }>();
  if (noCost?.c) warnings.push(`原価が登録されていない商品が ${noCost.c} 件あります`);

  if (malls.includes("rakuten")) {
    const lic = await db.prepare("SELECT license_expires_on AS d FROM case_malls WHERE case_id = ? AND mall = 'rakuten'")
      .bind(caseId).first<{ d: string | null }>();
    if (lic?.d) {
      const left = daysBetween(today, lic.d);
      if (left <= 30) warnings.push(`楽天のライセンスキーの期限まであと ${left} 日です（${lic.d}）`);
    }
    if (rakutenFeeFromDefault) warnings.push("楽天の手数料率が既定値のままです。楽天の粗利は実態とずれている可能性があります");
    const ch = await db.prepare("SELECT COUNT(*) AS c FROM mall_charges WHERE case_id = ? AND mall = 'rakuten' AND period_start = ?")
      .bind(caseId, monthStart).first<{ c: number }>();
    if (!ch?.c) warnings.push("今月の楽天の手数料は料率からの概算です（請求明細は未入力）");
  }
  for (const f of freshness) {
    if (f.latest == null) warnings.push(`${f.label} のデータがまだありません`);
    else if ((f.daysAgo ?? 0) > 3) warnings.push(`${f.label} の最新データが ${f.daysAgo} 日前（${f.latest}）で止まっています`);
  }

  const pl7 = sumOf(last7, "revenue");
  const base: Omit<CaseSummary, "todo"> = {
    caseId, caseName: c.name, asOf: y,
    generatedAt: new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 16).replace("T", " "),
    malls,
    sales: {
      yesterday: { date: y, revenue: n(yd?.revenue), units: n(yd?.units) },
      last7: { revenue: pl7, units: sumOf(last7, "units"), sessions: sessions7 || null },
      prev7: { revenue: sumOf(prev7, "revenue"), units: sumOf(prev7, "units") },
      changeRate: sumOf(prev7, "revenue") ? round1(((pl7 - sumOf(prev7, "revenue")) / sumOf(prev7, "revenue")) * 100) : null,
      trend: trend.map((t) => ({ date: t.date, revenue: n(t.revenue), units: n(t.units) })),
    },
    monthToDate: mtd,
    last30: l30,
    ads: {
      last7: ads7, last30: ads30,
      tacos7: pl7 ? round1((adCost7 / pl7) * 100) : null,
      profitAfterAds30: l30.revenue ? l30.gross - adCost30 : null,
      campaigns: camp.map((r) => {
        const cost = n(r.cost), sales = n(r.sales);
        const roas = cost > 0 ? round2(sales / cost) : null;
        return {
          mall: String(r.mall), adType: r.ad_type == null ? null : String(r.ad_type), name: String(r.campaign),
          cost, sales, roas, attribution: r.attr == null ? null : n(r.attr),
          belowBreakEven: be != null && roas != null && roas < be,
          budgetCoverage: r.cov == null ? null : n(r.cov),
        };
      }),
      wastedTerms: wasted.map((r) => ({ mall: String(r.mall), adType: String(r.ad_type), term: String(r.search_term),
        cost: n(r.cost), clicks: n(r.clicks), impShare: r.share == null ? null : n(r.share) })),
      winningTerms: winning.map((r) => ({ mall: String(r.mall), adType: String(r.ad_type), term: String(r.search_term),
        cost: n(r.cost), sales: n(r.sales), orders: n(r.orders), roas: round2(n(r.sales) / Math.max(1, n(r.cost))) })),
      wastedKeywords: wastedKw.map((r) => ({ term: String(r.keyword), product: String(r.product),
        cost: n(r.cost), clicks: n(r.clicks) })),
    },
    products, inventory, freshness, warnings,
    settings: {
      targetMargin: val(sAmz.case, "target_margin", 30),
      stockAlertDays: val(sAmz.case, "stock_alert_days", 14),
      rakutenFeeRate: malls.includes("rakuten") ? rate(sRak.caseMall) : null,
      amazonFeeRate: malls.includes("amazon") ? rate(sAmz.caseMall) : null,
      rakutenFeeFromDefault,
    },
  };
  return { ...base, todo: buildTodo(base) };
}
