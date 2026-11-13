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
import { growRows, RPP_START_RATIO, RPP_MAX_CPC, normKw } from "./kwPlan";
import { canonKw } from "./kwNorm";
import { buildAllocation, type Allocation } from "./adAllocation";

const n = (v: unknown) => Number(v ?? 0);
const round2 = (v: number) => Math.round(v * 100) / 100;
const yen = (v: number) => "¥" + Math.round(v).toLocaleString("ja-JP");
const pct = (v: number) => `${Math.round(v * 1000) / 10}%`;

/** モールごとの最低入札額 */
// 楽天RPP のキーワードCPC は40円から（商品CPC は10円からだが、ここで提案するのはキーワード単位）
const MIN_BID: Record<string, number> = { amazon: 2, rakuten: 40 };
const MIN_CLICKS = 10;
/** Amazon のオートターゲティング（入札は Amazon 側で上書きされるので提案しない） */
const AUTO_TARGETS = /^(close-match|loose-match|substitutes|complements)$/i;
/** Amazon のキャンペーンの1日の予算の下限 */
const AMAZON_MIN_BUDGET = 100;
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
  /** ツールから追加したキーワード（育成中）の段階的な引き上げ。externalId：楽天＝商品管理番号／Amazon＝広告グループID */
  grow?: { mall: "amazon" | "rakuten"; externalId: string; keyword: string; startBid: number; addedOn: string; cap: number; capBasis: string };
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
  /** up ＝ 増やす／down ＝ 減らす（Amazon は合計を変えずに入れ替える） */
  action: "up" | "down";
  cost: number; sales: number; roas: number; coverage: number | null; budget: number | null;
  suggestedBudget: number | null; reason: string;
}

/** Amazon のキャンペーン予算の入れ替えのまとめ（1日あたり） */
export interface BudgetPlan {
  /** 動いているキャンペーンの1日の予算の合計（今／提案どおりにしたあと） */
  totalBefore: number; totalAfter: number;
  /** モール間の配分（楽天からの移し・予算の余裕）で増やしてよい額／減らす必要のある額（1日あたり、マイナス＝減らす） */
  fromAllocation: number;
  note: string;
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
  budgetPlan: BudgetPlan | null;
  /** 提案どおりにしたとき浮く／増える見込みの広告費（期間あたり） */
  impact: { wastedCost: number; bidDownCost: number };
}

/** 検索語が ASIN（商品ターゲティング）かどうか */
const isAsin = (s: string) => /^b0[0-9a-z]{8}$/i.test(s.trim());
const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

export async function buildAdAdvice(db: D1Database, caseId: string, adMarginPct: number, opts: { allocation?: Allocation } = {}): Promise<AdAdvice> {
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
  // すでに完全一致で入札しているキーワード（クリックが少なくても・一時停止中でも）。追加キーワードの候補から外す
  // 2026-11 本番で、クリックの少ない既存の完全一致キーワードを「追加」に出してしまい、一括アップロードで already exists になった
  {
    const { results: ex } = await db.prepare(
      `SELECT DISTINCT mall, keyword FROM daily_ads WHERE case_id = ? AND level = 'keyword' AND keyword <> '' AND LOWER(match_type) LIKE '%exact%' AND date >= ?`
    ).bind(caseId, jstDay(180)).all<{ mall: string; keyword: string }>();
    for (const e of ex) exactKeywords.add(`${e.mall}\u0000${canonKw(e.mall, e.keyword)}`);
  }
  for (const r of kwRows) {
    const mall = String(r.mall), campaign = String(r.campaign), adGroup = String(r.ad_group);
    const keyword = String(r.keyword), matchType = String(r.match_type);
    if (/exact/i.test(matchType)) exactKeywords.add(`${mall}\u0000${canonKw(mall, keyword)}`);
    // Amazon のオートターゲティングの入札は、アップロードしても Amazon 側で上書きされる（2026-11 本番で確認）→ 提案しない
    if (mall === "amazon" && AUTO_TARGETS.test(keyword.trim())) continue;
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
  /* ───── 育成中のキーワード（キーワード発見から低い入札で追加したもの：楽天・Amazon の推奨だけの語）を14日ごとに +20% ───── */
  // クリックが MIN_CLICKS に届いたら通常の入札の見直しに任せる。上限は損益分岐のCPC（＝平均販売価格 × 粗利率 × CVR）
  const grows = await growRows(db, caseId);
  if (grows.length) {
    const regular = new Set(kwRows.map((r) => r.mall === "rakuten" ? `rakuten\u0000${normKw(String(r.keyword))}`
      : `${r.mall}\u0000${r.campaign}\u0000${r.ad_group}\u0000${normKw(String(r.keyword))}`));
    // CVR：楽天は商品ページ別、Amazon は商品別（どちらもクリック30以上のときだけ。足りなければモール全体）
    const cvrOf = new Map<string, number | null>();
    const mallCvr: Record<string, number | null> = {};
    for (const [mall, col, w] of [["rakuten", "external_id", R], ["amazon", "product_id", A]] as const) {
      const { results: pr } = await db.prepare(
        `SELECT ${col} AS id, SUM(clicks) AS clicks, SUM(orders) AS orders FROM daily_ads
          WHERE case_id = ? AND mall = ? AND level = 'product' AND date BETWEEN ? AND ? AND ${col} IS NOT NULL GROUP BY ${col}`
      ).bind(caseId, mall, w.from, w.to).all<{ id: string; clicks: number; orders: number }>();
      let tc = 0, to2 = 0;
      for (const r of pr) { tc += n(r.clicks); to2 += n(r.orders); cvrOf.set(`${mall}\u0000${r.id}`, n(r.clicks) >= 30 ? n(r.orders) / n(r.clicks) : null); }
      mallCvr[mall] = tc >= 30 ? to2 / tc : null;
    }
    for (const g of grows) {
      const amz = g.mall === "amazon";
      const campaign = amz ? g.campaign ?? "" : "育成中", adGroup = amz ? g.adGroup ?? "" : g.externalId;
      if (amz && (!campaign || !adGroup)) continue;
      if (regular.has(amz ? `amazon\u0000${campaign}\u0000${adGroup}\u0000${normKw(g.keyword)}` : `rakuten\u0000${normKw(g.keyword)}`)) continue;   // クリックがたまって通常の見直しに出ている
      if (g.clicksSince >= MIN_CLICKS) continue;
      const bid = g.reportBid != null && g.reportDate != null && g.reportDate > g.changedOn ? g.reportBid : g.bid;
      if (g.daysSince < SETTLE_DAYS) {
        watching.push({ mall: g.mall, campaign: amz ? campaign : "育成中", adGroup, keyword: g.keyword, matchType: amz ? "exact" : "",
          currentBid: bid, changedOn: g.changedOn, until: dayAfter(g.changedOn, SETTLE_DAYS) });
        continue;
      }
      const pids = amz ? [productFor("amazon", campaign, adGroup, null)].filter((x): x is string => !!x) : pages.get(g.externalId) ?? [];
      const t = (amz ? null : pageTarget(g.externalId)) ?? targetOf(g.mall, pids[0] ?? null);
      const prices = pids.map((id) => products.get(id)?.price).filter((x): x is number => x != null);
      const price = prices.length ? prices.reduce((a, b) => a + b, 0) / prices.length : null;
      const cvr = (amz ? (pids[0] ? cvrOf.get(`amazon\u0000${pids[0]}`) : null) : cvrOf.get(`rakuten\u0000${g.externalId}`)) ?? mallCvr[g.mall] ?? null;
      let cap: number, capBasis: string;
      if (price != null && cvr != null) {
        cap = Math.round(price * t.gm * cvr);
        capBasis = `損益分岐CPC ${yen(cap)}（平均販売価格 ${yen(price)} × 粗利率 ${pct(t.gm)} × CVR ${pct(cvr)}）`;
      } else {
        cap = Math.round(g.startBid / RPP_START_RATIO);
        capBasis = `追加したときの既存キーワードの入札の中央値 ${yen(cap)}（損益分岐CPC を出すデータが足りないため）`;
      }
      cap = Math.min(amz ? 100000 : RPP_MAX_CPC, Math.max(MIN_BID[g.mall] ?? 2, cap));
      if (bid >= cap) continue;
      const suggestedBid = Math.min(cap, Math.max(bid + 1, Math.round(bid * 1.2)));
      const prods = pids.map((x) => products.get(x)).filter((x): x is NonNullable<typeof x> => !!x);
      bids.push({
        key: amz ? `adv:bid:amazon:${campaign}:${adGroup}:${lk(g.keyword)}:exact:${isoWeek()}` : `adv:bid:rakuten:育成中:${g.externalId}:${lk(g.keyword)}::${isoWeek()}`,
        mall: g.mall, adType: amz ? "sp" : "rpp", campaign, adGroup, keyword: g.keyword, matchType: amz ? "exact" : "",
        externalId: amz ? null : g.externalId,
        product: prods.length ? { sku: prods.map((x) => x.sku).join(" / "), name: prods.map((x) => x.name).join(" / ") } : null,
        clicks: g.clicksSince, cost: g.costSince, orders: g.ordersSince, sales: 0, cpc: g.clicksSince ? Math.round(g.costSince / g.clicksSince) : 0,
        cvr: 0, roas: null, currentBid: bid, suggestedCpc: null, target: t, action: "up", suggestedBid, basis: "入札",
        reason: `育成中（${g.addedOn} に ${yen(g.startBid)} で追加）。入札を入れてから${g.daysSince}日でクリック ${g.clicksSince}。少しずつ上げます（+20%・上限：${capBasis}）`,
        grow: { mall: g.mall, externalId: g.externalId, keyword: g.keyword, startBid: g.startBid, addedOn: g.addedOn, cap, capBasis },
      });
    }
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
    const isOwnExact = /exact/i.test(matchType) && canonKw(mall, term) === canonKw(mall, targeting);

    if (orders >= 2 && roas != null && roas >= target.roas && !isOwnExact && !exactKeywords.has(`${mall}\u0000${canonKw(mall, term)}`)) {
      const key = `${mall}\u0000${canonKw(mall, term)}`;   // 表記ゆれ（かな・単複・全角半角）は1つにまとめる
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
    if (c.coverage == null || c.mall === "amazon") continue;      // Amazon は下で合計を変えずに入れ替える
    const mall = String(c.mall), campaign = String(c.campaign);
    const cost = n(c.cost), sales = n(c.sales), coverage = n(c.coverage);
    const pid = productFor(mall, campaign, "", null);
    const target = targetOf(mall, pid);
    const roas = sales / cost;
    if (coverage < 90 && roas >= target.roas) {
      const budget = c.budget == null ? null : n(c.budget);
      budgets.push({
        key: `adv:bud:${mall}:${campaign}:${isoWeek()}`,
        mall, adType: c.ad_type == null ? null : String(c.ad_type), campaign, action: "up", cost, sales, roas: round2(roas),
        coverage: Math.round(coverage), budget,
        suggestedBudget: budget ? Math.round(budget * Math.min(1.5, 100 / Math.max(coverage, 1))) : null,
        reason: `1日のうち予算内に収まっていたのは平均 ${Math.round(coverage)}%。ROAS ${round2(roas)} で目標（${target.roas}）を上回っているので、予算切れで売上を逃しています`,
      });
    }
  }

  /* ───── Amazon：キャンペーンの1日の予算を、合計を変えずに入れ替える ───── */
  // 増やす：予算切れ（予算の9割以上を使った日が3割以上、または予算内の時間が90%未満）で ROAS が目標以上
  // 減らす（増やす分の出どころ）：① ROAS が損益分岐を下回る（予算の30%）② 予算を使い切っていない（1日平均が予算の半分未満 → 平均の1.5倍まで）
  // 例外：モール間の配分で楽天から移す・月の広告予算に余裕がある → その分は合計を増やしてよい。予算を超えるペースなら合計を減らす
  const alloc = opts.allocation ?? await buildAllocation(db, caseId, R.from, R.to).catch(() => null);
  let budgetPlan: BudgetPlan | null = null;
  {
    const { results: ac } = await db.prepare(
      `SELECT campaign, MAX(ad_type) AS ad_type, SUM(cost) AS cost, SUM(sales) AS sales, COUNT(DISTINCT date) AS days, MAX(date) AS last,
              SUM(CASE WHEN budget > 0 AND cost >= budget * 0.9 THEN 1 ELSE 0 END) AS cap_days, AVG(budget_coverage) AS coverage,
              (SELECT b.budget FROM daily_ads b WHERE b.case_id = a.case_id AND b.mall = 'amazon' AND b.level = 'campaign'
                 AND b.campaign = a.campaign AND b.budget IS NOT NULL ORDER BY b.date DESC LIMIT 1) AS budget
         FROM daily_ads a WHERE a.case_id = ? AND a.mall = 'amazon' AND a.level = 'campaign' AND a.date BETWEEN ? AND ?
        GROUP BY campaign`
    ).bind(caseId, A.from, A.to).all<Record<string, string | number | null>>();
    type Camp = { campaign: string; adType: string | null; cost: number; sales: number; roas: number; budget: number; avgDaily: number;
      limited: boolean; capDays: number; days: number; coverage: number | null; target: Target; be: number };
    const live: Camp[] = [];
    for (const r of ac) {
      if (r.budget == null || n(r.budget) <= 0 || String(r.last) < jstDay(10)) continue;     // 予算が分からない・止まっている
      const cost = n(r.cost), sales = n(r.sales), budget = n(r.budget), days = n(r.days), capDays = n(r.cap_days);
      const coverage = r.coverage == null ? null : n(r.coverage);
      const target = targetOf("amazon", productFor("amazon", String(r.campaign), "", null));
      live.push({ campaign: String(r.campaign), adType: r.ad_type == null ? null : String(r.ad_type), cost, sales,
        roas: cost > 0 ? sales / cost : 0, budget, avgDaily: cost / A.days, capDays, days, coverage,
        limited: (coverage != null && coverage < 90) || (days > 0 && capDays / days >= 0.3), target, be: 1 / target.gm });
    }
    const ups = live.filter((c) => c.limited && c.cost > 0 && c.roas >= c.target.roas)
      .map((c) => ({ c, delta: Math.round(c.budget * (c.coverage != null ? Math.min(1.5, 100 / Math.max(c.coverage, 1)) : 1.3)) - c.budget }))
      .filter((u) => u.delta > 0).sort((a, b) => b.c.roas - a.c.roas);
    // モール間の配分からの増減（1日あたり）
    const p = alloc?.proposal;
    const fromAllocation = p && p.toMall === "amazon" && (p.action === "shift" || p.action === "add") ? Math.round(p.amount30d / 30)
      : p && p.fromMall === "amazon" && p.action === "cut" ? -Math.round(p.amount30d / 30) : 0;
    const allocWhy = p && fromAllocation > 0 ? (p.action === "shift" ? "楽天からの配分" : "月の広告予算の余裕") : "";
    const sources = [
      ...live.filter((c) => c.cost > 0 && c.roas < c.be).sort((a, b) => a.roas - b.roas)
        .map((c) => ({ c, max: Math.max(0, Math.min(Math.round(c.budget * 0.3), c.budget - AMAZON_MIN_BUDGET)), why: "loss" as const })),
      ...live.filter((c) => !c.limited && c.avgDaily < c.budget * 0.5 && !(c.cost > 0 && c.roas < c.be))
        .map((c) => ({ c, max: Math.max(0, c.budget - Math.max(AMAZON_MIN_BUDGET, Math.round(c.avgDaily * 1.5))), why: "unused" as const }))
        .sort((a, b) => b.max - a.max),
    ].filter((x) => x.max > 0);
    const need = ups.reduce((t, u) => t + u.delta, 0);
    const requiredCut = Math.max(0, -fromAllocation);
    const free = Math.max(0, fromAllocation);
    let toCut = Math.max(0, need - free) + requiredCut;
    const cuts: Array<{ c: Camp; cut: number; why: "loss" | "unused" }> = [];
    for (const s0 of sources) {
      if (toCut <= 0) break;
      const cut = Math.min(s0.max, toCut);
      cuts.push({ c: s0.c, cut, why: s0.why });
      toCut -= cut;
    }
    const cutTotal = cuts.reduce((t, x) => t + x.cut, 0);
    let pool = Math.max(0, cutTotal - requiredCut) + free;      // 増やすのに使える額
    const fund = free > 0 && cutTotal > requiredCut ? `ほかのキャンペーンの減額と、${allocWhy}（1日 ${yen(free)}）でまかないます`
      : free > 0 ? `${allocWhy}（1日 ${yen(free)}）を使います` : "ほかのキャンペーンの減額でまかない、合計は変えません";
    for (const u of ups) {
      const give = Math.min(u.delta, pool);
      if (give <= 0) break;
      pool -= give;
      const c = u.c, nb = c.budget + give;
      budgets.push({
        key: `adv:bud:amazon:${c.campaign}:${isoWeek()}`, mall: "amazon", adType: c.adType, campaign: c.campaign, action: "up",
        cost: c.cost, sales: c.sales, roas: round2(c.roas), coverage: c.coverage == null ? null : Math.round(c.coverage), budget: c.budget, suggestedBudget: nb,
        reason: `予算切れ（${c.coverage != null ? `予算内の時間 平均 ${Math.round(c.coverage)}%` : `予算の9割以上を使った日が ${c.capDays}/${c.days}日`}）で ROAS ${round2(c.roas)}（目標 ${c.target.roas}）。` +
          `${give < u.delta ? `本来は ${yen(c.budget + u.delta)} まで上げたいところ、出どころの範囲で ${yen(nb)} に。` : ""}増額分は${fund}`,
      });
    }
    const upTotal = budgets.filter((b) => b.mall === "amazon" && b.action === "up").reduce((t, b) => t + (n(b.suggestedBudget) - n(b.budget)), 0);
    // 増やす先が無いのに減らすのは、予算を超えるペースのときだけ（requiredCut）。増やす分を超えて減らさない
    let cutBudget = upTotal - free + requiredCut;
    for (const x of cuts) {
      if (cutBudget <= 0) break;
      const cut = Math.min(x.cut, cutBudget);
      cutBudget -= cut;
      const c = x.c, nb = c.budget - cut;
      budgets.push({
        key: `adv:bud:amazon:${c.campaign}:${isoWeek()}`, mall: "amazon", adType: c.adType, campaign: c.campaign, action: "down",
        cost: c.cost, sales: c.sales, roas: round2(c.roas), coverage: c.coverage == null ? null : Math.round(c.coverage), budget: c.budget, suggestedBudget: nb,
        reason: (x.why === "loss" ? `ROAS ${round2(c.roas)} で損益分岐（${round2(c.be)}）を下回っています。`
          : `直近${A.days}日の1日平均の広告費は ${yen(c.avgDaily)} で、予算 ${yen(c.budget)} の${Math.round((c.avgDaily / c.budget) * 100)}%しか使っていません。`) +
          (requiredCut > 0 && upTotal === 0 ? "月の広告予算を超えるペースなので減らします" : "減らした分を、予算切れで成果の出ているキャンペーンに回します"),
      });
    }
    if (live.length) {
      const before = live.reduce((t, c) => t + c.budget, 0);
      const delta = budgets.filter((b) => b.mall === "amazon").reduce((t, b) => t + (n(b.suggestedBudget) - n(b.budget)), 0);
      budgetPlan = { totalBefore: before, totalAfter: before + delta, fromAllocation,
        note: delta === 0 ? "1日の予算の合計は変わりません（増やした分をほかのキャンペーンから減らします）"
          : delta > 0 ? `1日の予算の合計が ${yen(delta)} 増えます（${allocWhy || "配分"}の分）`
          : `1日の予算の合計が ${yen(-delta)} 減ります（月の広告予算を超えるペースのため）` };
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
    "Amazon のオートターゲティング（close-match・loose-match・substitutes・complements）の入札は、アップロードしても Amazon 側で上書きされるため提案しません（除外キーワード・予算の提案は出します）",
    "Amazon のキャンペーン予算は、1日の予算の合計を変えずに入れ替えます（予算切れで成果の出ているキャンペーンを増やし、赤字・使い切っていないキャンペーンを減らす）。楽天から配分を移すとき・月の広告予算に余裕があるときだけ合計を増やし、予算を超えるペースなら減らします",
    "帰属期間：楽天RPP 30日／Amazon SP 7日／SB 14日。楽天は期間が長くても直近分の売上があとから増えることがあります",
    `キーワード発見から低い入札で追加したキーワード（楽天・Amazon の推奨だけの語）は「育成中」：既存キーワードの中央値の${Math.round(RPP_START_RATIO * 100)}%で入れ、${SETTLE_DAYS}日たってもクリックが ${MIN_CLICKS} 未満なら +20% を提案します（上限は損益分岐CPC）。クリックがたまったら通常の見直しに移ります`,
  ];

  watching.sort((a, b) => b.changedOn.localeCompare(a.changedOn));
  return {
    from, to, windows: W, watching, campaigns, assumptions, targets,
    bids: bids.slice(0, 150), negatives: negatives.slice(0, 150), harvest: harvest.slice(0, 100), budgets, budgetPlan,
    impact: {
      wastedCost: negatives.filter((x) => x.orders === 0).reduce((t, x) => t + x.cost, 0),
      bidDownCost: bids.filter((b) => b.action !== "up").reduce((t, b) => t + b.cost, 0),
    },
  };
}

export const ACTION_JA: Record<BidAdvice["action"], string> = { up: "上げる", down: "下げる", pause: "停止を検討" };
export { pct as advicePct };
