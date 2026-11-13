/**
 * 案件の状況をまとめる
 *
 * ダッシュボードの画面と、AIに読ませる文章の両方がここを使う。
 * 同じ数字を2か所で別々に計算すると、いずれ食い違うので、計算はここに1つだけ置く。
 */

import { feeLabel, isKnownFee } from "./feeNames";
import { inventoryStatus, type InventoryRow } from "./ingestInventory";
import { resolveSettings } from "./settings";
import { listEvents, type SaleEvent } from "./events";
import { applyTodoStatus, doneInMonth, isoWeek, textKey, type TodoStatus, type DoneItem } from "./todos";
import { notifyEnabled } from "./cases";
import { amazonFinance, finCost, coveredSql, feeBasis } from "./amazonFin";
import { buildAllocation, type Allocation } from "./adAllocation";
import { externalAdCost, type ExternalAdCost } from "./externalAds";
import { repeatSummary, type RepeatSummary } from "./repeat";
import { keywordTodoData } from "./kwDiscovery";
import { productAdTotals } from "./adProducts";
import { latestCompleteMonth } from "./mallCharges";
import { buildAdAdvice, adviceWindows, type BidAdvice, type NegativeAdvice, type HarvestAdvice, type AdviceWindows, type CampaignResult } from "./adAdvice";

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
  /** Amazonポイントの費用 */
  points: number;
  cost: number; fees: number; feesEst: number; feesAllocated: number;
  revenueWithoutCost: number; rowsWithoutActual: number; rowsTotal: number;
  /** 広告費を引く前の粗利。原価が分からない行は含めない */
  gross: number;
}

export interface PeriodSummary {
  from: string; to: string;
  byMall: MallPL[];
  units: number; revenue: number; returns: number; discounts: number; points: number;
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
  // 0円として数えると粗利が実態よりよく見え、損益分岐ROASも甘くなるため。
  // Amazon で入金明細を取り込めている日（cov）は、日次の行の手数料・返品・値引きを使わず、
  // 下で入金明細（計上日）の合計を足す（amazonFin.ts の説明を参照）
  const basis = await feeBasis(db);
  const { results: rows } = await db.prepare(
    `WITH r AS (
       SELECT s.*, ${coveredSql(basis)} AS cov,
         COALESCE(
           (SELECT unit_cost FROM cost_history h
             WHERE h.product_id = s.product_id AND h.effective_from <= s.date
             ORDER BY h.effective_from DESC LIMIT 1),
           (SELECT unit_cost FROM cost_history h
             WHERE h.product_id = s.product_id ORDER BY h.effective_from ASC LIMIT 1)) AS uc
         FROM daily_sales s
        WHERE s.case_id = ? AND s.date BETWEEN ? AND ?),
     r2 AS (
       SELECT r.*,
         CASE WHEN cov THEN 0 ELSE COALESCE(fee_actual, fee_est, 0) END AS fee,
         CASE WHEN cov THEN 0 ELSE COALESCE(returns, 0) END AS ret,
         CASE WHEN cov THEN 0 ELSE COALESCE(discounts, 0) END AS disc
         FROM r)
     SELECT mall,
       COALESCE(SUM(units), 0)     AS units,
       COALESCE(SUM(revenue), 0)   AS revenue,
       COALESCE(SUM(ret), 0)       AS returns,
       COALESCE(SUM(disc), 0)      AS discounts,
       COALESCE(SUM(COALESCE(uc, 0) * units), 0) AS cost,
       COALESCE(SUM(fee), 0) AS fees,
       COALESCE(SUM(CASE WHEN NOT cov AND fee_actual IS NULL THEN COALESCE(fee_est, 0) ELSE 0 END), 0) AS fees_est,
       COALESCE(SUM(CASE WHEN fee_source = 'allocated' THEN COALESCE(fee_actual, 0) ELSE 0 END), 0) AS fees_allocated,
       COALESCE(SUM(CASE WHEN uc IS NULL THEN revenue ELSE 0 END), 0) AS revenue_without_cost,
       COALESCE(SUM(CASE WHEN uc IS NOT NULL THEN revenue - ret - disc - fee - uc * units ELSE 0 END), 0) AS gross,
       SUM(CASE WHEN NOT cov AND fee_actual IS NULL THEN 1 ELSE 0 END) AS rows_without_actual,
       COUNT(*) AS rows_total
     FROM r2 GROUP BY mall`
  ).bind(caseId, from, to).all<Record<string, number | string>>();

  // Amazon の入金明細（計上日）。原価の分からない商品の分は、その売上と同じく粗利から外す
  const fin = await amazonFinance(db, caseId, from, to, basis);
  const { results: noCost } = await db.prepare(
    `SELECT p.id FROM products p WHERE p.case_id = ?
        AND (SELECT unit_cost FROM cost_history h WHERE h.product_id = p.id ORDER BY h.effective_from DESC LIMIT 1) IS NULL`
  ).bind(caseId).all<{ id: string }>();
  const noCostIds = new Set(noCost.map((x) => x.id));
  let finGross = 0;
  for (const [pid, a] of fin.byProduct) if (!noCostIds.has(pid)) finGross += finCost(a);
  if (fin.byProduct.size && !rows.some((r) => r.mall === "amazon")) {
    rows.push({ mall: "amazon", units: 0, revenue: 0, returns: 0, discounts: 0, cost: 0, fees: 0, fees_est: 0, fees_allocated: 0,
      revenue_without_cost: 0, gross: 0, rows_without_actual: 0, rows_total: 0 });
  }
  for (const r of rows) {
    if (r.mall !== "amazon") continue;
    // 購入者から受け取った配送料は、手数料から差し引いて見せる（FBAの配送代行手数料と相殺される性質のため）
    r.fees = n(r.fees) + fin.total.fees - fin.total.shipping;
    r.returns = n(r.returns) + fin.total.refunds;
    r.discounts = n(r.discounts) + fin.total.promotions;
    r.points = fin.total.points;
    r.gross = n(r.gross) - finGross;
  }

  const other = await db.prepare(
    `SELECT COALESCE(-SUM(amount), 0) AS amount FROM fee_events
      WHERE case_id = ? AND basis = ? AND date BETWEEN ? AND ? AND product_id IS NULL AND kind = 'fee'`
  ).bind(caseId, basis, from, to).first<{ amount: number }>();

  const { results: bd } = await db.prepare(
    `SELECT name, -SUM(amount) AS amount, COUNT(*) AS count FROM fee_events
      WHERE case_id = ? AND basis = ? AND date BETWEEN ? AND ? AND kind IN ('fee', 'promotion', 'tax_withheld', 'points')
      GROUP BY name ORDER BY amount DESC`
  ).bind(caseId, basis, from, to).all<{ name: string; amount: number; count: number }>();

  const byMall: MallPL[] = rows.map((r) => ({
    mall: String(r.mall),
    units: n(r.units), revenue: n(r.revenue), returns: n(r.returns), discounts: n(r.discounts), points: n(r.points),
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
    units: sum("units"), revenue, returns: sum("returns"), discounts: sum("discounts"), points: sum("points"),
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
export async function adTotals(db: D1Database, caseId: string, from: string, to: string): Promise<AdTotal[]> {
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
  /** 見ている期間と、比べる直前の同じ長さの期間 */
  period: { from: string; to: string; days: number; preset: string | null };
  prev: { from: string; to: string };
  /** データがある範囲（全期間ボタン用） */
  dataRange: { from: string | null; to: string | null };
  generatedAt: string;
  malls: string[];
  sales: {
    total: { revenue: number; units: number; sessions: number | null };
    prev: { revenue: number; units: number };
    changeRate: number | null;
    perDay: number;
    /** 期間の最終日 */
    last: { date: string; revenue: number; units: number };
    trend: Array<{ date: string; revenue: number; units: number; amazon: number; rakuten: number }>;
  };
  /** 期間の損益 */
  pl: PeriodSummary;
  ads: {
    totals: AdTotal[];
    tacos: number | null;
    /** 粗利 − モールの広告費 − 外部広告費 */
    profitAfterAds: number | null;
    /** 外部広告費（税別・月の金額を日ごとに按分）。ROAS・ACoS・TACoS には入れない */
    external: ExternalAdCost;
    campaigns: Array<{ mall: string; adType: string | null; name: string; cost: number; sales: number;
      roas: number | null; attribution: number | null; belowBreakEven: boolean; budgetCoverage: number | null }>;
    wastedTerms: Array<{ mall: string; adType: string; term: string; cost: number; clicks: number; impShare: number | null }>;
    winningTerms: Array<{ mall: string; adType: string; term: string; cost: number; sales: number; roas: number; orders: number }>;
    wastedKeywords: Array<{ term: string; product: string; cost: number; clicks: number }>;
  };
  /** 広告の改善提案（件数と上位だけ。全部は広告タブで） */
  /** Amazon と楽天の間の広告費の配分（提案があれば proposal に入る） */
  allocation: Allocation;
  /** リピート率（楽天は注文データから、Amazon はブランド分析レポートから） */
  repeat: RepeatSummary;
  /** キーワード発見の要対応用の集計 */
  keywords: Awaited<ReturnType<typeof keywordTodoData>>;
  advice: {
    counts: { up: number; down: number; pause: number; negatives: number; harvest: number; budgets: number; watching: number };
    impact: { wastedCost: number; bidDownCost: number };
    /** 提案に使った期間（ヘッダーの期間とは別に固定） */
    windows: AdviceWindows;
    /** 広告で赤字のキャンペーン（提案と同じ期間） */
    losing: CampaignResult[];
    topBids: BidAdvice[];
    topNegatives: NegativeAdvice[];
    topHarvest: HarvestAdvice[];
  };
  products: Array<{ sku: string; name: string; units: number; revenue: number; gross: number | null;
    grossRate: number | null; adCost: number | null; costManual: boolean;
    /** モール別の内訳（ダッシュボードの「Amazon／楽天」切り替え用） */
    byMall: Record<string, { units: number; revenue: number; gross: number | null; grossRate: number | null; adCost: number | null }> }>;
  inventory: InventoryRow[];
  freshness: Array<{ label: string; latest: string | null; daysAgo: number | null }>;
  warnings: string[];
  /** やること。画面とAIの両方に同じものを出す */
  todo: Todo[];
  /** 期間にかかるセール・イベント（参加しなかったものも含む。participating で見分ける） */
  events: SaleEvent[];
  /** 今月「対応済み」にしたこと（お客様向けレポート用） */
  doneThisMonth: DoneItem[];
  settings: { targetMargin: number; adMargin: number; stockAlertDays: number; stockAlert: boolean; rakutenFeeRate: number | null; amazonFeeRate: number | null;
    rakutenFeeFromDefault: boolean };
}

/* ───────── 期間 ───────── */

export const PRESETS: Record<string, string> = {
  yesterday: "昨日", last7: "直近7日", last14: "直近14日", last30: "直近30日", last90: "直近90日",
  this_month: "今月", last_month: "先月", last_week: "先週（月〜日）", all: "全期間", custom: "期間を指定",
};

/** 案件のデータがある範囲。売上と広告のうち、いちばん古い日〜いちばん新しい日 */
export async function dataRange(db: D1Database, caseId: string): Promise<{ from: string | null; to: string | null }> {
  const r = await db.prepare(
    `SELECT MIN(d) AS a, MAX(e) AS b FROM (
       SELECT MIN(date) AS d, MAX(date) AS e FROM daily_sales WHERE case_id = ?1
       UNION ALL SELECT MIN(date), MAX(date) FROM daily_ads WHERE case_id = ?1
       UNION ALL SELECT MIN(date), MAX(date) FROM daily_search_terms WHERE case_id = ?1)`
  ).bind(caseId).first<{ a: string | null; b: string | null }>();
  const y = jst(1);
  return { from: r?.a ?? null, to: r?.b ? (r.b > y ? y : r.b) : null };
}

/** 決まった呼び名（直近30日など）から日付を出す。日付はすべて日本時間 */
export async function resolvePeriod(
  db: D1Database, caseId: string, q: { preset?: string | null; from?: string | null; to?: string | null },
): Promise<{ from: string; to: string; preset: string | null }> {
  const valid = (d?: string | null) => !!d && /^\d{4}-\d{2}-\d{2}$/.test(d);
  const y = jst(1);
  const preset = q.preset && PRESETS[q.preset] ? q.preset : null;
  if (preset === "custom" || (!preset && valid(q.from) && valid(q.to))) {
    if (valid(q.from) && valid(q.to)) {
      const [f, t] = [q.from!, q.to!].sort();
      return { from: f, to: t, preset: "custom" };
    }
  }
  const back = (d: number) => ({ from: jst(d), to: y });
  switch (preset) {
    case "yesterday": return { ...back(1), preset };
    case "last7": return { ...back(7), preset };
    case "last14": return { ...back(14), preset };
    case "last90": return { ...back(90), preset };
    case "this_month": { const f = `${y.slice(0, 7)}-01`; return { from: f, to: y, preset }; }
    case "last_week": {
      // 週次レポート用。直近の月曜〜日曜（今日が月曜なら、昨日までの1週間）
      const t = new Date(`${jst(0)}T00:00:00Z`);
      const dow = (t.getUTCDay() + 6) % 7;                  // 月曜＝0
      const end = new Date(t.getTime() - (dow + 1) * 86400000);
      const start = new Date(end.getTime() - 6 * 86400000);
      return { from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10), preset };
    }
    case "last_month": {
      const first = new Date(`${y.slice(0, 7)}-01T00:00:00Z`);
      const end = new Date(first.getTime() - 86400000).toISOString().slice(0, 10);
      return { from: `${end.slice(0, 7)}-01`, to: end, preset };
    }
    case "all": {
      const r = await dataRange(db, caseId);
      return { from: r.from ?? jst(30), to: r.to ?? y, preset };
    }
    default: return { ...back(30), preset: "last30" };
  }
}

export interface Todo {
  /** 状態（対応済みなど）を結びつけるための鍵 */
  key: string;
  /** high＝今週中、mid＝余裕があれば、info＝把握しておくこと */
  priority: "high" | "mid" | "info";
  area: "在庫" | "広告" | "売上" | "データ";
  text: string;
  /** 判断の根拠になった数字 */
  basis?: string;
  status?: TodoStatus;
  statusBy?: string | null;
  statusAt?: string | null;
  note?: string | null;
}

const yenS = (v: number) => "¥" + Math.round(v).toLocaleString("ja-JP");
const MALL_JA: Record<string, string> = { amazon: "Amazon", rakuten: "楽天" };
const TYPE_JA: Record<string, string> = { sp: "SP", sb: "SB", sd: "SD", rpp: "RPP" };

/**
 * 決まりきった判断はここで出す。AIに任せるのはその先（優先順位づけ・打ち手の具体化）
 */
const ac0 = (s: Omit<CaseSummary, "todo" | "doneThisMonth">) => s.advice.counts;

function buildTodo(s: Omit<CaseSummary, "todo" | "doneThisMonth">): Todo[] {
  const out: Todo[] = [];
  const wk = isoWeek();
  const be = s.pl.breakEvenRoas;

  // 売れている商品の在庫切れを先に出す。売れていない商品の在庫0は廃番のことが多い
  const outs = s.inventory.filter((x) => x.level === "out")
    .sort((a, b) => (b.velocity ?? 0) - (a.velocity ?? 0));
  for (const r of outs.slice(0, 8))
    out.push({ key: `stock:${r.mall}:${r.sku}`, priority: (r.velocity ?? 0) > 0 || (r.subscriptions ?? 0) > 0 ? "high" : "mid", area: "在庫",
      text: `${MALL_JA[r.mall] ?? r.mall}「${r.name}」（${r.sku}）が在庫切れ。補充の手配を確認する`, basis: r.reason });
  if (outs.length > 8)
    out.push({ key: `stock_more:${wk}`, priority: "mid", area: "在庫", text: `ほかにも在庫切れが ${outs.length - 8} 件あります（在庫タブで確認）` });
  for (const r of s.inventory.filter((x) => x.level === "risk"))
    out.push({ key: `stock:${r.mall}:${r.sku}`, priority: "high", area: "在庫", text: `${MALL_JA[r.mall] ?? r.mall}「${r.name}」（${r.sku}）が欠品間近。発注・納品のタイミングを決める`, basis: r.reason });

  // 提案と同じ固定の期間（Amazon 30日・楽天 60日）で判断する。ヘッダーの期間で要対応が変わらないように
  const W = s.advice.windows;
  for (const c of s.advice.losing)
    out.push({
      key: `ad_be:${c.mall}:${c.campaign}`, priority: "high", area: "広告",
      text: `${MALL_JA[c.mall] ?? c.mall}${c.adType ? " " + (TYPE_JA[c.adType] ?? c.adType) : ""}「${c.campaign}」は広告で赤字。入札・対象キーワードを見直す`,
      basis: `直近${c.mall === "rakuten" ? W.rakuten.days : W.amazon.days}日の広告費 ${yenS(c.cost)} / ROAS ${c.roas} ＜ 損益分岐 ${c.breakEven}`,
    });

  if (ac0(s).negatives)
    out.push({
      key: `ad_neg:${wk}`, priority: s.advice.impact.wastedCost >= 10000 ? "high" : "mid", area: "広告",
      text: `除外キーワードの候補が ${s.advice.counts.negatives} 件あります（上位：${s.advice.topNegatives.slice(0, 3).map((w) => w.searchTerm).join("、")}）`,
      basis: s.advice.impact.wastedCost ? `売上0の検索語に期間内 ${yenS(s.advice.impact.wastedCost)}` : undefined,
    });

  if (s.sales.changeRate != null && s.sales.changeRate <= -15)
    out.push({
      key: `sales_drop:${wk}`, priority: "high", area: "売上",
      text: `売上が直前の${s.period.days}日より大きく落ちている。在庫・価格・広告の停止・検索順位のどれが原因か確認する`,
      basis: `前期間比 ${s.sales.changeRate}%（${yenS(s.sales.prev.revenue)} → ${yenS(s.sales.total.revenue)}）`,
    });

  const ac = s.advice.counts;
  if (ac.pause + ac.down + ac.up)
    out.push({
      key: `ad_bids:${wk}`, priority: ac.pause ? "high" : "mid", area: "広告",
      text: `入札の見直し候補：停止を検討 ${ac.pause}件・下げる ${ac.down}件・上げる ${ac.up}件（広告タブの「改善提案」に具体的な金額）`,
      basis: s.advice.impact.bidDownCost ? `下げる・停止の対象に期間内 ${yenS(s.advice.impact.bidDownCost)} を使っている` : undefined,
    });
  // 新しいキーワード：改善提案の「追加キーワード」とキーワード発見の候補を1件にまとめる（多くなりすぎないように）
  const kw = s.keywords;
  if (ac.harvest || (kw && (kw.strong || kw.reco || kw.rakuten))) {
    const parts = [
      ac.harvest ? `完全一致で追加する候補 ${ac.harvest}件（広告タブの改善提案）` : "",
      kw?.strong ? `検索語で売れたのに未入札 ${kw.strong}件` : "",
      kw?.rakuten ? `Amazon で売れた語のうち楽天RPPに未登録 ${kw.rakuten}件` : "",
      kw?.reco ? `Amazon の推奨 ${kw.reco}件` : "",
    ].filter(Boolean);
    out.push({ key: `ad_harvest:${wk}`, priority: kw?.strong || kw?.rakuten ? "mid" : "info", area: "広告",
      text: `新しいキーワードの候補：${parts.join("・")}。キーワード発見タブで選んで入札を追加する`,
      basis: kw?.top.length ? `上位：${kw.top.join("、")}` : undefined });
  }
  // 監視キーワードで自社の順位が大きく落ちたもの（まとめて1件）
  if (kw?.drops.length) {
    const d = kw.drops.slice(0, 3).map((x) => `${MALL_JA[x.mall] ?? x.mall}「${x.keyword}」${x.before}位→${x.now == null ? "圏外" : x.now + "位"}`);
    out.push({ key: `kw_drop:${wk}`, priority: "mid", area: "広告",
      text: `監視キーワードで自社の順位が1週間で大きく落ちています（${kw.drops.length}件）。競合の価格・セール・広告の強化を確認する`, basis: d.join("／") });
  }
  if (ac.budgets)
    out.push({ key: `ad_budget:${wk}`, priority: "mid", area: "広告", text: `予算切れで売上を逃しているキャンペーンが ${ac.budgets} 件あります（広告タブの「改善提案」の予算。Amazon はほかのキャンペーンの減額とセットで合計を変えずに入れ替え）` });

  for (const r of s.inventory.filter((x) => x.level === "watch").slice(0, 5))
    out.push({ key: `stock:${r.mall}:${r.sku}`, priority: "mid", area: "在庫", text: `${MALL_JA[r.mall] ?? r.mall}「${r.name}」（${r.sku}）の在庫に注意`, basis: r.reason });

  // 目標粗利率は広告費を引く前の基準。下回る商品は価格・原価・手数料の見直し対象
  const low = s.products.filter((p) => !p.costManual && p.grossRate != null && p.grossRate < s.settings.targetMargin && p.revenue > 0);
  if (low.length)
    out.push({
      key: `low_margin:${jst(0).slice(0, 7)}`, priority: "mid", area: "売上",
      text: `粗利率が目標（${s.settings.targetMargin}%・広告費前）を下回る商品が ${low.length} 件。価格・原価・送料の設定を確認する（${low.slice(0, 3).map((p) => p.sku).join("、")}）`,
      basis: low.slice(0, 3).map((p) => `${p.sku} ${p.grossRate}%`).join(" / "),
    });

  // モール間の広告費の配分（両方のモールに広告があり、差が大きいとき）
  const ap = s.allocation?.proposal;
  if (ap) {
    const ja = (m: string | null) => (m === "rakuten" ? "楽天" : m === "amazon" ? "Amazon" : "");
    out.push({ key: `alloc:${wk}`, priority: "mid", area: "広告",
      text: ap.action === "shift"
        ? `広告費の配分：${ja(ap.fromMall)}から${ja(ap.toMall)}へ30日あたり ¥${ap.amount30d.toLocaleString("ja-JP")} 移す（ダッシュボードの「モール間の広告費の配分」に根拠）`
        : ap.action === "add"
        ? `広告費の配分：月の広告予算に余裕があるので、${ja(ap.toMall)}を30日あたり ¥${ap.amount30d.toLocaleString("ja-JP")} 増やす`
        : `広告費の配分：${ja(ap.fromMall)}の広告費を30日あたり ¥${ap.amount30d.toLocaleString("ja-JP")} 減らす（${s.allocation?.budget && s.allocation.budget.projected > s.allocation.budget.amount ? "月の広告予算を超えるペースのため" : "赤字のため"}）`,
      basis: `利益の増え方の目安 30日あたり ¥${ap.expectedProfit30d.toLocaleString("ja-JP")}` });
  }

  for (const w of s.warnings) out.push({ key: `info:${textKey(w)}`, priority: "info", area: "データ", text: w });
  const rank = { high: 0, mid: 1, info: 2 };
  return out.map((t, i) => ({ t, i })).sort((a, b) => rank[a.t.priority] - rank[b.t.priority] || a.i - b.i).map((x) => x.t);
}

const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

export async function buildCaseSummary(
  db: D1Database, caseId: string,
  q: { preset?: string | null; from?: string | null; to?: string | null } = {},
  opts: { trackTodos?: boolean; productLimit?: number } = {},
): Promise<CaseSummary | null> {
  const c = await db.prepare("SELECT id, name FROM cases WHERE id = ?").bind(caseId).first<{ id: string; name: string }>();
  if (!c) return null;

  const today = jst(0);
  const per = await resolvePeriod(db, caseId, q);
  const { from, to } = per;
  const days = daysBetween(from, to) + 1;
  const prevTo = new Date(Date.parse(from) - 86400000).toISOString().slice(0, 10);
  const prevFrom = new Date(Date.parse(from) - days * 86400000).toISOString().slice(0, 10);
  const monthStart = `${jst(1).slice(0, 7)}-01`;

  const { results: mallRows } = await db
    .prepare("SELECT mall FROM case_malls WHERE case_id = ? AND credentials_enc IS NOT NULL")
    .bind(caseId).all<{ mall: string }>();
  const malls = mallRows.map((m) => m.mall);

  /* 売上の推移（期間内） */
  const { results: trend } = await db.prepare(
    `SELECT date, SUM(revenue) AS revenue, SUM(units) AS units, SUM(sessions) AS sessions,
            SUM(CASE WHEN mall = 'amazon' THEN revenue ELSE 0 END) AS amazon,
            SUM(CASE WHEN mall = 'rakuten' THEN revenue ELSE 0 END) AS rakuten
       FROM daily_sales WHERE case_id = ? AND date BETWEEN ? AND ? GROUP BY date ORDER BY date`
  ).bind(caseId, from, to).all<{ date: string; revenue: number; units: number; sessions: number | null; amazon: number; rakuten: number }>();
  const prevAgg = await db.prepare(
    `SELECT COALESCE(SUM(revenue), 0) AS revenue, COALESCE(SUM(units), 0) AS units, COUNT(DISTINCT date) AS n
       FROM daily_sales WHERE case_id = ? AND date BETWEEN ? AND ?`
  ).bind(caseId, prevFrom, prevTo).first<{ revenue: number; units: number; n: number }>();
  const revenue = trend.reduce((t, x) => t + n(x.revenue), 0);
  const units = trend.reduce((t, x) => t + n(x.units), 0);
  const sessions = trend.reduce((t, x) => t + n(x.sessions), 0);
  const lastDay = trend.find((t) => t.date === to);
  const prevRevenue = n(prevAgg?.revenue);
  // 直前の期間のデータが欠けていると比較がおかしくなるので、8割以上の日が揃っているときだけ出す
  const prevComplete = n(prevAgg?.n) >= days * 0.8;

  const pl = await periodSummary(db, caseId, from, to);

  /* 広告 */
  const totals = await adTotals(db, caseId, from, to);
  const adCost = totals.reduce((t, a) => t + a.cost, 0);
  const be = pl.breakEvenRoas;

  const { results: camp } = await db.prepare(
    `SELECT mall, ad_type, campaign, SUM(cost) AS cost, SUM(sales) AS sales,
            MAX(attribution_days) AS attr, ROUND(AVG(budget_coverage), 1) AS cov
       FROM daily_ads WHERE case_id = ? AND level = 'campaign' AND date BETWEEN ? AND ?
      GROUP BY mall, ad_type, campaign HAVING SUM(cost) > 0 ORDER BY SUM(cost) DESC LIMIT 20`
  ).bind(caseId, from, to).all<Record<string, string | number | null>>();

  const { results: wasted } = await db.prepare(
    `SELECT mall, ad_type, search_term, SUM(cost) AS cost, SUM(clicks) AS clicks, ROUND(AVG(imp_share), 1) AS share
       FROM daily_search_terms WHERE case_id = ? AND date BETWEEN ? AND ?
      GROUP BY mall, ad_type, search_term HAVING SUM(sales) = 0 AND SUM(cost) > 0
      ORDER BY SUM(cost) DESC LIMIT 10`
  ).bind(caseId, from, to).all<Record<string, string | number | null>>();

  const { results: winning } = await db.prepare(
    `SELECT mall, ad_type, search_term, SUM(cost) AS cost, SUM(sales) AS sales, SUM(orders) AS orders
       FROM daily_search_terms WHERE case_id = ? AND date BETWEEN ? AND ?
      GROUP BY mall, ad_type, search_term HAVING SUM(cost) >= 500 AND SUM(orders) >= 2
      ORDER BY SUM(sales) * 1.0 / SUM(cost) DESC LIMIT 10`
  ).bind(caseId, from, to).all<Record<string, string | number | null>>();

  const { results: wastedKw } = await db.prepare(
    `SELECT a.keyword, COALESCE(p.sku, a.external_id) AS product, SUM(a.cost) AS cost, SUM(a.clicks) AS clicks
       FROM daily_ads a LEFT JOIN products p ON p.id = a.product_id
      WHERE a.case_id = ? AND a.mall = 'rakuten' AND a.level = 'keyword' AND a.date BETWEEN ? AND ?
      GROUP BY a.keyword, a.external_id HAVING SUM(a.sales) = 0 AND SUM(a.cost) > 0
      ORDER BY SUM(a.cost) DESC LIMIT 10`
  ).bind(caseId, from, to).all<Record<string, string | number | null>>();

  /* 商品別（期間内） */
  const prodBasis = await feeBasis(db);
  const { results: prodRows } = await db.prepare(
    `SELECT p.id, p.sku, p.name, s.mall, SUM(s.units) AS units, SUM(s.revenue) AS revenue,
            SUM(CASE WHEN ${coveredSql(prodBasis)} THEN 0 ELSE COALESCE(s.fee_actual, s.fee_est, 0) + COALESCE(s.returns, 0) + COALESCE(s.discounts, 0) END) AS fees,
            (SELECT unit_cost FROM cost_history h WHERE h.product_id = p.id
              ORDER BY h.effective_from DESC LIMIT 1) AS unit_cost,
            (SELECT needs_manual FROM cost_history h WHERE h.product_id = p.id
              ORDER BY h.effective_from DESC LIMIT 1) AS manual
       FROM daily_sales s JOIN products p ON p.id = s.product_id
      WHERE s.case_id = ? AND s.date BETWEEN ? AND ?
      GROUP BY p.id, s.mall`
  ).bind(caseId, from, to).all<Record<string, string | number | null>>();
  // 商品ごとの広告費。楽天RPPの商品ページに SKU ごとの別商品があるときは、楽天の売上の比率で按分する
  const prodAds = await productAdTotals(db, caseId, from, to);

  // 商品別も、Amazon の入金明細は計上日の合計で引く（手数料・返品・値引き・ポイント）
  const finP = await amazonFinance(db, caseId, from, to, prodBasis);
  type PRow = CaseSummary["products"][number];
  const byId = new Map<string, PRow>();
  for (const r of prodRows) {
    const id = String(r.id), mall = String(r.mall);
    const rev = n(r.revenue), units = n(r.units);
    const fin = mall === "amazon" ? finCost(finP.byProduct.get(id)) : 0;
    const gross = r.unit_cost == null ? null : rev - n(r.unit_cost) * units - n(r.fees) - fin;
    const ad = prodAds.get(id)?.byMall?.[mall];
    const p = byId.get(id) ?? { sku: String(r.sku), name: String(r.name), units: 0, revenue: 0, gross: r.unit_cost == null ? null : 0,
      grossRate: null, adCost: prodAds.has(id) ? prodAds.get(id)!.cost : null, costManual: n(r.manual) === 1, byMall: {} };
    p.units += units; p.revenue += rev;
    if (p.gross != null && gross != null) p.gross += gross;
    p.byMall[mall] = { units, revenue: rev, gross, grossRate: gross == null || !rev ? null : round1((gross / rev) * 100), adCost: ad ? ad.cost : null };
    byId.set(id, p);
  }
  const products = [...byId.values()].map((p) => ({ ...p, grossRate: p.gross == null || !p.revenue ? null : round1((p.gross / p.revenue) * 100) }))
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, Math.min(200, opts.productLimit ?? 15));

  /* 在庫（期間に関係なく最新） */
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
    list.find((x) => x.key === k)?.effective ?? d;
  const rate = (list: { isFeeRate: boolean; effective: number }[]) =>
    round1(list.filter((x) => x.isFeeRate).reduce((t, x) => t + x.effective, 0));
  const rakutenFeeFromDefault = sRak.caseMall.filter((x) => x.isFeeRate).every((x) => x.from === "既定");
  const targetMargin = val(sAmz.case, "target_margin", 30);
  const adMargin = val(sAmz.case, "ad_profit_margin", 10);

  /* 広告の改善提案 */
  // モール間の配分は、両方のモールを同じ期間で比べる必要があるので楽天に合わせて直近60日（直近3日を除く）で固定。
  // Amazon のキャンペーン予算の入れ替えが配分（楽天からの移し・月の広告予算）を使うので先に作る
  const aw = adviceWindows();
  const allocation = await buildAllocation(db, caseId, aw.rakuten.from, aw.rakuten.to);
  const adv = await buildAdAdvice(db, caseId, adMargin, { allocation });

  /* 気をつけること */
  const warnings: string[] = [];
  const manual = await db.prepare(
    `SELECT COUNT(*) AS c FROM products p WHERE p.case_id = ? AND p.status = 'active'
       AND (SELECT needs_manual FROM cost_history h WHERE h.product_id = p.id
             ORDER BY h.effective_from DESC LIMIT 1) = 1`
  ).bind(caseId).first<{ c: number }>();
  if (manual?.c) warnings.push(`原価が未確定（要手計算）の商品が ${manual.c} 件あります。その商品の売上は粗利の計算から外しています`);

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
    // 楽天の請求明細は2〜3か月遅れで届く。どの月までが実額かを出す
    const done = await latestCompleteMonth(db, caseId, "rakuten");
    warnings.push(done
      ? `楽天の手数料は ${done} 分までが請求明細の実額です。それより後は料率からの概算です`
      : "楽天の手数料は、請求明細がそろった月がまだ無いため、すべて料率からの概算です");
  }
  for (const f of freshness) {
    if (f.latest == null) warnings.push(`${f.label} のデータがまだありません`);
    else if ((f.daysAgo ?? 0) > 3) warnings.push(`${f.label} の最新データが ${f.daysAgo} 日前（${f.latest}）で止まっています`);
  }
  if (!prevComplete && per.preset !== "all")
    warnings.push(`比べる直前の期間（${prevFrom}〜${prevTo}）の売上データが${n(prevAgg?.n) ? "一部しか無い" : "無い"}ため、前期間比は出していません`);

  const events = await listEvents(db, caseId, from, to);
  const [external, repeat, keywords] = await Promise.all([externalAdCost(db, caseId, from, to), repeatSummary(db, caseId, from, to), keywordTodoData(db, caseId)]);
  const base: Omit<CaseSummary, "todo" | "doneThisMonth"> = {
    allocation, repeat, keywords,
    caseId, caseName: c.name,
    period: { from, to, days, preset: per.preset },
    prev: { from: prevFrom, to: prevTo },
    dataRange: await dataRange(db, caseId),
    generatedAt: new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 16).replace("T", " "),
    malls,
    sales: {
      total: { revenue, units, sessions: sessions || null },
      prev: { revenue: prevRevenue, units: n(prevAgg?.units) },
      changeRate: prevComplete && prevRevenue ? round1(((revenue - prevRevenue) / prevRevenue) * 100) : null,
      perDay: Math.round(revenue / days),
      last: { date: to, revenue: n(lastDay?.revenue), units: n(lastDay?.units) },
      trend: trend.map((t) => ({ date: t.date, revenue: n(t.revenue), units: n(t.units), amazon: n(t.amazon), rakuten: n(t.rakuten) })),
    },
    pl,
    ads: {
      totals,
      tacos: revenue ? round1((adCost / revenue) * 100) : null,
      profitAfterAds: pl.revenue ? pl.gross - adCost - external.total : null,
      external,
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
    advice: {
      counts: {
        up: adv.bids.filter((b) => b.action === "up").length,
        down: adv.bids.filter((b) => b.action === "down").length,
        pause: adv.bids.filter((b) => b.action === "pause").length,
        negatives: adv.negatives.length, harvest: adv.harvest.length, budgets: adv.budgets.filter((b) => b.action === "up").length, watching: adv.watching.length,
      },
      impact: adv.impact,
      windows: adv.windows,
      losing: adv.campaigns.filter((c) => c.breakEven != null && c.roas != null && c.roas < c.breakEven && c.cost >= 3000).slice(0, 5),
      topBids: adv.bids.slice(0, 10), topNegatives: adv.negatives.slice(0, 10), topHarvest: adv.harvest.slice(0, 10),
    },
    products, inventory, freshness, warnings, events,
    settings: {
      targetMargin, adMargin,
      stockAlertDays: val(sAmz.case, "stock_alert_days", 14),
      // 在庫アラートの通知をオフにした案件は、在庫を在庫タブだけで見る（ダッシュボードの要対応・日次サマリ・週次レポートには出さない）
      stockAlert: await notifyEnabled(db, caseId, "stock_alert"),
      rakutenFeeRate: malls.includes("rakuten") ? rate(sRak.caseMall) : null,
      amazonFeeRate: malls.includes("amazon") ? rate(sAmz.caseMall) : null,
      rakutenFeeFromDefault,
    },
  };
  // 同じ鍵が2つ出ないようにする（在庫の「注意」と「欠品間近」が同じ商品で重なるなど）
  const seen = new Set<string>();
  const todos = buildTodo(base)
    .filter((t) => base.settings.stockAlert || t.area !== "在庫")
    .filter((t) => (seen.has(t.key) ? false : (seen.add(t.key), true)));
  const todo = await applyTodoStatus(db, caseId, todos, { write: opts.trackTodos !== false });
  return { ...base, todo, doneThisMonth: await doneInMonth(db, caseId, today.slice(0, 7)) };
}
