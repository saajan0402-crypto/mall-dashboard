/**
 * 広告の改善提案（入札の上げ下げ・除外キーワード・追加キーワード・予算）
 *
 * 考え方
 *   - 目標は「広告費を引いたあとに、設定の『広告費を引いた後の目標利益率』が残ること」。
 *     目標ACoS ＝ 広告費を引く前の粗利率 − 広告後の目標利益率（商品マスタの広告方針で調整）
 *     ※「目標粗利率」は広告費を引く前の基準なので、ここでは使わない
 *       利益重視：上の式そのまま／シェア獲得：損益分岐まで使ってよい／育成中：損益分岐の1.3倍まで許す
 *   - 適正な入札 ＝ 今の入札 ×（クリック単価の上限 ÷ 今のクリック単価）
 *       クリック単価の上限 ＝ 1クリックあたりの売上 × 目標ACoS
 *   - 1回の変更は −40%〜＋30% まで。大きく動かすと結果の読み取りができなくなるため
 *   - データが少ないもの（クリック10未満）は判断しない
 *
 * ここでは提案を出すだけ。入札の変更は担当者が手で行う（モールへ書き込む経路は作らない）。
 */

import { amazonFinance, finCost, coveredSql, feeBasis } from "./amazonFin";
import { rakutenPages, rakutenRevenueByProduct, shares } from "./adProducts";
import { periodSummary } from "./caseSummary";
import { isoWeek } from "./todos";

const n = (v: unknown) => Number(v ?? 0);
const round2 = (v: number) => Math.round(v * 100) / 100;
const yen = (v: number) => "¥" + Math.round(v).toLocaleString("ja-JP");
const pct = (v: number) => `${Math.round(v * 1000) / 10}%`;

/** モールごとの最低入札額 */
// 楽天RPP のキーワードCPC は40円から（商品CPC は10円からだが、ここで提案するのはキーワード単位）
const MIN_BID: Record<string, number> = { amazon: 2, rakuten: 40 };
const MIN_CLICKS = 10;
const UP_MAX = 1.3, DOWN_MAX = 0.6;

export type Policy = "profit" | "share" | "nurture";
const POLICY_JA: Record<Policy, string> = { profit: "利益重視", share: "シェア獲得", nurture: "育成中" };

export interface Target {
  /** 広告費を引く前の粗利率（0〜1） */
  gm: number;
  gmFrom: "商品" | "モール" | "仮定";
  policy: Policy;
  acos: number;
  roas: number;
  /** 目標粗利率を残せない（粗利率が低すぎる）とき true */
  squeezed: boolean;
}

export interface BidAdvice {
  /** 対応済み・今はしない を記録する鍵（入札は週ごとに出直すので週を含む） */
  key: string;
  mall: string; adType: string | null; campaign: string; adGroup: string; keyword: string; matchType: string;
  /** 楽天：商品管理番号（RPP の一括登録に使う） */
  externalId: string | null;
  product: { sku: string; name: string } | null;
  clicks: number; cost: number; orders: number; sales: number;
  cpc: number; cvr: number; roas: number | null;
  currentBid: number | null; suggestedCpc: number | null;
  target: Target;
  action: "up" | "down" | "pause";
  suggestedBid: number;
  /** 入札がわからないときは平均クリック単価を基準にする */
  basis: "入札" | "平均クリック単価";
  reason: string;
}

export interface NegativeAdvice {
  key: string;
  mall: string; adType: string; campaign: string; adGroup: string; searchTerm: string; targeting: string;
  kind: "keyword" | "product";
  clicks: number; cost: number; orders: number; sales: number; roas: number | null;
  reason: string;
}

export interface HarvestAdvice {
  key: string;
  mall: string; adType: string; campaign: string; adGroup: string; searchTerm: string;
  kind: "keyword" | "product";
  clicks: number; cost: number; orders: number; sales: number; roas: number; cpc: number;
  suggestedBid: number; target: Target; reason: string;
}

export interface BudgetAdvice {
  key: string;
  mall: string; adType: string | null; campaign: string;
  cost: number; sales: number; roas: number; coverage: number; budget: number | null;
  suggestedBudget: number | null; reason: string;
}

/** 提案に使う期間。ヘッダーの期間に関係なく固定する（担当者ごとに提案が変わらないように）
 *   Amazon：直近30日／楽天：直近60日（RPP は30日さかのぼって売上を数えるため長めに）。どちらも直近3日は除く（遅れて入る広告経由の売上を待つ）
 */
export interface AdviceWindows { amazon: { from: string; to: string; days: number }; rakuten: { from: string; to: string; days: number } }
const jstDay = (n: number) => new Date(Date.now() + 9 * 3600000 - n * 86400000).toISOString().slice(0, 10);
const lk = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
export function adviceWindows(): AdviceWindows {
  const to = jstDay(3);
  return { amazon: { from: jstDay(32), to, days: 30 }, rakuten: { from: jstDay(62), to, days: 60 } };
}
/** 入札を変えてからこの日数の間は提案を出さず「様子見」にする（変更の結果が出る前に同じ提案を重ねないため） */
const SETTLE_DAYS = 14;

export interface WatchingBid {
  mall: string; campaign: string; adGroup: string; keyword: string; matchType: string;
  currentBid: number | null; changedOn: string; until: string;
}
export interface CampaignResult { mall: string; adType: string | null; campaign: string; cost: number; sales: number; roas: number | null; breakEven: number | null }

export interface AdAdvice {
  from: string; to: string;
  windows: AdviceWindows;
  /** 入札を変えて14日未満のため提案を止めているキーワード */
  watching: WatchingBid[];
  /** キャンペーンごとの結果（提案と同じ期間）。要対応の「広告で赤字」に使う */
  campaigns: CampaignResult[];
  assumptions: string[];
  targets: Array<{ label: string; gm: number | null; acos: number | null; roas: number | null }>;
  bids: BidAdvice[];
  negatives: NegativeAdvice[];
  harvest: HarvestAdvice[];
  budgets: BudgetAdvice[];
  /** 提案どおりにしたとき浮く／増える見込みの広告費（期間あたり） */
  impact: { wastedCost: number; bidDownCost: number };
}

/** 検索語が ASIN（商品ターゲティング）かどうか */
const isAsin = (s: string) => /^b0[0-9a-z]{8}$/i.test(s.trim());
const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

export async function buildAdAdvice(db: D1Database, caseId: string, adMarginPct: number): Promise<AdAdvice> {
  const tm = adMarginPct / 100;
  const W = adviceWindows();
  // 粗利率など商品の数字は長いほう（楽天の60日）で見る。広告の実績はモールごとの期間で見る
  const from = W.rakuten.from, to = W.amazon.to;
  const A = W.amazon, R = W.rakuten;
  /** SQL：モールごとの期間（別名 a の daily_ads 用） */
  const mallWin = (alias: string) => `((${alias}mall = 'rakuten' AND ${alias}date BETWEEN '${R.from}' AND '${R.to}') OR (${alias}mall <> 'rakuten' AND ${alias}date BETWEEN '${A.from}' AND '${A.to}'))`;

  /* 粗利率：モール別と商品別 */
  const pl = await periodSummary(db, caseId, from, to);
  const mallGm = new Map<string, number>();
  for (const m of pl.byMall) {
    const covered = m.revenue - m.revenueWithoutCost;
    if (covered > 0 && m.gross > 0) mallGm.set(m.mall, m.gross / covered);
  }
  const basis = await feeBasis(db);
  const { results: prodRows } = await db.prepare(
    `SELECT p.id, p.sku, p.name, COALESCE(p.ad_policy, 'profit') AS policy,
            SUM(s.units) AS units, SUM(s.revenue) AS revenue,
            SUM(CASE WHEN ${coveredSql(basis)} THEN 0 ELSE COALESCE(s.fee_actual, s.fee_est, 0) + COALESCE(s.returns, 0) + COALESCE(s.discounts, 0) END) AS fees,
            (SELECT unit_cost FROM cost_history h WHERE h.product_id = p.id ORDER BY h.effective_from DESC LIMIT 1) AS uc
       FROM products p LEFT JOIN daily_sales s ON s.product_id = p.id AND s.date BETWEEN ? AND ?
      WHERE p.case_id = ? GROUP BY p.id`
  ).bind(from, to, caseId).all<Record<string, string | number | null>>();
  const products = new Map<string, { sku: string; name: string; policy: Policy; gm: number | null; price: number | null }>();
  const fin = await amazonFinance(db, caseId, from, to, basis);
  for (const p of prodRows) {
    const rev = n(p.revenue), units = n(p.units);
    const gm = p.uc != null && rev > 0 ? (rev - n(p.uc) * units - n(p.fees) - finCost(fin.byProduct.get(String(p.id)))) / rev : null;
    const policy = (["profit", "share", "nurture"].includes(String(p.policy)) ? p.policy : "profit") as Policy;
    products.set(String(p.id), { sku: String(p.sku), name: String(p.name), policy, gm: gm != null && gm > 0 ? gm : null,
      price: units > 0 ? rev / units : null });
  }

  const targetOf = (mall: string, productId: string | null): Target => {
    const p = productId ? products.get(productId) : undefined;
    let gm = p?.gm ?? null, gmFrom: Target["gmFrom"] = "商品";
    if (gm == null) { gm = mallGm.get(mall) ?? null; gmFrom = "モール"; }
    if (gm == null) { gm = 0.3; gmFrom = "仮定"; }
    const policy = p?.policy ?? "profit";
    let acos = policy === "share" ? gm : policy === "nurture" ? gm * 1.3 : gm - tm;
    const squeezed = policy === "profit" && acos < gm * 0.3;
    if (squeezed) acos = gm * 0.3;
    return { gm, gmFrom, policy, acos, roas: round2(1 / acos), squeezed };
  };

  /* Amazon：キャンペーン×広告グループ → いちばん広告費の多い商品 */
  const { results: groupRows } = await db.prepare(
    `SELECT campaign, ad_group, product_id, SUM(cost) AS cost FROM daily_ads
      WHERE case_id = ? AND mall = 'amazon' AND level = 'product' AND date BETWEEN ? AND ? AND product_id IS NOT NULL
      GROUP BY campaign, ad_group, product_id ORDER BY cost DESC`
  ).bind(caseId, A.from, A.to).all<{ campaign: string; ad_group: string; product_id: string }>();
  const groupProduct = new Map<string, string>();
  const campaignProduct = new Map<string, string>();
  for (const g of groupRows) {
    const k = `${g.campaign}\u0000${g.ad_group}`;
    if (!groupProduct.has(k)) groupProduct.set(k, g.product_id);
    if (!campaignProduct.has(g.campaign)) campaignProduct.set(g.campaign, g.product_id);
  }
  const productFor = (mall: string, campaign: string, adGroup: string, direct: string | null) =>
    direct ?? (mall === "amazon" ? groupProduct.get(`${campaign}\u0000${adGroup}`) ?? campaignProduct.get(campaign) ?? null : null);

  // 楽天RPP：1つの商品ページ（商品管理番号）に SKU ごとの別商品があるときは、
  // 楽天の売上の比率で重みをつけた粗利率で目標を決める（1つの商品の粗利率だけで決めない）
  const pages = await rakutenPages(db, caseId);
  const rakRevenue = await rakutenRevenueByProduct(db, caseId, R.from, R.to);
  const pageTarget = (num: string | null): Target | null => {
    const pids = num ? pages.get(num) : undefined;
    if (!pids || pids.length < 2) return null;
    let gm = 0, w = 0, pol: Policy = "profit";
    for (const [pid, k] of shares(pids, rakRevenue)) {
      const p = products.get(pid);
      if (p?.gm != null) { gm += p.gm * k; w += k; if (k >= 0.5) pol = p.policy; }
    }
    if (!w) return null;
    gm /= w;
    let acos = pol === "share" ? gm : pol === "nurture" ? gm * 1.3 : gm - tm;
    const squeezed = pol === "profit" && acos < gm * 0.3;
    if (squeezed) acos = gm * 0.3;
    return { gm, gmFrom: "商品", policy: pol, acos, roas: round2(1 / acos), squeezed };
  };

  /* ───── 入札の見直し（キーワード・ターゲット別） ───── */
  const { results: kwRows } = await db.prepare(
    `SELECT mall, ad_type, campaign, ad_group, keyword, match_type, MAX(product_id) AS product_id, MAX(external_id) AS external_id,
            SUM(clicks) AS clicks, SUM(cost) AS cost, SUM(orders) AS orders, SUM(sales) AS sales,
            (SELECT bid FROM daily_ads b WHERE b.case_id = a.case_id AND b.mall = a.mall AND b.level = 'keyword'
               AND b.campaign = a.campaign AND b.ad_group = a.ad_group AND b.keyword = a.keyword
               AND b.match_type = a.match_type AND b.bid IS NOT NULL ORDER BY b.date DESC LIMIT 1) AS bid,
            (SELECT suggested_cpc FROM daily_ads b WHERE b.case_id = a.case_id AND b.mall = a.mall AND b.level = 'keyword'
               AND b.campaign = a.campaign AND b.ad_group = a.ad_group AND b.keyword = a.keyword
               AND b.suggested_cpc IS NOT NULL ORDER BY b.date DESC LIMIT 1) AS suggested,
            -- 今の入札と違う入札だった最後の日（＝その翌日に入札を変えた）
            (SELECT MAX(c.date) FROM daily_ads c WHERE c.case_id = a.case_id AND c.mall = a.mall AND c.level = 'keyword'
               AND c.campaign = a.campaign AND c.ad_group = a.ad_group AND c.keyword = a.keyword AND c.match_type = a.match_type
               AND c.bid IS NOT NULL AND c.bid <> (SELECT b.bid FROM daily_ads b WHERE b.case_id = a.case_id AND b.mall = a.mall AND b.level = 'keyword'
                 AND b.campaign = a.campaign AND b.ad_group = a.ad_group AND b.keyword = a.keyword
                 AND b.match_type = a.match_type AND b.bid IS NOT NULL ORDER BY b.date DESC LIMIT 1)) AS last_other_bid
       FROM daily_ads a
      WHERE a.case_id = ? AND a.level = 'keyword' AND ${mallWin("a.")}
      GROUP BY mall, ad_type, campaign, ad_group, keyword, match_type
     HAVING SUM(clicks) >= ?`
  ).bind(caseId, MIN_CLICKS).all<Record<string, string | number | null>>();

  const bids: BidAdvice[] = [];
  const watching: WatchingBid[] = [];
  const settleFrom = jstDay(SETTLE_DAYS);
  const dayAfter = (d: string, k = 1) => new Date(Date.parse(`${d}T00:00:00Z`) + k * 86400000).toISOString().slice(0, 10);
  const exactKeywords = new Set<string>();
  for (const r of kwRows) {
    const mall = String(r.mall), campaign = String(r.campaign), adGroup = String(r.ad_group);
    const keyword = String(r.keyword), matchType = String(r.match_type);
    if (/exact/i.test(matchType)) exactKeywords.add(`${mall}\u0000${norm(keyword)}`);
    const clicks = n(r.clicks), cost = n(r.cost), orders = n(r.orders), sales = n(r.sales);
    if (cost <= 0) continue;
    // 入札を変えてから14日たっていなければ様子見（変更前の実績が混ざっていて、同じ提案を重ねてしまうため）
    if (r.last_other_bid != null && String(r.last_other_bid) >= settleFrom) {
      const changedOn = dayAfter(String(r.last_other_bid));
      watching.push({ mall, campaign, adGroup, keyword, matchType, currentBid: r.bid == null ? null : n(r.bid),
        changedOn, until: dayAfter(changedOn, SETTLE_DAYS) });
      continue;
    }
    const shared = mall === "rakuten" ? pageTarget(r.external_id == null ? null : String(r.external_id)) : null;
    const pid = shared ? null : productFor(mall, campaign, adGroup, r.product_id == null ? null : String(r.product_id));
    const prod = pid ? products.get(pid) : undefined;
    // 楽天の1つの商品ページに SKU ごとの別商品があるときは、紐づく商品をすべて並べる
    const pagePids = mall === "rakuten" && r.external_id != null ? pages.get(String(r.external_id)) ?? [] : [];
    const pageProds = pagePids.map((x) => products.get(x)).filter((x): x is NonNullable<typeof x> => !!x);
    const target = shared ?? targetOf(mall, pid);
    const cpc = cost / clicks;
    const currentBid = r.bid == null ? null : n(r.bid);
    const base = currentBid ?? cpc;
    const minBid = MIN_BID[mall] ?? 2;
    const roas = cost > 0 ? sales / cost : null;
    // 1注文あたりに使ってよい広告費。単価は商品の平均販売価格、無ければこの広告の客単価
    const price = (orders > 0 ? sales / orders : null) ?? prod?.price ?? null;
    const allowedCpa = price != null ? price * target.acos : null;

    let action: BidAdvice["action"] | null = null, ratio = 1, reason = "";
    if (orders === 0) {
      if (allowedCpa != null && cost >= allowedCpa * 1.5) {
        action = "pause"; ratio = 0.5;
        reason = `${clicks}クリック・${yen(cost)}使って注文0。1注文に使ってよい額（${yen(allowedCpa)}）の${Math.round(cost / allowedCpa * 10) / 10}倍を超えています`;
      } else if ((allowedCpa != null && cost >= allowedCpa * 0.75) || (allowedCpa == null && clicks >= 30)) {
        action = "down"; ratio = 0.7;
        reason = `${clicks}クリック・${yen(cost)}使って注文0`;
      }
    } else {
      const idealCpc = (sales / clicks) * target.acos;
      ratio = idealCpc / cpc;
      const lowConfidence = orders === 1 && clicks < 20;
      if (lowConfidence && (roas ?? 0) >= target.roas * 0.5) continue;   // 1件だけでは判断しない
      if (ratio >= 1.15) {
        action = "up";
        reason = `ROAS ${round2(roas ?? 0)}（目標 ${target.roas}）。クリック単価 ${yen(cpc)} に対して、${yen(idealCpc)} まで払っても目標を守れます`;
      } else if (ratio <= 0.85) {
        action = "down";
        reason = `ROAS ${round2(roas ?? 0)}（目標 ${target.roas}）。目標を守れるクリック単価は ${yen(idealCpc)}（今は ${yen(cpc)}）`;
      }
    }
    if (!action) continue;
    const clamped = Math.min(UP_MAX, Math.max(action === "pause" ? 0.5 : DOWN_MAX, ratio));
    const suggestedBid = Math.max(minBid, Math.round(base * clamped));
    if (suggestedBid === Math.round(base)) continue;
    bids.push({
      key: `adv:bid:${mall}:${campaign}:${adGroup}:${lk(keyword)}:${matchType}:${isoWeek()}`,
      mall, adType: r.ad_type == null ? null : String(r.ad_type), campaign, adGroup, keyword, matchType,
      externalId: r.external_id == null || r.external_id === "" ? null : String(r.external_id),
      product: prod ? { sku: prod.sku, name: prod.name }
        : pageProds.length ? { sku: pageProds.map((x) => x.sku).join(" / "), name: pageProds.map((x) => x.name).join(" / ") } : null,
      clicks, cost, orders, sales, cpc: Math.round(cpc), cvr: round2((orders / clicks) * 100),
      roas: roas == null ? null : round2(roas), currentBid, suggestedCpc: r.suggested == null ? null : n(r.suggested),
      target, action, suggestedBid, basis: currentBid == null ? "平均クリック単価" : "入札",
      reason: reason + (mall === "rakuten" && action !== "up" ? "。楽天は30日帰属のため直近分は売上があとから増える可能性あり" : ""),
    });
  }
  const actRank = { pause: 0, down: 1, up: 2 };
  bids.sort((a, b) => actRank[a.action] - actRank[b.action] || b.cost - a.cost);

  /* ───── 検索語：除外候補と追加候補（Amazon） ───── */
  const { results: stRows } = await db.prepare(
    `SELECT mall, ad_type, campaign, ad_group, search_term, MAX(targeting) AS targeting, MAX(match_type) AS match_type,
            SUM(clicks) AS clicks, SUM(cost) AS cost, SUM(orders) AS orders, SUM(sales) AS sales
       FROM daily_search_terms WHERE case_id = ? AND date BETWEEN ? AND ?
      GROUP BY mall, ad_type, campaign, ad_group, search_term HAVING SUM(clicks) >= 3`
  ).bind(caseId, A.from, A.to).all<Record<string, string | number | null>>();

  const negatives: NegativeAdvice[] = [];
  const harvest: HarvestAdvice[] = [];
  const harvested = new Set<string>();
  for (const r of stRows) {
    const mall = String(r.mall), adType = String(r.ad_type), campaign = String(r.campaign), adGroup = String(r.ad_group);
    const term = String(r.search_term), targeting = String(r.targeting ?? ""), matchType = String(r.match_type ?? "");
    const clicks = n(r.clicks), cost = n(r.cost), orders = n(r.orders), sales = n(r.sales);
    const pid = productFor(mall, campaign, adGroup, null);
    const prod = pid ? products.get(pid) : undefined;
    const target = targetOf(mall, pid);
    const roas = cost > 0 ? sales / cost : null;
    const kind = isAsin(term) ? "product" : "keyword";
    // 完全一致で狙っている語そのものなら、除外ではなく入札で調整する（上の入札の見直しに出る）
    const isOwnExact = /exact/i.test(matchType) && norm(term) === norm(targeting);

    if (orders >= 2 && roas != null && roas >= target.roas && !isOwnExact && !exactKeywords.has(`${mall}\u0000${norm(term)}`)) {
      const key = `${mall}\u0000${norm(term)}`;
      if (!harvested.has(key)) {
        harvested.add(key);
        const cpc = cost / Math.max(1, clicks);
        harvest.push({
          key: `adv:harv:${mall}:${lk(term)}`,
          mall, adType, campaign, adGroup, searchTerm: term, kind, clicks, cost, orders, sales,
          roas: round2(roas), cpc: Math.round(cpc),
          suggestedBid: Math.max(MIN_BID[mall] ?? 2, Math.round(cpc * Math.min(UP_MAX, Math.max(1, roas / target.roas)))),
          target,
          reason: `${orders}件・ROAS ${round2(roas)}（目標 ${target.roas}）。${kind === "product" ? "商品ターゲティング" : "完全一致のキーワード"}として独立させると入札を細かく調整できます`,
        });
      }
      continue;
    }
    if (isOwnExact || cost <= 0) continue;
    const price = prod?.price ?? (orders > 0 ? sales / orders : null);
    const allowedCpa = price != null ? price * target.acos : null;
    if (orders === 0 && clicks >= 5 && ((allowedCpa != null && cost >= allowedCpa) || clicks >= 15)) {
      negatives.push({
        key: `adv:neg:${mall}:${campaign}:${adGroup}:${lk(term)}`,
        mall, adType, campaign, adGroup, searchTerm: term, targeting, kind, clicks, cost, orders, sales, roas: null,
        reason: allowedCpa != null && cost >= allowedCpa
          ? `${clicks}クリック・${yen(cost)}で注文0。1注文に使ってよい額（${yen(allowedCpa)}）を超えています`
          : `${clicks}クリックで注文0`,
      });
    } else if (orders >= 1 && roas != null && roas < (1 / target.gm) * 0.5 && allowedCpa != null && cost >= allowedCpa * 2) {
      negatives.push({
        key: `adv:neg:${mall}:${campaign}:${adGroup}:${lk(term)}`,
        mall, adType, campaign, adGroup, searchTerm: term, targeting, kind, clicks, cost, orders, sales, roas: round2(roas),
        reason: `売れてはいるが ROAS ${round2(roas)} で損益分岐（${round2(1 / target.gm)}）の半分未満。除外するか、この語だけ入札を下げる`,
      });
    }
  }
  negatives.sort((a, b) => b.cost - a.cost);
  harvest.sort((a, b) => b.sales - a.sales);

  /* ───── 予算（予算切れで機会を逃しているキャンペーン） ───── */
  const { results: campRows } = await db.prepare(
    `SELECT mall, ad_type, campaign, SUM(cost) AS cost, SUM(sales) AS sales,
            AVG(budget_coverage) AS coverage, MAX(budget) AS budget
       FROM daily_ads WHERE case_id = ? AND level = 'campaign' AND ${mallWin("")}
      GROUP BY mall, ad_type, campaign HAVING SUM(cost) > 0`
  ).bind(caseId).all<Record<string, string | number | null>>();
  const campaigns: CampaignResult[] = campRows.map((c) => {
    const gm = mallGm.get(String(c.mall));
    return { mall: String(c.mall), adType: c.ad_type == null ? null : String(c.ad_type), campaign: String(c.campaign),
      cost: n(c.cost), sales: n(c.sales), roas: n(c.cost) > 0 ? round2(n(c.sales) / n(c.cost)) : null, breakEven: gm ? round2(1 / gm) : null };
  }).sort((a, b) => b.cost - a.cost);
  const budgets: BudgetAdvice[] = [];
  for (const c of campRows) {
    if (c.coverage == null) continue;
    const mall = String(c.mall), campaign = String(c.campaign);
    const cost = n(c.cost), sales = n(c.sales), coverage = n(c.coverage);
    const pid = productFor(mall, campaign, "", null);
    const target = targetOf(mall, pid);
    const roas = sales / cost;
    if (coverage < 90 && roas >= target.roas) {
      const budget = c.budget == null ? null : n(c.budget);
      budgets.push({
        key: `adv:bud:${mall}:${campaign}:${isoWeek()}`,
        mall, adType: c.ad_type == null ? null : String(c.ad_type), campaign, cost, sales, roas: round2(roas),
        coverage: Math.round(coverage), budget,
        suggestedBudget: budget ? Math.round(budget * Math.min(1.5, 100 / Math.max(coverage, 1))) : null,
        reason: `1日のうち予算内に収まっていたのは平均 ${Math.round(coverage)}%。ROAS ${round2(roas)} で目標（${target.roas}）を上回っているので、予算切れで売上を逃しています`,
      });
    }
  }

  /* 前提の説明 */
  const targets = [...mallGm.keys(), ...["amazon", "rakuten"].filter((m) => !mallGm.has(m))]
    .filter((m, i, a) => a.indexOf(m) === i)
    .map((m) => {
      const t = targetOf(m, null);
      return { label: m === "amazon" ? "Amazon（商品が特定できないとき）" : "楽天（商品が特定できないとき）",
        gm: mallGm.has(m) ? round2(t.gm * 100) : null, acos: round2(t.acos * 100), roas: t.roas };
    });

  const assumptions = [
    `目標は「広告費を引いたあとに ${adMarginPct}% の利益が残ること」（設定「広告費を引いた後の目標利益率」）。目標ACoS ＝ 広告費前の粗利率 − ${adMarginPct}%`,
    `商品マスタの広告方針で調整：${POLICY_JA.profit}＝上の式／${POLICY_JA.share}＝損益分岐まで／${POLICY_JA.nurture}＝損益分岐の1.3倍まで`,
    `粗利率は商品ごと（期間内の売上・原価・手数料から）。商品が特定できない広告はモール全体の粗利率を使います`,
    `1回の変更は −40%〜＋30% まで。クリックが ${MIN_CLICKS} 未満のものは判断していません`,
    "入札がわからないもの（CSVで入れた期間など）は、平均クリック単価を基準に提案しています",
    `提案はヘッダーの期間に関係なく、Amazon は直近${A.days}日（${A.from}〜${A.to}）、楽天は直近${R.days}日（${R.from}〜${R.to}）の実績から出しています。直近3日は、遅れて入る広告経由の売上を待つため除いています`,
    `入札を変えてから${SETTLE_DAYS}日たっていないキーワードは、変更前の実績が混ざるため提案を出さず「様子見」にしています`,
    "帰属期間：楽天RPP 30日／Amazon SP 7日／SB 14日。楽天は期間が長くても直近分の売上があとから増えることがあります",
  ];

  watching.sort((a, b) => b.changedOn.localeCompare(a.changedOn));
  return {
    from, to, windows: W, watching, campaigns, assumptions, targets,
    bids: bids.slice(0, 150), negatives: negatives.slice(0, 150), harvest: harvest.slice(0, 100), budgets,
    impact: {
      wastedCost: negatives.filter((x) => x.orders === 0).reduce((t, x) => t + x.cost, 0),
      bidDownCost: bids.filter((b) => b.action !== "up").reduce((t, b) => t + b.cost, 0),
    },
  };
}

export const ACTION_JA: Record<BidAdvice["action"], string> = { up: "上げる", down: "下げる", pause: "停止を検討" };
export { pct as advicePct };
