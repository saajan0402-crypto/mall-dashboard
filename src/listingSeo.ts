/**
 * 商品ページの文章（商品名・説明文・検索キーワード）と、そこに入れるとよいキーワードの提案
 *
 * 取得（読むだけ。モールへは書き込まない）
 *   - Amazon：SP-API カタログ（/catalog/2022-04-01/items/{ASIN}、attributes）で商品名・箇条書き・商品説明。
 *     接続にセラーIDが入っていれば、出品情報（/listings/2021-08-01/items/{sellerId}/{SKU}）から「検索キーワード」（generic_keyword）も
 *   - 楽天：商品API 2.0 の items.search（無料）で商品名・キャッチコピー・商品説明文（PC／スマホ）・販売説明文
 *   - 1日1回（5分ごとの実行で1案件ずつ）＋画面の「取り直す」＋提案を「反映済み」にしたとき（反映されたかの確認）
 * 提案（コードで判定）
 *   - その商品で成果の出ている語（Amazon：検索語で注文がある語・完全一致で注文のあるキーワード／楽天：RPP のキーワードで注文がある語）と、
 *     キーワード発見の候補（Amazon の推奨）のうち、商品ページの文章に入っていない語
 *   - 判定は語を空白で区切り、すべての部分が文章のどこかにあれば「入っている」（NFKC・小文字・空白を無視）
 *   - 注文の多い語は「商品名に」、それ以外は「検索キーワード（Amazon）／商品説明文（楽天）に」
 *   - 「反映済み」「今はしない」は todo_status の seo:… に載る（対応の記録・レポートに出る）
 */

import { readCreds, type ConnEnv } from "./connections";
import { accessToken, spapi, errorMessage, JP_MARKETPLACE, type LwaEnv } from "./amazon";
import { rms, type RmsCreds } from "./rakuten";
import { canonKw, toHira } from "./kwNorm";

export interface SeoEnv extends ConnEnv, LwaEnv {}

const n = (v: unknown) => Number(v ?? 0);
const jstDay = (d: number) => new Date(Date.now() + 9 * 3600000 - d * 86400000).toISOString().slice(0, 10);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** 判定用：NFKC・小文字・空白と記号を詰める */
const squash = (s: string) => toHira(s.normalize("NFKC").toLowerCase()).replace(/[\s　・、。,.\-_/／|｜【】\[\]()（）「」『』!！?？:：;；"'`~〜]+/g, "");
const normKw = (s: string) => s.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
const stripHtml = (s: string) => s.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");

export const seoKey = (mall: string, externalId: string, keyword: string) => `seo:${mall}:${externalId}:${normKw(keyword)}`;

export interface ListingContent {
  mall: string; externalId: string; title: string | null; tagline: string | null;
  bullets: string[]; description: string | null; searchTerms: string | null; fetchedAt: string | null; error: string | null;
}

async function save(db: D1Database, caseId: string, c: Omit<ListingContent, "fetchedAt">) {
  await db.prepare(
    `INSERT INTO listing_content (case_id, mall, external_id, title, tagline, bullets, description, search_terms, error, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(case_id, mall, external_id) DO UPDATE SET
       title = COALESCE(excluded.title, listing_content.title), tagline = COALESCE(excluded.tagline, listing_content.tagline),
       bullets = COALESCE(excluded.bullets, listing_content.bullets), description = COALESCE(excluded.description, listing_content.description),
       search_terms = COALESCE(excluded.search_terms, listing_content.search_terms), error = excluded.error, fetched_at = excluded.fetched_at`
  ).bind(caseId, c.mall, c.externalId, c.title, c.tagline, c.bullets.length ? JSON.stringify(c.bullets) : null, c.description, c.searchTerms, c.error).run();
}

const attrVals = (attrs: Record<string, unknown> | undefined, key: string): string[] =>
  (((attrs ?? {})[key] as Array<{ value?: unknown; language_tag?: string }> | undefined) ?? [])
    .filter((x) => !x.language_tag || /^ja/i.test(x.language_tag)).map((x) => String(x.value ?? "")).filter(Boolean);

/** 1案件ぶんの商品ページの文章を取り直す */
export async function refreshListingContent(env: SeoEnv, caseId: string, only?: { mall: string; externalId: string }): Promise<{ ok: number; errors: string[] }> {
  const errors: string[] = [];
  let ok = 0;
  const { results: ls } = await env.DB.prepare(
    `SELECT l.mall, l.external_id, l.asin FROM product_listings l JOIN products p ON p.id = l.product_id
      WHERE p.case_id = ? AND p.status = 'active'`
  ).bind(caseId).all<{ mall: string; external_id: string; asin: string | null }>();

  // Amazon（ASIN ごと。SKU はセラーIDがあるときの検索キーワード用）
  const amz = new Map<string, string>();     // ASIN → SKU
  for (const l of ls) if (l.mall === "amazon" && l.asin) amz.set(String(l.asin).trim().toUpperCase(), String(l.external_id).trim());
  const wantAmz = [...amz.entries()].filter(([asin]) => !only || (only.mall === "amazon" && only.externalId.toUpperCase() === asin));
  if (wantAmz.length) {
    const creds = await readCreds(env, caseId, "amazon");
    const token = creds?.refresh_token ? await accessToken(env, creds.refresh_token).catch((e) => { errors.push(`Amazon：${String(e).slice(0, 100)}`); return null; }) : null;
    const sellerId = creds?.seller_id?.trim() || null;
    if (token) for (const [asin, sku] of wantAmz.slice(0, 40)) {
      let r = await spapi(token, `/catalog/2022-04-01/items/${asin}?marketplaceIds=${JP_MARKETPLACE}&includedData=attributes,summaries&locale=ja_JP`);
      if (r.status === 429) { await sleep(2000); r = await spapi(token, `/catalog/2022-04-01/items/${asin}?marketplaceIds=${JP_MARKETPLACE}&includedData=attributes,summaries&locale=ja_JP`); }
      if (!r.ok) { errors.push(`Amazon ${asin}：${r.status} ${errorMessage(r.body)}`); await save(env.DB, caseId, { mall: "amazon", externalId: asin, title: null, tagline: null, bullets: [], description: null, searchTerms: null, error: `${r.status} ${errorMessage(r.body)}`.slice(0, 300) }); continue; }
      const b = (r.body ?? {}) as { attributes?: Record<string, unknown>; summaries?: Array<{ itemName?: string }> };
      let attrs = b.attributes;
      let searchTerms: string | null = null;
      // セラーIDがあれば自社の出品情報（検索キーワードを含む）を優先
      if (sellerId && sku) {
        const lr = await spapi(token, `/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}?marketplaceIds=${JP_MARKETPLACE}&includedData=attributes&issueLocale=ja_JP`);
        if (lr.ok) {
          const la = ((lr.body ?? {}) as { attributes?: Record<string, unknown> }).attributes;
          if (la) { attrs = { ...attrs, ...la }; searchTerms = attrVals(la, "generic_keyword").join(" ") || null; }
        } else errors.push(`Amazon ${sku}（出品情報）：${lr.status} ${errorMessage(lr.body)}`);
        await sleep(300);
      }
      const title = attrVals(attrs, "item_name")[0] ?? b.summaries?.[0]?.itemName ?? null;
      await save(env.DB, caseId, { mall: "amazon", externalId: asin, title, tagline: null, bullets: attrVals(attrs, "bullet_point"),
        description: attrVals(attrs, "product_description").join("\n") || null, searchTerms, error: null });
      ok++;
      await sleep(600);
    }
  }

  // 楽天（商品管理番号ごと。items.search で店舗の商品を全件めくる）
  const rakNums = new Set(ls.filter((l) => l.mall === "rakuten").map((l) => String(l.external_id).trim()));
  if (rakNums.size && (!only || only.mall === "rakuten")) {
    const c = await readCreds(env, caseId, "rakuten");
    if (c?.service_secret && c?.license_key) {
      const creds: RmsCreds = { service_secret: c.service_secret, license_key: c.license_key };
      for (let page = 0; page < 30; page++) {
        const r = await rms(creds, `/2.0/items/search?hits=100&offset=${page * 100}`);
        if (!r.ok) { errors.push(`楽天：${r.status}`); break; }
        const body = r.body as { numFound?: number; results?: unknown[]; items?: unknown[] };
        const list = body.results ?? body.items ?? [];
        for (const el of list) {
          const o = (el && typeof el === "object" ? el : {}) as Record<string, unknown>;
          const it = (typeof o.manageNumber === "string" ? o : Object.values(o).find((v) => v && typeof v === "object" && typeof (v as Record<string, unknown>).manageNumber === "string")) as Record<string, unknown> | undefined;
          if (!it) continue;
          const num = String(it.manageNumber);
          if (!rakNums.has(num) || (only && only.externalId !== num)) continue;
          const pd = (it.productDescription ?? {}) as { pc?: string; sp?: string };
          const desc = [typeof pd === "string" ? pd : pd.pc, typeof pd === "string" ? null : pd.sp, typeof it.salesDescription === "string" ? it.salesDescription : null]
            .filter((x): x is string => !!x).map(stripHtml).join("\n").trim();
          await save(env.DB, caseId, { mall: "rakuten", externalId: num, title: typeof it.title === "string" ? it.title : null,
            tagline: typeof it.tagline === "string" ? it.tagline : null, bullets: [], description: desc || null, searchTerms: null, error: null });
          ok++;
        }
        if (!list.length || (page + 1) * 100 >= n(body.numFound)) break;
        await sleep(400);
      }
    }
  }
  await env.DB.prepare(
    `INSERT INTO app_flags (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).bind(`seo_at:${caseId}`, JSON.stringify({ at: new Date().toISOString(), ok, errors: errors.slice(0, 5) })).run().catch(() => undefined);
  return { ok, errors };
}

/** 5分ごとの実行から：1日1回、1案件ずつ取り直す */
export async function pumpListingContent(env: SeoEnv): Promise<number> {
  const { results: cases } = await env.DB.prepare("SELECT id FROM cases WHERE status = 'active'").all<{ id: string }>();
  for (const c of cases) {
    const f = await env.DB.prepare("SELECT value FROM app_flags WHERE key = ?").bind(`seo_at:${c.id}`).first<{ value: string }>().catch(() => null);
    const at = f?.value ? Date.parse(JSON.parse(f.value).at) : 0;
    if (Date.now() - at < 20 * 3600000) continue;
    await refreshListingContent(env, c.id).catch(() => undefined);
    return 1;
  }
  return 0;
}

export async function listingContents(db: D1Database, caseId: string): Promise<ListingContent[]> {
  const { results } = await db.prepare(
    "SELECT mall, external_id, title, tagline, bullets, description, search_terms, fetched_at, error FROM listing_content WHERE case_id = ?"
  ).bind(caseId).all<Record<string, string | null>>().catch(() => ({ results: [] as Array<Record<string, string | null>> }));
  return results.map((r) => ({ mall: String(r.mall), externalId: String(r.external_id), title: r.title, tagline: r.tagline,
    bullets: (() => { try { return JSON.parse(String(r.bullets ?? "[]")) as string[]; } catch { return []; } })(),
    description: r.description, searchTerms: r.search_terms, fetchedAt: r.fetched_at, error: r.error }));
}

export interface SeoSuggestion {
  key: string; mall: "amazon" | "rakuten"; externalId: string; keyword: string;
  /** title ＝ 商品名に／terms ＝ 検索キーワード（Amazon）・商品説明文（楽天）に */
  where: "title" | "terms";
  orders: number; sales: number; source: string;
  status: "open" | "done" | "skip" | "other";
  /** 反映済みにしたのに、取り直した文章にまだ入っていない */
  notYet: boolean;
}

export interface SeoPage {
  mall: "amazon" | "rakuten"; externalId: string; products: string[];
  content: ListingContent | null;
  suggestions: SeoSuggestion[];
}

/** 商品ページごとの提案 */
export async function seoOverview(db: D1Database, caseId: string): Promise<{ pages: SeoPage[]; fetched: { at: string; ok: number; errors: string[] } | null }> {
  const since = jstDay(60);
  const contents = new Map((await listingContents(db, caseId)).map((c) => [`${c.mall}\u0000${c.externalId}`, c]));
  const { results: ls } = await db.prepare(
    `SELECT l.mall, l.external_id, l.asin, p.id AS pid, p.name FROM product_listings l JOIN products p ON p.id = l.product_id
      WHERE p.case_id = ? AND p.status = 'active'`
  ).bind(caseId).all<{ mall: string; external_id: string; asin: string | null; pid: string; name: string }>();
  const pages = new Map<string, SeoPage & { pids: string[] }>();
  for (const l of ls) {
    const id = l.mall === "amazon" ? String(l.asin ?? "").trim().toUpperCase() : String(l.external_id).trim();
    if (!id || (l.mall !== "amazon" && l.mall !== "rakuten")) continue;
    const k = `${l.mall}\u0000${id}`;
    const pg = pages.get(k) ?? { mall: l.mall as "amazon" | "rakuten", externalId: id, products: [], pids: [], content: contents.get(k) ?? null, suggestions: [] };
    if (!pg.pids.includes(l.pid)) { pg.pids.push(l.pid); pg.products.push(l.name); }
    pages.set(k, pg);
  }

  // 状態（反映済み・今はしない）
  const { results: st } = await db.prepare("SELECT key, status FROM todo_status WHERE case_id = ? AND key LIKE 'seo:%'")
    .bind(caseId).all<{ key: string; status: string }>();
  const stMap = new Map(st.map((r) => [r.key, r.status]));

  // Amazon：検索語（その商品の広告グループ）・キーワードで注文のある語
  const { results: amzTerms } = await db.prepare(
    `SELECT g.product_id AS pid, LOWER(t.search_term) AS kw, SUM(t.orders) AS orders, SUM(t.sales) AS sales
       FROM daily_search_terms t
       JOIN (SELECT DISTINCT campaign, ad_group, product_id FROM daily_ads WHERE case_id = ?1 AND mall = 'amazon' AND level = 'product' AND date >= ?2 AND product_id IS NOT NULL) g
         ON g.campaign = t.campaign AND g.ad_group = t.ad_group
      WHERE t.case_id = ?1 AND t.mall = 'amazon' AND t.date >= ?2 AND t.orders > 0 AND t.search_term NOT GLOB '[bB]0[0-9A-Za-z]*'
      GROUP BY g.product_id, LOWER(t.search_term)`
  ).bind(caseId, since).all<{ pid: string; kw: string; orders: number; sales: number }>();
  // 楽天：RPP のキーワードで注文のある語（商品管理番号ごと）
  const { results: rakKw } = await db.prepare(
    `SELECT external_id AS num, LOWER(keyword) AS kw, SUM(orders) AS orders, SUM(sales) AS sales FROM daily_ads
      WHERE case_id = ? AND mall = 'rakuten' AND level = 'keyword' AND keyword <> '' AND date >= ? AND orders > 0
      GROUP BY external_id, LOWER(keyword)`
  ).bind(caseId, since).all<{ num: string; kw: string; orders: number; sales: number }>();
  // Amazon の推奨（ASIN の商品ごと、上位）
  const { results: reco } = await db.prepare(
    "SELECT product_id AS pid, keyword AS kw, rank FROM kw_reco WHERE case_id = ? AND rank <= 15"
  ).bind(caseId).all<{ pid: string; kw: string; rank: number }>().catch(() => ({ results: [] as Array<{ pid: string; kw: string; rank: number }> }));

  for (const pg of pages.values()) {
    const c = pg.content;
    const corpus = squash([c?.title, c?.tagline, ...(c?.bullets ?? []), c?.description, c?.searchTerms].filter(Boolean).join(" "));
    const titleC = squash(c?.title ?? "");
    const has = (kw: string, text: string) => kw.split(/\s+/).filter(Boolean).every((part) => text.includes(squash(part)));
    const cand = new Map<string, { kw: string; orders: number; sales: number; source: string }>();
    // 表記ゆれ（モールが同じ語とみなすもの）は1つにまとめる
    const add = (kw: string, orders: number, sales: number, source: string) => {
      const k = canonKw(pg.mall, kw);
      if (!k || k.length > 40) return;
      const prev = cand.get(k);
      cand.set(k, prev ? { ...prev, orders: prev.orders + orders, sales: prev.sales + sales } : { kw: normKw(kw), orders, sales, source });
    };
    if (pg.mall === "amazon") {
      for (const t of amzTerms) if (pg.pids.includes(t.pid)) add(t.kw, n(t.orders), n(t.sales), "検索語で注文あり");
      for (const r of reco) if (pg.pids.includes(r.pid)) add(r.kw, 0, 0, "Amazon の推奨");
    } else {
      for (const t of rakKw) if (t.num === pg.externalId) add(t.kw, n(t.orders), n(t.sales), "RPP で注文あり");
    }
    const list = [...cand.values()].sort((a, b) => b.orders - a.orders || b.sales - a.sales).slice(0, 30);
    for (const x of list) {
      const key = seoKey(pg.mall, pg.externalId, x.kw);
      const status = (stMap.get(key) ?? "open") as SeoSuggestion["status"];
      const inTitle = has(x.kw, titleC), inAny = has(x.kw, corpus);
      if (inAny && status === "open") continue;         // すでに入っている
      if (inTitle && status !== "open") continue;      // 反映済みで、商品名にも入った
      const where: SeoSuggestion["where"] = x.orders >= 3 && !inTitle ? "title" : "terms";
      if (inAny && where === "terms") continue;
      pg.suggestions.push({ key, mall: pg.mall, externalId: pg.externalId, keyword: x.kw, where, orders: x.orders, sales: x.sales, source: x.source,
        status, notYet: status === "done" && !!c?.fetchedAt && !inAny });
    }
  }
  const f = await db.prepare("SELECT value FROM app_flags WHERE key = ?").bind(`seo_at:${caseId}`).first<{ value: string }>().catch(() => null);
  return {
    pages: [...pages.values()].map(({ pids: _p, ...rest }) => rest).sort((a, b) => (a.mall === b.mall ? b.suggestions.length - a.suggestions.length : a.mall.localeCompare(b.mall))),
    fetched: f?.value ? JSON.parse(f.value) : null,
  };
}
