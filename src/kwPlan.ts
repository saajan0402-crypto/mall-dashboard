/**
 * キーワード発見 → 一括ファイル
 *
 * - キーワード発見の候補を「一括に入れる」にすると kw_plan に入り、広告タブの一括ファイルに追加の行として載る
 *   （アプリからモールへは書き込まない。アップロードは担当者が手で行う）
 * - Amazon：関連商品が入っている広告グループ（広告費の多い順）を並べて返し、画面側で一括操作ファイルの中から
 *   「手動ターゲティング・キーワードの広告グループ」を選ぶ。入札は Amazon の推奨（中央）、無ければ検索語のクリック単価
 * - 楽天RPP：関連商品の商品ページ（商品管理番号）ごとに n 行。最初の入札は低めにする：
 *     その商品ページの既存キーワードの入札の中央値 × 70%（下限40円）。既存キーワードが無ければ 40円か商品CPC の高いほう
 *   書き出して対応済みにしたら kw_grow（育成中）に入れ、14日ごとにクリックが少なければ +20% を提案する（adAdvice.ts）
 */

import { rakutenPages } from "./adProducts";

const n = (v: unknown) => Number(v ?? 0);
const jstDay = (d: number) => new Date(Date.now() + 9 * 3600000 - d * 86400000).toISOString().slice(0, 10);
export const RPP_MIN_CPC = 40, RPP_MAX_CPC = 10000;
/** 楽天の最初の入札＝既存キーワードの中央値 × この比率 */
export const RPP_START_RATIO = 0.7;

export const normKw = (keyword: string) => keyword.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
/** 候補を「追加した」「見送る」にしたときの鍵（要対応の状態と同じ仕組みに載せ、対応の記録・レポートに出す） */
export const kwKey = (mall: string, keyword: string) => `kw_added:${mall}:${normKw(keyword)}`;

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export interface PlanRow { mall: string; keyword: string; source: string | null; productIds: string[]; by: string | null; at: string }

export async function listPlans(db: D1Database, caseId: string): Promise<PlanRow[]> {
  try {
    const { results } = await db.prepare(
      "SELECT mall, keyword, source, product_ids, planned_by, planned_at FROM kw_plan WHERE case_id = ? ORDER BY planned_at"
    ).bind(caseId).all<Record<string, string | null>>();
    return results.map((r) => ({ mall: String(r.mall), keyword: String(r.keyword), source: r.source,
      productIds: (() => { try { return (JSON.parse(String(r.product_ids ?? "[]")) as unknown[]).map(String); } catch { return []; } })(),
      by: r.planned_by, at: String(r.planned_at) }));
  } catch {
    return [];    // テーブルがまだ無いとき
  }
}

export async function addPlan(db: D1Database, caseId: string, p: { mall: string; keyword: string; source?: string | null; productIds?: string[] }, by: string | null) {
  await db.prepare(
    `INSERT INTO kw_plan (case_id, mall, keyword, source, product_ids, planned_by) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(case_id, mall, keyword) DO UPDATE SET source = excluded.source, product_ids = excluded.product_ids,
       planned_by = excluded.planned_by, planned_at = datetime('now')`
  ).bind(caseId, p.mall, p.keyword.normalize("NFKC").trim().replace(/\s+/g, " "), p.source ?? null,
    JSON.stringify((p.productIds ?? []).slice(0, 10)), by).run();
}

export async function removePlan(db: D1Database, caseId: string, mall: string, keyword: string) {
  await db.prepare("DELETE FROM kw_plan WHERE case_id = ? AND mall = ? AND keyword = ?")
    .bind(caseId, mall, keyword.normalize("NFKC").trim().replace(/\s+/g, " ")).run().catch(() => undefined);
}

export interface ResolvedPlan {
  key: string; mall: "amazon" | "rakuten"; keyword: string; source: string | null; products: string[];
  by: string | null; at: string;
  /** Amazon：入れる先の候補（広告費の多い順）。画面で一括操作ファイルの中の手動・キーワードの広告グループを選ぶ */
  groups?: Array<{ campaign: string; adGroup: string }>;
  bid?: number | null; bidBasis?: string;
  /** 楽天：商品ページごとの行 */
  rows?: Array<{ externalId: string; cpc: number; basis: string }>;
  /** 入れられない理由（楽天の商品ページが分からない など） */
  problem?: string;
}

/** 一括に入れる候補に、入れる先と最初の入札を付ける */
export async function resolvePlans(db: D1Database, caseId: string): Promise<ResolvedPlan[]> {
  const plans = await listPlans(db, caseId);
  if (!plans.length) return [];
  const since = jstDay(60);
  const allPids = [...new Set(plans.flatMap((p) => p.productIds))];
  const names = new Map<string, string>();
  if (allPids.length) {
    const { results } = await db.prepare(`SELECT id, name FROM products WHERE case_id = ? AND id IN (${allPids.map(() => "?").join(",")})`)
      .bind(caseId, ...allPids).all<{ id: string; name: string }>();
    for (const r of results) names.set(r.id, r.name);
  }

  // 楽天：商品 → 商品ページ（商品管理番号）
  const pages = await rakutenPages(db, caseId);
  const numsOf = new Map<string, string[]>();
  for (const [num, pids] of pages) for (const pid of pids) numsOf.set(pid, [...(numsOf.get(pid) ?? []), num]);
  const startCache = new Map<string, { cpc: number; basis: string; existing: Set<string> }>();
  const rakutenStart = async (num: string) => {
    const hit = startCache.get(num);
    if (hit) return hit;
    const { results } = await db.prepare(
      `SELECT keyword, bid FROM daily_ads WHERE case_id = ? AND mall = 'rakuten' AND level = 'keyword' AND external_id = ? AND keyword <> ''
          AND bid IS NOT NULL AND date >= ? ORDER BY date DESC`
    ).bind(caseId, num, since).all<{ keyword: string; bid: number }>();
    const latest = new Map<string, number>();
    for (const r of results) if (!latest.has(normKw(r.keyword))) latest.set(normKw(r.keyword), n(r.bid));
    const med = median([...latest.values()]);
    // 育成中（ツールから追加したがクリックが無くレポートに出ていない）キーワードも登録済みとして扱う
    const { results: gr } = await db.prepare("SELECT keyword FROM kw_grow WHERE case_id = ? AND mall = 'rakuten' AND external_id = ?")
      .bind(caseId, num).all<{ keyword: string }>().catch(() => ({ results: [] as Array<{ keyword: string }> }));
    const existing = new Set([...latest.keys(), ...gr.map((g) => normKw(g.keyword))]);
    let out: { cpc: number; basis: string };
    if (med != null) {
      out = { cpc: Math.round(med * RPP_START_RATIO), basis: `既存キーワード ${latest.size}件の入札の中央値 ¥${Math.round(med).toLocaleString("ja-JP")} × ${Math.round(RPP_START_RATIO * 100)}%` };
    } else {
      const p = await db.prepare(
        `SELECT bid FROM daily_ads WHERE case_id = ? AND mall = 'rakuten' AND level = 'product' AND external_id = ? AND bid IS NOT NULL ORDER BY date DESC LIMIT 1`
      ).bind(caseId, num).first<{ bid: number }>();
      out = p?.bid != null && n(p.bid) > RPP_MIN_CPC
        ? { cpc: Math.round(n(p.bid)), basis: `既存キーワードが無いため商品CPC ¥${Math.round(n(p.bid)).toLocaleString("ja-JP")}` }
        : { cpc: RPP_MIN_CPC, basis: "既存キーワードが無いため下限の40円" };
    }
    out.cpc = Math.min(RPP_MAX_CPC, Math.max(RPP_MIN_CPC, out.cpc));
    const v = { ...out, existing };
    startCache.set(num, v);
    return v;
  };

  const out: ResolvedPlan[] = [];
  for (const p of plans) {
    const base: ResolvedPlan = { key: kwKey(p.mall, p.keyword), mall: p.mall === "rakuten" ? "rakuten" : "amazon", keyword: p.keyword, source: p.source,
      products: p.productIds.map((id) => names.get(id)).filter((x): x is string => !!x), by: p.by, at: p.at };
    if (base.mall === "amazon") {
      const groups: Array<{ campaign: string; adGroup: string }> = [];
      const seen = new Set<string>();
      const push = (c: string, g: string) => { const k = `${c}\u0000${g}`; if (c && g && !seen.has(k)) { seen.add(k); groups.push({ campaign: c, adGroup: g }); } };
      if (p.productIds.length) {
        const { results } = await db.prepare(
          `SELECT campaign, ad_group, SUM(cost) AS cost FROM daily_ads
            WHERE case_id = ? AND mall = 'amazon' AND level = 'product' AND COALESCE(ad_type, 'sp') = 'sp' AND date >= ?
              AND product_id IN (${p.productIds.map(() => "?").join(",")})
            GROUP BY campaign, ad_group ORDER BY cost DESC LIMIT 30`
        ).bind(caseId, since, ...p.productIds).all<{ campaign: string; ad_group: string }>();
        for (const r of results) push(r.campaign, r.ad_group);
      }
      // 検索語で売れた語は、その検索語が出た広告グループも候補に（商品が分からないときのため）
      const { results: st } = await db.prepare(
        `SELECT campaign, ad_group, SUM(orders) AS orders, SUM(cost) AS cost, SUM(clicks) AS clicks FROM daily_search_terms
          WHERE case_id = ? AND mall = 'amazon' AND date >= ? AND LOWER(search_term) = ? GROUP BY campaign, ad_group ORDER BY orders DESC, cost DESC`
      ).bind(caseId, since, normKw(p.keyword)).all<{ campaign: string; ad_group: string; orders: number; cost: number; clicks: number }>();
      for (const r of st) push(r.campaign, r.ad_group);
      base.groups = groups;
      const reco = await db.prepare("SELECT MAX(bid_median) AS b FROM kw_reco WHERE case_id = ? AND LOWER(keyword) = ?")
        .bind(caseId, normKw(p.keyword)).first<{ b: number | null }>().catch(() => null);
      const clicks = st.reduce((t, r) => t + n(r.clicks), 0), cost = st.reduce((t, r) => t + n(r.cost), 0);
      if (reco?.b != null && n(reco.b) > 0) { base.bid = Math.max(2, Math.round(n(reco.b))); base.bidBasis = "Amazon の推奨入札（中央）"; }
      else if (clicks > 0 && cost > 0) { base.bid = Math.max(2, Math.round(cost / clicks)); base.bidBasis = `検索語のクリック単価（直近60日・${clicks}クリック）`; }
      else {
        const { results: bs } = await db.prepare(
          "SELECT bid FROM daily_ads WHERE case_id = ? AND mall = 'amazon' AND level = 'keyword' AND bid IS NOT NULL AND date >= ?"
        ).bind(caseId, jstDay(14)).all<{ bid: number }>();
        const m = median(bs.map((b) => n(b.bid)));
        base.bid = m != null ? Math.max(2, Math.round(m)) : null;
        base.bidBasis = m != null ? "推奨も実績も無いため、今のキーワードの入札の中央値" : "入札を決められません";
      }
      if (!groups.length) base.problem = "関連商品の広告グループが見つかりません（入れる先を手で決めてください）";
    } else {
      const nums = [...new Set(p.productIds.flatMap((id) => numsOf.get(id) ?? []))];
      const rows: NonNullable<ResolvedPlan["rows"]> = [];
      const already: string[] = [];
      for (const num of nums.slice(0, 10)) {
        const s = await rakutenStart(num);
        if (s.existing.has(normKw(p.keyword))) { already.push(num); continue; }
        rows.push({ externalId: num, cpc: s.cpc, basis: s.basis });
      }
      base.rows = rows;
      if (!nums.length) base.problem = p.productIds.length ? "関連商品の楽天の商品ページ（商品管理番号）が商品マスタにありません" : "関連商品が分からないため、楽天の商品ページを決められません";
      else if (!rows.length) base.problem = `すでに登録済みです（${already.join("・")}）`;
    }
    out.push(base);
  }
  return out;
}

/** 書き出して対応済みにした：計画から外し、楽天は育成中に入れる */
export async function finishPlan(db: D1Database, caseId: string, mall: string, keyword: string,
  rows: Array<{ externalId: string; cpc: number }> | undefined, by: string | null) {
  await removePlan(db, caseId, mall, keyword);
  if (mall !== "rakuten" || !rows?.length) return;
  const today = jstDay(0), kw = keyword.normalize("NFKC").trim().replace(/\s+/g, " ");
  await db.batch(rows.slice(0, 20).map((r) => db.prepare(
    `INSERT INTO kw_grow (case_id, mall, external_id, keyword, start_bid, bid, changed_on, added_on, added_by)
     VALUES (?, 'rakuten', ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(case_id, mall, external_id, keyword) DO UPDATE SET start_bid = excluded.start_bid, bid = excluded.bid,
       changed_on = excluded.changed_on, added_on = excluded.added_on, added_by = excluded.added_by`
  ).bind(caseId, String(r.externalId), kw, Math.round(n(r.cpc)), Math.round(n(r.cpc)), today, today, by)));
}

/** 育成中のキーワードの入札を上げた（一括ファイルを対応済みにしたとき） */
export async function growBidChanged(db: D1Database, caseId: string, externalId: string, keyword: string, bid: number) {
  await db.prepare("UPDATE kw_grow SET bid = ?, changed_on = ? WHERE case_id = ? AND mall = 'rakuten' AND external_id = ? AND keyword = ?")
    .bind(Math.round(bid), jstDay(0), caseId, externalId, keyword).run().catch(() => undefined);
}

export interface GrowRow {
  externalId: string; keyword: string; startBid: number; bid: number; changedOn: string; addedOn: string; addedBy: string | null;
  /** 入札を最後に入れてからのクリック・注文（RPP のキーワード別レポート） */
  clicksSince: number; ordersSince: number; costSince: number;
  /** レポートに出ている今の入札（手で変えた場合はこちら） */
  reportBid: number | null; reportDate: string | null;
  daysSince: number;
}

const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

export async function growRows(db: D1Database, caseId: string): Promise<GrowRow[]> {
  let rows: Array<Record<string, string | number | null>>;
  try {
    ({ results: rows } = await db.prepare(
      `SELECT g.external_id, g.keyword, g.start_bid, g.bid, g.changed_on, g.added_on, g.added_by,
              (SELECT COALESCE(SUM(a.clicks), 0) FROM daily_ads a WHERE a.case_id = g.case_id AND a.mall = 'rakuten' AND a.level = 'keyword'
                 AND a.external_id = g.external_id AND LOWER(a.keyword) = LOWER(g.keyword) AND a.date >= g.changed_on) AS clicks,
              (SELECT COALESCE(SUM(a.orders), 0) FROM daily_ads a WHERE a.case_id = g.case_id AND a.mall = 'rakuten' AND a.level = 'keyword'
                 AND a.external_id = g.external_id AND LOWER(a.keyword) = LOWER(g.keyword) AND a.date >= g.changed_on) AS orders,
              (SELECT COALESCE(SUM(a.cost), 0) FROM daily_ads a WHERE a.case_id = g.case_id AND a.mall = 'rakuten' AND a.level = 'keyword'
                 AND a.external_id = g.external_id AND LOWER(a.keyword) = LOWER(g.keyword) AND a.date >= g.changed_on) AS cost,
              (SELECT a.bid || '|' || a.date FROM daily_ads a WHERE a.case_id = g.case_id AND a.mall = 'rakuten' AND a.level = 'keyword'
                 AND a.external_id = g.external_id AND LOWER(a.keyword) = LOWER(g.keyword) AND a.bid IS NOT NULL ORDER BY a.date DESC LIMIT 1) AS rb
         FROM kw_grow g WHERE g.case_id = ? AND g.mall = 'rakuten' ORDER BY g.added_on DESC`
    ).bind(caseId).all<Record<string, string | number | null>>());
  } catch {
    return [];
  }
  const today = jstDay(0);
  return rows.map((r) => {
    const [rb, rd] = r.rb == null ? [null, null] : String(r.rb).split("|");
    return {
      externalId: String(r.external_id), keyword: String(r.keyword), startBid: n(r.start_bid), bid: n(r.bid),
      changedOn: String(r.changed_on), addedOn: String(r.added_on), addedBy: r.added_by == null ? null : String(r.added_by),
      clicksSince: n(r.clicks), ordersSince: n(r.orders), costSince: n(r.cost),
      reportBid: rb == null ? null : n(rb), reportDate: rd ?? null, daysSince: daysBetween(String(r.changed_on), today),
    };
  });
}
