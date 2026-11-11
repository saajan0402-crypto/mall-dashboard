/**
 * キーワード発見
 *
 * 利益ベースの入札の上げ下げだけでは売上が先細るので、新しいキーワードと競合の動きを公式の API で集める。
 * （Amazon の画面を自動で巡回するのは利用規約で禁止されているので、しない）
 *
 *   1. Amazon 広告 API のキーワード推奨：自社 ASIN ごとに Amazon が勧めるキーワードと入札の目安（週1回）
 *   2. 監視キーワードの検索結果（毎日）
 *      - Amazon：SP-API のカタログ検索（キーワードで出てくる ASIN・ブランド・ランキング）
 *      - 楽天：楽天市場の商品検索 API（楽天標準順の上位60件・価格・レビュー・自社の順位）
 *   監視キーワードは画面で足す。何も無い案件は、検索語レポートで売上の多い語を5つ自動で入れる
 */

import { readCreds, type ConnEnv } from "./connections";
import { accessToken, adsAccessToken, adsapi, spapi, errorMessage, JP_MARKETPLACE, type LwaEnv } from "./amazon";

export interface KwEnv extends ConnEnv, LwaEnv {
  /** 楽天ウェブサービス（楽天市場の商品検索 API）のアプリID（UUID）とアクセスキー（pk_…）。全案件共通 */
  RAKUTEN_WS_APP_ID?: string;
  RAKUTEN_WS_ACCESS_KEY?: string;
  /** 楽天ウェブサービスに登録したアプリの URL。Referer として送る（無ければアプリの URL） */
  RAKUTEN_WS_REFERER?: string;
}

const n = (v: unknown) => Number(v ?? 0) || 0;
const jstDay = (offset = 0) => new Date(Date.now() + 9 * 3600000 - offset * 86400000).toISOString().slice(0, 10);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const APP_URL = "https://mall-dashboard.saajan0402.workers.dev/";

/* ───────── 監視キーワード ───────── */

export async function listWatch(db: D1Database, caseId: string): Promise<string[]> {
  const { results } = await db.prepare("SELECT keyword FROM kw_watch WHERE case_id = ? ORDER BY added_at").bind(caseId).all<{ keyword: string }>();
  return results.map((r) => r.keyword);
}

export async function addWatch(db: D1Database, caseId: string, keyword: string, by: string | null) {
  const k = keyword.normalize("NFKC").trim().replace(/\s+/g, " ");
  if (!k) throw new Error("キーワードを入れてください");
  if (k.length > 80) throw new Error("キーワードが長すぎます");
  const c = await db.prepare("SELECT COUNT(*) AS c FROM kw_watch WHERE case_id = ?").bind(caseId).first<{ c: number }>();
  if (n(c?.c) >= 30) throw new Error("監視キーワードは30個までです");
  await db.prepare("INSERT OR IGNORE INTO kw_watch (case_id, keyword, added_by) VALUES (?, ?, ?)").bind(caseId, k, by).run();
}

export async function removeWatch(db: D1Database, caseId: string, keyword: string) {
  await db.batch([
    db.prepare("DELETE FROM kw_watch WHERE case_id = ? AND keyword = ?").bind(caseId, keyword),
    db.prepare("DELETE FROM kw_serp WHERE case_id = ? AND keyword = ?").bind(caseId, keyword),
  ]);
}

/** 監視キーワードが1つも無い案件に、検索語レポートで売上の多い語を入れる */
async function seedWatch(db: D1Database, caseId: string): Promise<void> {
  const has = await db.prepare("SELECT 1 AS x FROM kw_watch WHERE case_id = ? LIMIT 1").bind(caseId).first();
  if (has) return;
  const { results } = await db.prepare(
    `SELECT search_term AS k, SUM(sales) AS s FROM daily_search_terms
      WHERE case_id = ? AND date >= ? AND search_term NOT GLOB '[bB]0[0-9A-Za-z]*' GROUP BY LOWER(search_term) ORDER BY s DESC LIMIT 5`
  ).bind(caseId, jstDay(60)).all<{ k: string }>();
  let keys = results.map((r) => r.k);
  if (!keys.length) {
    const { results: kw } = await db.prepare(
      `SELECT keyword AS k, SUM(sales) AS s FROM daily_ads WHERE case_id = ? AND level = 'keyword' AND keyword <> '' AND date >= ?
        GROUP BY LOWER(keyword) ORDER BY s DESC LIMIT 5`
    ).bind(caseId, jstDay(60)).all<{ k: string }>();
    keys = kw.map((r) => r.k);
  }
  for (const k of keys) await addWatch(db, caseId, k, "自動").catch(() => undefined);
}

/* ───────── 1. Amazon のキーワード推奨 ───────── */

interface RecoItem {
  keyword?: string; keywordText?: string; rank?: number; matchType?: string; bid?: number;
  suggestedBid?: { rangeStart?: number; rangeMedian?: number; rangeEnd?: number };
  bidInfo?: Array<{ matchType?: string; rank?: number; bid?: number; suggestedBid?: { rangeStart?: number; rangeMedian?: number; rangeEnd?: number } }>;
  searchTermImpressionShare?: number; searchTermImpressionRank?: number;
}

async function recoCall(env: KwEnv, token: string, profileId: string, asin: string) {
  const body = { recommendationType: "KEYWORDS_FOR_ASINS", asins: [asin], maxRecommendations: 50, sortDimension: "CONVERSIONS", locale: "ja_JP" };
  // v4（検索語の表示シェアつき）→ 断られたら v3
  for (const v of ["v4", "v3"]) {
    const t = `application/vnd.spkeywordsrecommendation.${v}+json`;
    const r = await adsapi(env, token, "/sp/targets/keywords/recommendations", { method: "POST", body, profileId, accept: t, contentType: t });
    if (r.status === 415 || r.status === 406) continue;
    if (v === "v4" && r.status === 400 && /sortDimension|unrecogni|unknown/i.test(errorMessage(r.body))) continue;
    return r;
  }
  return adsapi(env, token, "/sp/targets/keywords/recommendations", { method: "POST", body: { recommendationType: "KEYWORDS_FOR_ASINS", asins: [asin] }, profileId });
}

/** 自社 ASIN（売上の多い順に10個）ごとにキーワード推奨を取り直す */
export async function refreshAmazonReco(env: KwEnv, caseId: string): Promise<{ ok: boolean; rows: number; message: string }> {
  const creds = await readCreds(env, caseId, "amazon");
  const profileId = creds?.ads_profile_id?.replace(/\s/g, "");
  if (!profileId) return { ok: false, rows: 0, message: "広告APIのプロフィールIDが未登録です" };
  let token: string;
  try { token = await adsAccessToken(env, creds?.ads_refresh_token); } catch (e) { return { ok: false, rows: 0, message: `広告APIのトークン：${String(e).slice(0, 120)}` }; }
  const { results: prods } = await env.DB.prepare(
    `SELECT p.id, l.asin, (SELECT SUM(revenue) FROM daily_sales s WHERE s.product_id = p.id AND s.date >= ?) AS rev
       FROM products p JOIN product_listings l ON l.product_id = p.id AND l.mall = 'amazon'
      WHERE p.case_id = ? AND p.status = 'active' AND l.asin IS NOT NULL AND l.asin <> ''
      ORDER BY rev DESC LIMIT 10`
  ).bind(jstDay(30), caseId).all<{ id: string; asin: string }>();
  if (!prods.length) return { ok: false, rows: 0, message: "商品マスタに ASIN が入った商品がありません" };

  let rows = 0, lastErr = "";
  for (const p of prods) {
    const r = await recoCall(env, token, profileId, p.asin.trim());
    if (!r.ok) { lastErr = `${r.status} ${errorMessage(r.body)}`; await sleep(500); continue; }
    const b = r.body as { keywordTargetList?: RecoItem[]; recommendations?: RecoItem[] } | RecoItem[];
    const list: RecoItem[] = Array.isArray(b) ? b : b.keywordTargetList ?? b.recommendations ?? [];
    const stmts: D1PreparedStatement[] = [env.DB.prepare("DELETE FROM kw_reco WHERE case_id = ? AND product_id = ?").bind(caseId, p.id)];
    list.forEach((it, i) => {
      const kw = (it.keyword ?? it.keywordText ?? "").trim();
      if (!kw) return;
      const bi = (it.bidInfo ?? []).find((x) => /exact/i.test(x.matchType ?? "")) ?? it.bidInfo?.[0];
      const sb = bi?.suggestedBid ?? it.suggestedBid;
      const med = sb?.rangeMedian ?? bi?.bid ?? it.bid ?? null;
      stmts.push(env.DB.prepare(
        `INSERT OR REPLACE INTO kw_reco (case_id, product_id, keyword, rank, match_type, bid_low, bid_median, bid_high, imp_share, imp_rank)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(caseId, p.id, kw, it.rank ?? bi?.rank ?? i + 1, bi?.matchType ?? it.matchType ?? null,
        sb?.rangeStart == null ? null : Math.round(sb.rangeStart), med == null ? null : Math.round(med), sb?.rangeEnd == null ? null : Math.round(sb.rangeEnd),
        it.searchTermImpressionShare ?? null, it.searchTermImpressionRank ?? null));
      rows++;
    });
    await env.DB.batch(stmts);
    await sleep(400);
  }
  await setFlag(env.DB, `kw_reco_at:${caseId}`, JSON.stringify({ at: new Date().toISOString(), rows, error: rows ? null : lastErr || null }));
  return { ok: rows > 0, rows, message: rows ? `${rows}件のキーワード推奨を取得しました` : `取得できませんでした：${lastErr}` };
}

/* ───────── 2. 監視キーワードの検索結果 ───────── */

async function ownIds(db: D1Database, caseId: string) {
  const { results } = await db.prepare(
    `SELECT l.mall, l.external_id, l.asin FROM product_listings l JOIN products p ON p.id = l.product_id WHERE p.case_id = ?`
  ).bind(caseId).all<{ mall: string; external_id: string; asin: string | null }>();
  return {
    asins: new Set(results.filter((r) => r.mall === "amazon" && r.asin).map((r) => String(r.asin).trim().toUpperCase())),
    rakuten: new Set(results.filter((r) => r.mall === "rakuten").map((r) => String(r.external_id).trim().toLowerCase())),
  };
}

interface SerpRow { position: number; itemId: string; title: string; shop: string | null; price: number | null; reviewCount: number | null; reviewAvg: number | null; salesRank: number | null; own: boolean }

async function amazonSerp(token: string, keyword: string, own: Set<string>): Promise<SerpRow[] | string> {
  const qs = new URLSearchParams({ keywords: keyword, marketplaceIds: JP_MARKETPLACE, includedData: "summaries,salesRanks", pageSize: "20", keywordsLocale: "ja_JP" });
  let r = await spapi(token, `/catalog/2022-04-01/items?${qs}`);
  if (r.status === 400 && /keywordsLocale/i.test(errorMessage(r.body))) { qs.delete("keywordsLocale"); r = await spapi(token, `/catalog/2022-04-01/items?${qs}`); }
  if (r.status === 429) { await sleep(2000); r = await spapi(token, `/catalog/2022-04-01/items?${qs}`); }
  if (!r.ok) return `${r.status} ${errorMessage(r.body)}`;
  const items = ((r.body ?? {}) as { items?: Array<Record<string, unknown>> }).items ?? [];
  return items.map((it, i) => {
    const sum = ((it.summaries as Array<Record<string, unknown>>) ?? [])[0] ?? {};
    const sr = ((it.salesRanks as Array<{ classificationRanks?: Array<{ rank?: number }>; displayGroupRanks?: Array<{ rank?: number }> }>) ?? [])[0];
    const ranks = [...(sr?.classificationRanks ?? []), ...(sr?.displayGroupRanks ?? [])].map((x) => n(x.rank)).filter((x) => x > 0);
    const asin = String(it.asin ?? "").toUpperCase();
    return { position: i + 1, itemId: asin, title: String(sum.itemName ?? ""), shop: sum.brand ? String(sum.brand) : null, price: null,
      reviewCount: null, reviewAvg: null, salesRank: ranks.length ? Math.min(...ranks) : null, own: own.has(asin) };
  });
}

async function rakutenSerp(env: KwEnv, keyword: string, own: Set<string>): Promise<SerpRow[] | string> {
  if (!env.RAKUTEN_WS_APP_ID || !env.RAKUTEN_WS_ACCESS_KEY) return "楽天ウェブサービスのアプリIDが未設定です（Cloudflare の RAKUTEN_WS_APP_ID・RAKUTEN_WS_ACCESS_KEY）";
  const ref = env.RAKUTEN_WS_REFERER || APP_URL;
  const out: SerpRow[] = [];
  for (const page of [1, 2]) {
    const qs = new URLSearchParams({ applicationId: env.RAKUTEN_WS_APP_ID, accessKey: env.RAKUTEN_WS_ACCESS_KEY, keyword, hits: "30", page: String(page),
      sort: "standard", format: "json", formatVersion: "2" });
    const res = await fetch(`https://openapi.rakuten.co.jp/ichibams/api/IchibaItem/Search/20220601?${qs}`, {
      headers: { Referer: ref, Origin: new URL(ref).origin, accept: "application/json" },
    });
    const text = await res.text();
    if (!res.ok) return `${res.status} ${text.slice(0, 200)}`;
    let body: { Items?: Array<Record<string, unknown>> } = {};
    try { body = JSON.parse(text); } catch { return "楽天の応答が読めませんでした"; }
    const items = (body.Items ?? []).map((x) => ((x as { Item?: Record<string, unknown> }).Item ?? x));
    items.forEach((it, i) => {
      const code = String(it.itemCode ?? "");
      const manage = code.split(":")[1]?.toLowerCase() ?? "";
      out.push({ position: (page - 1) * 30 + i + 1, itemId: code, title: String(it.itemName ?? "").slice(0, 120), shop: it.shopName ? String(it.shopName) : null,
        price: it.itemPrice == null ? null : n(it.itemPrice), reviewCount: it.reviewCount == null ? null : n(it.reviewCount),
        reviewAvg: it.reviewAverage == null ? null : n(it.reviewAverage), salesRank: null, own: !!manage && own.has(manage) });
    });
    if (items.length < 30) break;
    await sleep(1100);   // 1秒に1回まで
  }
  return out;
}

async function saveSerp(db: D1Database, caseId: string, mall: string, keyword: string, date: string, rows: SerpRow[]) {
  const stmts: D1PreparedStatement[] = [db.prepare("DELETE FROM kw_serp WHERE case_id = ? AND mall = ? AND keyword = ? AND date = ?").bind(caseId, mall, keyword, date)];
  for (const r of rows) stmts.push(db.prepare(
    `INSERT INTO kw_serp (case_id, mall, keyword, date, position, item_id, title, shop, price, review_count, review_avg, sales_rank, own)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(caseId, mall, keyword, date, r.position, r.itemId, r.title, r.shop, r.price, r.reviewCount, r.reviewAvg, r.salesRank, r.own ? 1 : 0));
  await db.batch(stmts);
}

async function setFlag(db: D1Database, key: string, value: string) {
  await db.prepare(`INSERT INTO app_flags (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`).bind(key, value).run();
}
async function getFlag(db: D1Database, key: string): Promise<string | null> {
  return (await db.prepare("SELECT value FROM app_flags WHERE key = ?").bind(key).first<{ value: string }>())?.value ?? null;
}

/** 1つのキーワードを今すぐ調べる（画面の「今すぐ調べる」と、毎日の実行の両方から） */
export async function snapshotKeyword(env: KwEnv, caseId: string, keyword: string, ctx?: { spToken?: string | null; own?: Awaited<ReturnType<typeof ownIds>> }) {
  const date = jstDay(0);
  const own = ctx?.own ?? await ownIds(env.DB, caseId);
  const errors: string[] = [];
  const { results: malls } = await env.DB.prepare("SELECT mall FROM case_malls WHERE case_id = ? AND credentials_enc IS NOT NULL").bind(caseId).all<{ mall: string }>();
  const has = new Set(malls.map((m) => m.mall));
  if (has.has("amazon")) {
    let token = ctx?.spToken ?? null;
    if (!token) {
      const creds = await readCreds(env, caseId, "amazon");
      if (creds?.refresh_token) token = await accessToken(env, creds.refresh_token).catch(() => null);
    }
    if (token) {
      const a = await amazonSerp(token, keyword, own.asins);
      if (typeof a === "string") errors.push(`Amazon：${a}`); else await saveSerp(env.DB, caseId, "amazon", keyword, date, a);
    }
  }
  // 楽天の競合は、楽天に出店していない案件でも参考になるので、アプリIDがあれば調べる
  if (env.RAKUTEN_WS_APP_ID) {
    const r = await rakutenSerp(env, keyword, own.rakuten);
    if (typeof r === "string") errors.push(`楽天：${r}`); else await saveSerp(env.DB, caseId, "rakuten", keyword, date, r);
  }
  return errors;
}

/**
 * 5分ごとの実行から呼ぶ。案件ごとに
 *   監視キーワードが無ければ入れる／今日まだ調べていないキーワードを調べる／キーワード推奨が7日より古ければ取り直す
 */
export async function pumpKeywords(env: KwEnv, opts: { budgetMs?: number } = {}): Promise<number> {
  const deadline = Date.now() + (opts.budgetMs ?? 30000);
  const today = jstDay(0);
  const { results: cases } = await env.DB.prepare("SELECT id FROM cases WHERE status = 'active'").all<{ id: string }>();
  let done = 0;
  for (const c of cases) {
    if (Date.now() > deadline) break;
    await seedWatch(env.DB, c.id).catch(() => undefined);
    const { results: todo } = await env.DB.prepare(
      `SELECT w.keyword FROM kw_watch w WHERE w.case_id = ?
         AND NOT EXISTS (SELECT 1 FROM kw_serp s WHERE s.case_id = w.case_id AND s.keyword = w.keyword AND s.date = ?)`
    ).bind(c.id, today).all<{ keyword: string }>();
    const tried = JSON.parse((await getFlag(env.DB, `kw_tried:${c.id}`)) ?? "{}") as Record<string, string>;
    const pending = todo.filter((t) => tried[t.keyword] !== today);      // 今日失敗したものは明日まで試さない
    if (pending.length) {
      const own = await ownIds(env.DB, c.id);
      const creds = await readCreds(env, c.id, "amazon");
      const spToken = creds?.refresh_token ? await accessToken(env, creds.refresh_token).catch(() => null) : null;
      for (const t of pending) {
        if (Date.now() > deadline) break;
        const errs = await snapshotKeyword(env, c.id, t.keyword, { spToken, own }).catch((e) => [String(e)]);
        tried[t.keyword] = today;
        if (errs.length) await setFlag(env.DB, `kw_error:${c.id}`, JSON.stringify({ at: new Date().toISOString(), keyword: t.keyword, errors: errs }));
        done++;
        await sleep(600);
      }
      await setFlag(env.DB, `kw_tried:${c.id}`, JSON.stringify(tried));
    }
    if (Date.now() > deadline) break;
    const rec = JSON.parse((await getFlag(env.DB, `kw_reco_at:${c.id}`)) ?? "null") as { at: string } | null;
    if (!rec || Date.now() - Date.parse(rec.at) > 7 * 86400000) {
      const hasAds = await env.DB.prepare("SELECT 1 AS x FROM case_malls WHERE case_id = ? AND mall = 'amazon' AND credentials_enc IS NOT NULL").bind(c.id).first();
      if (hasAds) { await refreshAmazonReco(env, c.id).catch(() => undefined); done++; }
    }
  }
  // 90日より古い検索結果は消す
  await env.DB.prepare("DELETE FROM kw_serp WHERE date < ?").bind(jstDay(90)).run().catch(() => undefined);
  return done;
}

/* ───────── 画面用 ───────── */

export async function keywordOverview(db: D1Database, caseId: string) {
  const since = jstDay(60);
  // 入札済みのキーワード・検索語（候補から外す）
  const { results: targeted } = await db.prepare(
    "SELECT DISTINCT LOWER(keyword) AS k FROM daily_ads WHERE case_id = ? AND level = 'keyword' AND keyword <> '' AND date >= ?"
  ).bind(caseId, since).all<{ k: string }>();
  const tset = new Set(targeted.map((t) => t.k.trim()));
  const watch = await listWatch(db, caseId);
  const wset = new Set(watch.map((w) => w.toLowerCase()));

  const { results: reco } = await db.prepare(
    `SELECT r.keyword, MIN(r.rank) AS rank, MAX(r.bid_median) AS bid, MIN(r.bid_low) AS bid_low, MAX(r.bid_high) AS bid_high,
            MAX(r.imp_share) AS imp_share, MIN(r.imp_rank) AS imp_rank, GROUP_CONCAT(DISTINCT p.name) AS products, COUNT(DISTINCT r.product_id) AS np
       FROM kw_reco r LEFT JOIN products p ON p.id = r.product_id WHERE r.case_id = ?
      GROUP BY LOWER(r.keyword) ORDER BY np DESC, rank ASC LIMIT 200`
  ).bind(caseId).all<Record<string, string | number | null>>();

  // 検索語レポートで売れたのに入札していない語
  const { results: terms } = await db.prepare(
    `SELECT search_term AS keyword, SUM(clicks) AS clicks, SUM(cost) AS cost, SUM(orders) AS orders, SUM(sales) AS sales
       FROM daily_search_terms WHERE case_id = ? AND date >= ? AND search_term NOT GLOB '[bB]0[0-9A-Za-z]*'
      GROUP BY LOWER(search_term) HAVING SUM(orders) > 0 ORDER BY SUM(sales) DESC LIMIT 100`
  ).bind(caseId, since).all<Record<string, string | number>>();

  const candidates = [
    ...terms.filter((t) => !tset.has(String(t.keyword).toLowerCase().trim())).map((t) => ({
      keyword: String(t.keyword), source: "検索語で売上あり", products: null as string | null,
      rank: null as number | null, bid: null as number | null, bidRange: null as string | null, impShare: null as number | null,
      orders: n(t.orders), sales: n(t.sales), cost: n(t.cost), roas: n(t.cost) ? Math.round((n(t.sales) / n(t.cost)) * 100) / 100 : null,
      watched: wset.has(String(t.keyword).toLowerCase()) })),
    ...reco.filter((r) => !tset.has(String(r.keyword).toLowerCase().trim())).map((r) => ({
      keyword: String(r.keyword), source: "Amazon の推奨", products: r.products == null ? null : String(r.products),
      rank: r.rank == null ? null : n(r.rank), bid: r.bid == null ? null : n(r.bid),
      bidRange: r.bid_low != null && r.bid_high != null ? `${r.bid_low}〜${r.bid_high}` : null,
      impShare: r.imp_share == null ? null : n(r.imp_share), orders: 0, sales: 0, cost: 0, roas: null,
      watched: wset.has(String(r.keyword).toLowerCase()) })),
  ];
  const seen = new Set<string>();
  const dedup = candidates.filter((c) => { const k = c.keyword.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });

  const recoAt = JSON.parse((await getFlag(db, `kw_reco_at:${caseId}`)) ?? "null");
  const lastError = JSON.parse((await getFlag(db, `kw_error:${caseId}`)) ?? "null");
  return { watch, candidates: dedup.slice(0, 150), recoAt, lastError };
}

/** 監視キーワード1つの最新の検索結果と、自社の順位の推移 */
export async function keywordDetail(db: D1Database, caseId: string, keyword: string) {
  const latest = async (mall: string) => {
    const d = await db.prepare("SELECT MAX(date) AS d FROM kw_serp WHERE case_id = ? AND mall = ? AND keyword = ?").bind(caseId, mall, keyword).first<{ d: string | null }>();
    if (!d?.d) return { date: null, rows: [] as Array<Record<string, unknown>> };
    const { results } = await db.prepare(
      "SELECT position, item_id, title, shop, price, review_count, review_avg, sales_rank, own FROM kw_serp WHERE case_id = ? AND mall = ? AND keyword = ? AND date = ? ORDER BY position"
    ).bind(caseId, mall, keyword, d.d).all<Record<string, unknown>>();
    return { date: d.d, rows: results };
  };
  const { results: history } = await db.prepare(
    `SELECT mall, date, MIN(CASE WHEN own = 1 THEN position END) AS own_pos, COUNT(*) AS n
       FROM kw_serp WHERE case_id = ? AND keyword = ? AND date >= ? GROUP BY mall, date ORDER BY date`
  ).bind(caseId, keyword, jstDay(30)).all<{ mall: string; date: string; own_pos: number | null; n: number }>();
  return { keyword, amazon: await latest("amazon"), rakuten: await latest("rakuten"), history };
}

/** AI 用：キーワード発見の材料を Markdown にする */
export async function keywordMarkdown(db: D1Database, caseId: string): Promise<string> {
  const ov = await keywordOverview(db, caseId);
  const L: string[] = ["## キーワード発見の材料", ""];
  L.push("### 新しいキーワードの候補（まだ入札していない語）", "");
  if (!ov.candidates.length) L.push("（候補なし）");
  else {
    L.push("| キーワード | 出どころ | 関連商品 | 推奨順位 | 推奨入札（中央） | 検索語の注文 | 検索語の売上 |", "| --- | --- | --- | --- | --- | --- | --- |");
    for (const c of ov.candidates.slice(0, 60)) L.push(`| ${c.keyword} | ${c.source} | ${(c.products ?? "—").slice(0, 40)} | ${c.rank ?? "—"} | ${c.bid ?? "—"} | ${c.orders || "—"} | ${c.sales ? "¥" + c.sales.toLocaleString("ja-JP") : "—"} |`);
  }
  L.push("");
  for (const k of ov.watch.slice(0, 8)) {
    const d = await keywordDetail(db, caseId, k);
    L.push(`### 監視キーワード「${k}」の検索結果`, "");
    for (const [mall, x] of [["Amazon（カタログ検索・関連度順）", d.amazon], ["楽天（楽天標準順）", d.rakuten]] as const) {
      if (!x.rows.length) continue;
      L.push(`${mall}・${x.date}：`, "", "| 順位 | 商品 | 店舗／ブランド | 価格 | レビュー | ランキング | 自社 |", "| --- | --- | --- | --- | --- | --- | --- |");
      for (const r of x.rows.slice(0, 12)) L.push(`| ${r.position} | ${String(r.title ?? "").slice(0, 50).replace(/\|/g, "／")} | ${r.shop ?? "—"} | ${r.price ?? "—"} | ${r.review_count ?? "—"}${r.review_avg ? `（${r.review_avg}）` : ""} | ${r.sales_rank ?? "—"} | ${r.own ? "★" : ""} |`);
      const ownRow = x.rows.find((r) => r.own);
      L.push("", `自社の順位：${ownRow ? `${ownRow.position}位` : "上位に無し"}`, "");
    }
  }
  return L.join("\n");
}
