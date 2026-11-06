/**
 * Amazon と楽天の間の広告費の配分の提案、と月次推移
 *
 * 配分の考え方（広告費1円あたりの利益で比べる）
 *   広告1円あたりの利益 ＝ ROAS × 広告費前の粗利率 − 1
 *   - プラス＝その広告は利益を生んでいる、マイナス＝広告で赤字（ROAS が損益分岐を下回る）
 *   - 2つのモールで差があれば、低い方から高い方へ少し（月の広告費の最大20%）移す提案を出す
 *   - 赤字のモールは、移し先が無くても減らす提案を出す
 * 注意
 *   - ここで使う ROAS は平均。広告費を増やすと効率は下がる（逓減）ので、一度に大きく動かさない前提で20%までにしている
 *   - 帰属期間が違う（楽天RPP 30日／Amazon SP 7日・SB 14日）。楽天の ROAS は Amazon より高く出やすいので、
 *     楽天へ移す提案には必ずその注意を添える
 *   - Amazon でキャンペーンが予算切れ（予算内の時間が100%未満）になっていれば、増やしたときに伸びる余地がある印として使う
 */

import { periodSummary, adTotals } from "./caseSummary";

export interface MallAdEfficiency {
  mall: string;
  adCost: number;
  adSales: number;
  roas: number | null;
  /** 広告費前の粗利率（0〜1）。原価が分からない売上は除いた値 */
  grossMargin: number | null;
  breakEvenRoas: number | null;
  /** 広告1円あたりの利益（円） */
  profitPerYen: number | null;
  /** 広告で生んだ利益（広告経由売上×粗利率 − 広告費） */
  adProfit: number | null;
  /** 予算切れのキャンペーンがある（Amazon のみ分かる） */
  budgetLimited: boolean | null;
  attributionDays: string;
}

export interface Allocation {
  from: string; to: string; days: number;
  malls: MallAdEfficiency[];
  /** 30日あたりに直した提案 */
  proposal: null | {
    action: "shift" | "cut";
    fromMall: string; toMall: string | null;
    amount30d: number;          // 30日あたりに動かす広告費
    expectedProfit30d: number;  // 平均の効率が続いた場合の利益の増え方（上限の目安）
    reason: string;
    cautions: string[];
  };
}

const MALL_JA: Record<string, string> = { amazon: "Amazon", rakuten: "楽天" };
const yen = (v: number) => `¥${Math.round(v).toLocaleString("ja-JP")}`;

export async function buildAllocation(db: D1Database, caseId: string, from: string, to: string): Promise<Allocation> {
  const days = Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1;
  const [pl, totals] = await Promise.all([periodSummary(db, caseId, from, to), adTotals(db, caseId, from, to)]);
  const cov = await db.prepare(
    `SELECT mall, MIN(cov) AS minCov FROM (
       SELECT mall, campaign, AVG(budget_coverage) AS cov FROM daily_ads
        WHERE case_id = ? AND level = 'campaign' AND date BETWEEN ? AND ? AND budget_coverage IS NOT NULL
        GROUP BY mall, campaign) GROUP BY mall`
  ).bind(caseId, from, to).all<{ mall: string; minCov: number | null }>();

  const malls: MallAdEfficiency[] = totals.map((t) => {
    const m = pl.byMall.find((x) => x.mall === t.mall);
    const covered = m ? m.revenue - m.revenueWithoutCost : 0;
    const gm = m && covered > 0 ? m.gross / covered : null;
    const roas = t.cost > 0 ? t.sales / t.cost : null;
    const ppy = roas != null && gm != null ? roas * gm - 1 : null;
    const c = cov.results.find((x) => x.mall === t.mall);
    return {
      mall: t.mall, adCost: t.cost, adSales: t.sales,
      roas: roas == null ? null : Math.round(roas * 100) / 100,
      grossMargin: gm == null ? null : Math.round(gm * 1000) / 1000,
      breakEvenRoas: gm != null && gm > 0 ? Math.round((1 / gm) * 100) / 100 : null,
      profitPerYen: ppy == null ? null : Math.round(ppy * 100) / 100,
      adProfit: gm != null ? Math.round(t.sales * gm - t.cost) : null,
      budgetLimited: c?.minCov == null ? null : c.minCov < 95,
      attributionDays: t.attribution,
    };
  });

  return { from, to, days, malls, proposal: propose(malls, days) };
}

function propose(malls: MallAdEfficiency[], days: number): Allocation["proposal"] {
  const ok = malls.filter((m) => m.adCost > 0 && m.profitPerYen != null);
  if (!ok.length) return null;
  const per30 = (v: number) => (v / days) * 30;
  const cautions: string[] = [
    "ROAS は平均の値です。広告費を増やすと効率は下がるので、移すのは一度に20%までにして、2〜4週間ようすを見てください",
  ];

  if (ok.length === 1) {
    const m = ok[0];
    if ((m.profitPerYen ?? 0) >= 0) return null;
    const amount = Math.round(per30(m.adCost) * 0.2);
    return { action: "cut", fromMall: m.mall, toMall: null, amount30d: amount,
      expectedProfit30d: Math.round(amount * -(m.profitPerYen ?? 0)),
      reason: `${MALL_JA[m.mall]}の広告は ROAS ${m.roas}（損益分岐 ${m.breakEvenRoas}）で、広告1円あたり ${Math.abs(m.profitPerYen ?? 0)}円の赤字です。赤字のキャンペーン・キーワードから広告費を減らしてください`,
      cautions };
  }

  const [hi, lo] = [...ok].sort((a, b) => (b.profitPerYen ?? 0) - (a.profitPerYen ?? 0));
  const gap = (hi.profitPerYen ?? 0) - (lo.profitPerYen ?? 0);
  if (gap < 0.1 && (lo.profitPerYen ?? 0) >= 0) return null;   // 差が小さく、どちらも黒字なら動かさない

  const loCost30 = per30(lo.adCost);
  const amount = Math.round(loCost30 * 0.2);
  if (hi.mall === "rakuten") cautions.push("楽天RPPの売上は30日以内の購入まで数えるので、Amazon（SP 7日・SB 14日）より ROAS が高く出やすい点を割り引いて判断してください");
  if (lo.mall === "rakuten") cautions.push("楽天RPPは直近の売上があとから伸びます（30日の帰属）。直近の期間で判断すると楽天を低く見積もりやすい点に注意してください");

  // 移し先が赤字なら、移さずに減らすだけ
  if ((hi.profitPerYen ?? 0) < 0) {
    return { action: "cut", fromMall: lo.mall, toMall: null, amount30d: amount,
      expectedProfit30d: Math.round(amount * -(lo.profitPerYen ?? 0)),
      reason: `どちらのモールの広告も赤字です（${MALL_JA[hi.mall]} ROAS ${hi.roas}／損益分岐 ${hi.breakEvenRoas}、${MALL_JA[lo.mall]} ROAS ${lo.roas}／損益分岐 ${lo.breakEvenRoas}）。より赤字の大きい${MALL_JA[lo.mall]}から先に減らしてください`,
      cautions };
  }

  const headroom = hi.budgetLimited ? `${MALL_JA[hi.mall]}は予算切れのキャンペーンがあり、増やすと伸びる余地があります。` : "";
  return {
    action: "shift", fromMall: lo.mall, toMall: hi.mall, amount30d: amount,
    expectedProfit30d: Math.round(amount * gap),
    reason: `広告1円あたりの利益は ${MALL_JA[hi.mall]} ${hi.profitPerYen}円、${MALL_JA[lo.mall]} ${lo.profitPerYen}円です。` +
      `${MALL_JA[lo.mall]}の広告費のうち30日あたり ${yen(amount)}（約20%）を、${MALL_JA[hi.mall]}へ移すと利益が増える見込みです。${headroom}` +
      `${MALL_JA[lo.mall]}は ROAS の低いキャンペーン・キーワードから削り、${MALL_JA[hi.mall]}は成果の出ているキャンペーンの予算・入札を上げてください`,
    cautions,
  };
}

/* ───────── 月次推移 ───────── */

export interface MonthRow {
  month: string;
  partial: boolean;     // 今月（途中）
  revenue: number; gross: number; adCost: number; adSales: number; profitAfterAds: number;
  byMall: Record<string, { revenue: number; gross: number; adCost: number; adSales: number }>;
}

/** 直近 n か月（今月を含む）の月次推移。月ごとに期間の損益と同じ計算をする */
export async function monthlyTrend(db: D1Database, caseId: string, months = 12): Promise<MonthRow[]> {
  const now = new Date(Date.now() + 9 * 3600000);
  const yesterday = new Date(now.getTime() - 86400000).toISOString().slice(0, 10);
  const out: MonthRow[] = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const month = d.toISOString().slice(0, 7);
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
    const from = `${month}-01`, to = last < yesterday ? last : yesterday;
    if (from > to) continue;
    const [pl, ads] = await Promise.all([periodSummary(db, caseId, from, to), adTotals(db, caseId, from, to)]);
    const byMall: MonthRow["byMall"] = {};
    for (const m of pl.byMall) byMall[m.mall] = { revenue: m.revenue, gross: m.gross, adCost: 0, adSales: 0 };
    for (const a of ads) {
      byMall[a.mall] ??= { revenue: 0, gross: 0, adCost: 0, adSales: 0 };
      byMall[a.mall].adCost = a.cost; byMall[a.mall].adSales = a.sales;
    }
    const adCost = ads.reduce((n, a) => n + a.cost, 0), adSales = ads.reduce((n, a) => n + a.sales, 0);
    if (!pl.revenue && !adCost) continue;      // データの無い月は出さない
    out.push({ month, partial: to !== last, revenue: pl.revenue, gross: pl.gross, adCost, adSales,
      profitAfterAds: pl.gross - adCost, byMall });
  }
  return out;
}
