/**
 * キーワード発見 → 一括ファイル
 *
 * - キーワード発見の候補を「一括に入れる」にすると kw_plan に入り、広告タブの一括ファイルに追加の行として載る
 *   （アプリからモールへは書き込まない。アップロードは担当者が手で行う）
 * - Amazon：関連商品が入っている広告グループ（広告費の多い順）を並べて返し、画面側で一括操作ファイルの中から
 *   「手動ターゲティング・キーワードの広告グループ」を選ぶ。入札は：
 *     検索語で売れた語 → 売れたときのクリック単価（その単価で注文が取れているため）
 *     それ以外（Amazon の推奨だけの語など）→ 関連商品の広告グループの既存キーワードの入札の中央値 × 70%（育成中にする）
 *   Amazon の推奨入札は強気なので入札には使わず、参考として出すだけ（2026-11-11 ユーザー判断）
 * - 楽天RPP：関連商品の商品ページ（商品管理番号）ごとに n 行。最初の入札は低めにする：
 *     その商品ページの既存キーワードの入札の中央値 × 70%（下限40円）。既存キーワードが無ければ 40円か商品CPC の高いほう
 *   書き出して対応済みにしたら kw_grow（育成中）に入れ、14日ごとにクリックが少なければ +20% を提案する（adAdvice.ts）
 */

import { rakutenPages } from "./adProducts";
import { canonKw } from "./kwNorm";
import { rppSnapshot, applyRppChanges, RPP_KW_LIMIT } from "./rppKeywords";

const n = (v: unknown) => Number(v ?? 0);
const jstDay = (d: number) => new Date(Date.now() + 9 * 3600000 - d * 86400000).toISOString().slice(0, 10);
export const RPP_MIN_CPC = 40, RPP_MAX_CPC = 10000;
/** 最初の入札＝既存キーワードの中央値 × この比率（楽天・Amazon の推奨だけの語） */
export const RPP_START_RATIO = 0.7;

export const normKw = (keyword: string) => keyword.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
/** 候補を「追加した」「見送る」にしたときの鍵（要対応の状態と同じ仕組みに載せ、対応の記録・レポートに出す） */
export const kwKey = (mall: string, keyword: string) => `kw_added:${mall}:${normKw(keyword)}`;

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export interface PlanRow { mall: string; keyword: string; source: string | null; productIds: string[]; by: string | null; at: string;
  /** 楽天：入れる商品ページを担当者が選んだとき（無ければ一番売れている1ページだけ） */
  pages: string[] | null }

export async function listPlans(db: D1Database, caseId: string): Promise<PlanRow[]> {
  try {
    const { results } = await db.prepare(
      "SELECT mall, keyword, source, product_ids, planned_by, planned_at, pages FROM kw_plan WHERE case_id = ? ORDER BY planned_at"
    ).bind(caseId).all<Record<string, string | null>>();
    return results.map((r) => ({ mall: String(r.mall), keyword: String(r.keyword), source: r.source,
      productIds: (() => { try { return (JSON.parse(String(r.product_ids ?? "[]")) as unknown[]).map(String); } catch { return []; } })(),
      by: r.planned_by, at: String(r.planned_at),
      pages: r.pages ? (() => { try { return (JSON.parse(String(r.pages)) as unknown[]).map(String); } catch { return null; } })() : null }));
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

/** 楽天：入れる商品ページを選び直す（空なら既定＝一番売れている1ページに戻す） */
export async function setPlanPages(db: D1Database, caseId: string, mall: string, keyword: string, pages: string[]) {
  await db.prepare("UPDATE kw_plan SET pages = ? WHERE case_id = ? AND mall = ? AND keyword = ?")
    .bind(pages.length ? JSON.stringify(pages.slice(0, 10).map(String)) : null, caseId, mall, keyword.normalize("NFKC").trim().replace(/\s+/g, " ")).run();
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
  /** 低めに入れて育てる（14日ごとにクリックが少なければ +20%） */
  grow?: boolean;
  /** Amazon の推奨入札（参考）。今の入札の10倍を超えるなど異常な値は recoNote で注意を出す */
  recoBid?: number | null; recoNote?: string | null;
  /** 楽天：商品ページごとの行 */
  rows?: Array<{ externalId: string; cpc: number; basis: string;
    /** 登録数（RPP の登録キーワード一覧を読み込んであるとき）。例 "17/20" */
    slots?: string | null;
    /** 上限のため入れ替える語（一括ファイルで d 行にする） */
    remove?: { keyword: string; reason: string } }>;
  /** 楽天：関連する商品ページ（選んで追加できる）。registered ＝ すでに登録済み（同じ扱いの表記を含む） */
  pageOptions?: Array<{ num: string; registered: boolean; slots: string | null; selected: boolean }>;
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
  type RakStart = { cpc: number; basis: string; existing: Set<string>; count: number; known: boolean;
    removable: Array<{ keyword: string; canon: string; clicks: number; cpc: number }>; used: number; removed: Set<string> };
  const startCache = new Map<string, RakStart>();
  // RPP の登録キーワード一覧（読み込んであれば、クリック0のキーワードも含めた登録数・かぶりの判定・入札の基準に使う）
  const snap = await rppSnapshot(db, caseId);
  // 楽天の商品ページごとの売上（直近60日）。入れるページを選ぶ順に使う
  const pageRev = new Map<string, number>();
  {
    const { results: rv } = await db.prepare(
      `SELECT product_id, SUM(revenue) AS rev FROM daily_sales WHERE case_id = ? AND mall = 'rakuten' AND date >= ? AND product_id IS NOT NULL GROUP BY product_id`
    ).bind(caseId, since).all<{ product_id: string; rev: number }>();
    const byPid = new Map(rv.map((r) => [String(r.product_id), n(r.rev)]));
    for (const [num, pids] of pages) pageRev.set(num, pids.reduce((t, id) => t + (byPid.get(id) ?? 0), 0));
  }
  const rakutenStart = async (num: string) => {
    const hit = startCache.get(num);
    if (hit) return hit;
    const { results } = await db.prepare(
      `SELECT keyword, bid FROM daily_ads WHERE case_id = ? AND mall = 'rakuten' AND level = 'keyword' AND external_id = ? AND keyword <> ''
          AND bid IS NOT NULL AND date >= ? ORDER BY date DESC`
    ).bind(caseId, num, since).all<{ keyword: string; bid: number }>();
    const latest = new Map<string, number>();
    // 楽天は かな・語順の違いを同じ語とみなす（kwNorm.ts）
    for (const r of results) if (!latest.has(canonKw("rakuten", r.keyword))) latest.set(canonKw("rakuten", r.keyword), n(r.bid));
    const item = snap.items.get(num);
    // 一覧があればそのキーワードCPC（クリック0の語も含む）を基準にする
    const base = item ? new Map(item.keywords.filter((k) => k.cpc != null).map((k) => [k.canon, Number(k.cpc)])) : latest;
    const med = median([...base.values()]);
    // 育成中（ツールから追加したがクリックが無くレポートに出ていない）キーワードも登録済みとして扱う
    const { results: gr } = await db.prepare("SELECT keyword, added_on FROM kw_grow WHERE case_id = ? AND mall = 'rakuten' AND external_id = ?")
      .bind(caseId, num).all<{ keyword: string; added_on: string }>().catch(() => ({ results: [] as Array<{ keyword: string; added_on: string }> }));
    const existing = new Set([...latest.keys(), ...gr.map((g) => canonKw("rakuten", g.keyword)), ...(item?.keywords.map((k) => k.canon) ?? [])]);
    // 商品CPC（キーワードCPC がこれより低いと登録の意味が薄いので下限にする）
    let itemCpc = item?.itemCpc ?? null;
    if (itemCpc == null) {
      const p = await db.prepare(
        `SELECT bid FROM daily_ads WHERE case_id = ? AND mall = 'rakuten' AND level = 'product' AND external_id = ? AND bid IS NOT NULL ORDER BY date DESC LIMIT 1`
      ).bind(caseId, num).first<{ bid: number }>();
      itemCpc = p?.bid != null ? Math.round(n(p.bid)) : null;
    }
    let out: { cpc: number; basis: string };
    if (med != null) {
      out = { cpc: Math.round(med * RPP_START_RATIO), basis: `${item ? "登録済み" : "既存"}キーワード ${base.size}件の入札の中央値 ¥${Math.round(med).toLocaleString("ja-JP")} × ${Math.round(RPP_START_RATIO * 100)}%` };
    } else {
      out = itemCpc != null && itemCpc > RPP_MIN_CPC
        ? { cpc: itemCpc + 1, basis: `既存キーワードが無いため商品CPC ¥${itemCpc.toLocaleString("ja-JP")}＋1円` }
        : { cpc: RPP_MIN_CPC, basis: "既存キーワードが無いため下限の40円" };
    }
    // RPP の仕様：キーワードCPC は商品CPC を1円以上上回る必要がある
    if (itemCpc != null && out.cpc <= itemCpc) { out.cpc = itemCpc + 1; out.basis += `（キーワードCPC は商品CPC ¥${itemCpc.toLocaleString("ja-JP")} より1円以上高くする必要があるので ¥${(itemCpc + 1).toLocaleString("ja-JP")} に）`; }
    out.cpc = Math.min(RPP_MAX_CPC, Math.max(RPP_MIN_CPC, out.cpc));
    // 登録数：一覧の数 ＋ 一覧を読み込んだあとにツールから追加した育成中の語（一覧に無いもの）。一覧が無ければ分かる範囲（レポート＋育成中）
    const inSnap = new Set(item?.keywords.map((k) => k.canon) ?? []);
    const after = gr.filter((g) => !inSnap.has(canonKw("rakuten", g.keyword)) && (!snap.at || g.added_on >= snap.at.slice(0, 10))).length;
    const count = item ? item.keywords.length + after : existing.size;
    // 外してよい語の候補：登録済みで直近60日に注文0、追加して28日以内の育成中は除く。クリックの少ない順
    const { results: perf } = await db.prepare(
      `SELECT LOWER(keyword) AS k, SUM(clicks) AS clicks, SUM(orders) AS orders FROM daily_ads
        WHERE case_id = ? AND mall = 'rakuten' AND level = 'keyword' AND external_id = ? AND date >= ? GROUP BY LOWER(keyword)`
    ).bind(caseId, num, since).all<{ k: string; clicks: number; orders: number }>();
    const pf = new Map(perf.map((r) => [canonKw("rakuten", r.k), r]));
    const young = new Set(gr.filter((g) => g.added_on >= jstDay(28)).map((g) => canonKw("rakuten", g.keyword)));
    const removable = (item?.keywords ?? [])
      .filter((k) => n(pf.get(k.canon)?.orders) === 0 && !young.has(k.canon))
      .map((k) => ({ keyword: k.keyword, canon: k.canon, clicks: n(pf.get(k.canon)?.clicks), cpc: k.cpc ?? 0 }))
      .sort((a, b) => a.clicks - b.clicks || b.cpc - a.cpc);
    const v: RakStart = { ...out, existing, count, known: !!item, removable, used: 0, removed: new Set<string>() };
    startCache.set(num, v);
    return v;
  };

  // Amazon：広告グループの既存キーワードの入札（キーワードごとに最新）の中央値
  const latestMedian = (rows: Array<{ k: string; bid: number }>) => {
    const latest = new Map<string, number>();
    for (const r of rows) if (!latest.has(r.k)) latest.set(r.k, n(r.bid));
    const m = median([...latest.values()]);
    return m == null ? null : { value: m, n: latest.size };
  };
  const amazonGroupMedian = async (groups: Array<{ campaign: string; adGroup: string }>) => {
    if (!groups.length) return null;
    const { results } = await db.prepare(
      `SELECT campaign || char(9) || ad_group || char(9) || LOWER(keyword) || char(9) || match_type AS k, bid FROM daily_ads
        WHERE case_id = ? AND mall = 'amazon' AND level = 'keyword' AND keyword <> '' AND bid IS NOT NULL AND date >= ?
          AND (${groups.map(() => "(campaign = ? AND ad_group = ?)").join(" OR ")})
        ORDER BY date DESC`
    ).bind(caseId, since, ...groups.flatMap((g) => [g.campaign, g.adGroup])).all<{ k: string; bid: number }>();
    const m = latestMedian(results);
    return m ? { ...m, scope: "関連商品の広告グループ" } : null;
  };
  let caseMedianCache: { value: number; n: number; scope: string } | null | undefined;
  const amazonCaseMedian = async () => {
    if (caseMedianCache !== undefined) return caseMedianCache;
    const { results } = await db.prepare(
      `SELECT campaign || char(9) || ad_group || char(9) || LOWER(keyword) || char(9) || match_type AS k, bid FROM daily_ads
        WHERE case_id = ? AND mall = 'amazon' AND level = 'keyword' AND keyword <> '' AND bid IS NOT NULL AND date >= ? ORDER BY date DESC`
    ).bind(caseId, jstDay(30)).all<{ k: string; bid: number }>();
    const m = latestMedian(results);
    caseMedianCache = m ? { ...m, scope: "この案件の" } : null;
    return caseMedianCache;
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
      const orders = st.reduce((t, r) => t + n(r.orders), 0);
      // 関連商品の広告グループにある既存キーワードの入札（キーワードごとに最新）の中央値。無ければ案件全体
      const med = (await amazonGroupMedian(groups.slice(0, 15))) ?? (await amazonCaseMedian());
      if (orders > 0 && clicks > 0 && cost > 0) {
        base.bid = Math.max(2, Math.round(cost / clicks));
        base.bidBasis = `検索語で売れたときのクリック単価（直近60日・${clicks}クリック・${orders}注文）`;
        base.grow = false;
      } else if (med != null) {
        base.bid = Math.max(2, Math.round(med.value * RPP_START_RATIO));
        base.bidBasis = `${med.scope}の既存キーワード ${med.n}件の入札の中央値 ¥${Math.round(med.value).toLocaleString("ja-JP")} × ${Math.round(RPP_START_RATIO * 100)}%（育成中）`;
        base.grow = true;
      } else {
        base.bid = null; base.bidBasis = "入札を決められません（既存のキーワードの入札がありません）";
      }
      // 推奨入札は参考だけ。今の入札の10倍以上・1万円以上は単位のずれを疑う
      base.recoBid = reco?.b != null && n(reco.b) > 0 ? Math.round(n(reco.b)) : null;
      base.recoNote = base.recoBid != null && (base.recoBid >= 10000 || (med != null && base.recoBid > med.value * 10))
        ? "今の入札より桁違いに高いため、単位がずれている可能性があります（「Amazon の推奨を取り直す」で取り直してください）" : null;
      if (!groups.length) base.problem = "関連商品の広告グループが見つかりません（入れる先を手で決めてください）";
    } else {
      // 関連する商品ページ。検索語で売れた語は売れた商品の順（キーワードとの関係が強い順）、推奨などは楽天の売上の順
      let nums = [...new Set(p.productIds.flatMap((id) => numsOf.get(id) ?? []))];
      // 売上が同じなら、登録に空きのあるページを先に（入れ替えを減らす）
      const kwCount = (num: string) => snap.items.get(num)?.keywords.length ?? 0;
      if (!/売れた語|売上あり/.test(p.source ?? "")) nums = [...nums].sort((a, b) => (pageRev.get(b) ?? 0) - (pageRev.get(a) ?? 0) || kwCount(a) - kwCount(b));
      // 自社の複数の商品ページに同じ語を登録すると、枠（1商品20個）を使い成績も分かれるので、既定は一番売れている1ページだけ。
      // RPP は登録していない語にも商品CPC で表示されるので、全ページに登録する必要は薄い。担当者が選べば複数ページにも入れる
      const chosen = p.pages ? p.pages.filter((x) => nums.includes(x)) : null;
      const rows: NonNullable<ResolvedPlan["rows"]> = [];
      const already: string[] = [];
      const full: string[] = [];
      const options: NonNullable<ResolvedPlan["pageOptions"]> = [];
      for (const num of nums.slice(0, 10)) {
        const s0 = await rakutenStart(num);
        options.push({ num, registered: s0.existing.has(canonKw("rakuten", p.keyword)), slots: s0.known ? `${s0.count}/${RPP_KW_LIMIT}` : null, selected: false });
      }
      // 既定：どこかのページに登録済みなら追加しない。まだなら、上から1ページ（枠がいっぱいで入れ替えもできないページは飛ばす）
      const anyRegistered = options.some((o) => o.registered);
      for (const num of nums.slice(0, 10)) {
        if (chosen ? !chosen.includes(num) : (anyRegistered || rows.length >= 1)) { if (options.find((o) => o.num === num)?.registered) already.push(num); continue; }
        const s = await rakutenStart(num);
        if (s.existing.has(canonKw("rakuten", p.keyword))) { already.push(num); continue; }
        // 登録の上限（1商品20個）。いっぱいなら、外してよい語と入れ替える（d 行＋n 行）
        const used = s.count + s.used - s.removed.size;
        let remove: { keyword: string; reason: string } | undefined;
        if (used >= RPP_KW_LIMIT) {
          const r = s.removable.find((x) => !s.removed.has(x.canon));
          if (!r) { full.push(num); continue; }
          s.removed.add(r.canon);
          remove = { keyword: r.keyword, reason: `直近60日の注文0・クリック ${r.clicks}` };
        }
        s.used++;
        rows.push({ externalId: num, cpc: s.cpc, basis: s.basis, slots: s.known ? `${Math.min(used, RPP_KW_LIMIT)}/${RPP_KW_LIMIT}` : null, remove });
      }
      for (const o of options) o.selected = rows.some((r) => r.externalId === o.num);
      base.rows = rows;
      base.pageOptions = options;
      if (!nums.length) base.problem = p.productIds.length ? "関連商品の楽天の商品ページ（商品管理番号）が商品マスタにありません" : "関連商品が分からないため、楽天の商品ページを決められません";
      else if (!rows.length && full.length) base.problem = `登録が上限（${RPP_KW_LIMIT}個）で、外してよい語がありません（どれも直近60日に注文あり、または追加して28日以内）：${full.join("・")}。入れ替える語を手で決めてください`;
      else if (!rows.length) base.problem = `すでに登録済みです（同じ扱いの表記を含む）：${already.join("・")}`;
      else if (full.length) base.problem = `${full.join("・")} は登録が上限で、外してよい語が無いため入れません`;
    }
    out.push(base);
  }
  return out;
}

/**
 * 書き出して対応済みにした：計画から外し、育成中に入れる
 *   楽天：rows ＝ 商品ページ（商品管理番号）ごとの行／Amazon：rows ＝ 入れた広告グループ（ID・キャンペーン名・広告グループ名）。育成しない語は rows なし
 */
export async function finishPlan(db: D1Database, caseId: string, mall: string, keyword: string,
  rows: Array<{ externalId: string; cpc: number; campaign?: string; adGroup?: string; remove?: string | null }> | undefined, by: string | null) {
  await removePlan(db, caseId, mall, keyword);
  if (!["rakuten", "amazon"].includes(mall) || !rows?.length) return;
  const today = jstDay(0), kw = keyword.normalize("NFKC").trim().replace(/\s+/g, " ");
  // 楽天：登録キーワード一覧にも反映（追加した語・入れ替えで外した語）。外した語が育成中なら育成もやめる
  if (mall === "rakuten") for (const r of rows.slice(0, 20)) {
    await applyRppChanges(db, caseId, String(r.externalId), { keyword: kw, cpc: Number(r.cpc) }, r.remove ?? null);
    if (r.remove) await db.prepare("DELETE FROM kw_grow WHERE case_id = ? AND mall = 'rakuten' AND external_id = ? AND keyword = ?")
      .bind(caseId, String(r.externalId), r.remove).run().catch(() => undefined);
  }
  await db.batch(rows.slice(0, 20).map((r) => db.prepare(
    `INSERT INTO kw_grow (case_id, mall, external_id, keyword, start_bid, bid, changed_on, added_on, added_by, campaign, ad_group)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(case_id, mall, external_id, keyword) DO UPDATE SET start_bid = excluded.start_bid, bid = excluded.bid,
       changed_on = excluded.changed_on, added_on = excluded.added_on, added_by = excluded.added_by,
       campaign = excluded.campaign, ad_group = excluded.ad_group`
  ).bind(caseId, mall, String(r.externalId), kw, Math.round(n(r.cpc)), Math.round(n(r.cpc)), today, today, by,
    r.campaign ?? null, r.adGroup ?? null)));
}

/** 育成中のキーワードの入札を上げた（一括ファイルを対応済みにしたとき） */
export async function growBidChanged(db: D1Database, caseId: string, mall: string, externalId: string, keyword: string, bid: number) {
  await db.prepare("UPDATE kw_grow SET bid = ?, changed_on = ? WHERE case_id = ? AND mall = ? AND external_id = ? AND keyword = ?")
    .bind(Math.round(bid), jstDay(0), caseId, mall, externalId, keyword).run().catch(() => undefined);
}

export interface GrowRow {
  mall: "amazon" | "rakuten";
  /** 楽天：商品管理番号／Amazon：広告グループID */
  externalId: string; keyword: string;
  /** Amazon：入れた先（名前。広告レポートと突き合わせる） */
  campaign: string | null; adGroup: string | null; startBid: number; bid: number; changedOn: string; addedOn: string; addedBy: string | null;
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
    // 楽天は商品管理番号、Amazon はキャンペーン名・広告グループ名・完全一致で広告レポートと突き合わせる
    const match = `a.case_id = g.case_id AND a.mall = g.mall AND a.level = 'keyword' AND LOWER(a.keyword) = LOWER(g.keyword)
      AND ((g.mall = 'rakuten' AND a.external_id = g.external_id)
        OR (g.mall = 'amazon' AND a.campaign = g.campaign AND a.ad_group = g.ad_group AND LOWER(a.match_type) LIKE '%exact%'))`;
    ({ results: rows } = await db.prepare(
      `SELECT g.mall, g.external_id, g.keyword, g.campaign, g.ad_group, g.start_bid, g.bid, g.changed_on, g.added_on, g.added_by,
              (SELECT COALESCE(SUM(a.clicks), 0) FROM daily_ads a WHERE ${match} AND a.date >= g.changed_on) AS clicks,
              (SELECT COALESCE(SUM(a.orders), 0) FROM daily_ads a WHERE ${match} AND a.date >= g.changed_on) AS orders,
              (SELECT COALESCE(SUM(a.cost), 0) FROM daily_ads a WHERE ${match} AND a.date >= g.changed_on) AS cost,
              (SELECT a.bid || '|' || a.date FROM daily_ads a WHERE ${match} AND a.bid IS NOT NULL ORDER BY a.date DESC LIMIT 1) AS rb
         FROM kw_grow g WHERE g.case_id = ? ORDER BY g.added_on DESC`
    ).bind(caseId).all<Record<string, string | number | null>>());
  } catch {
    return [];
  }
  const today = jstDay(0);
  return rows.map((r) => {
    const [rb, rd] = r.rb == null ? [null, null] : String(r.rb).split("|");
    return {
      mall: r.mall === "amazon" ? "amazon" : "rakuten",
      externalId: String(r.external_id), keyword: String(r.keyword), campaign: r.campaign == null ? null : String(r.campaign), adGroup: r.ad_group == null ? null : String(r.ad_group),
      startBid: n(r.start_bid), bid: n(r.bid),
      changedOn: String(r.changed_on), addedOn: String(r.added_on), addedBy: r.added_by == null ? null : String(r.added_by),
      clicksSince: n(r.clicks), ordersSince: n(r.orders), costSince: n(r.cost),
      reportBid: rb == null ? null : n(rb), reportDate: rd ?? null, daysSince: daysBetween(String(r.changed_on), today),
    };
  });
}
