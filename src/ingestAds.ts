/**
 * 広告レポートの保存と、取り込み状況の把握
 *
 * 楽天の商品別・キーワード別レポートは1回の操作で1日分しか落とせない。
 * なので「どの日が入っていて、どの日が抜けているか」が見えることが大事になる。
 * 抜けを見せないと、気づかないまま分析が歪む。
 */

import { unzipSync } from "fflate";
import { parseAdFile, decodeCsv, levelLabel, type AdLevel, type AdRow, type SearchTermRow, type ParsedAdFile } from "./adImport";

export interface AdsEnv {
  DB: D1Database;
  FILES: R2Bucket;
}

export interface ImportResult {
  fileName: string;
  ok: boolean;
  mall: string;
  level: string;
  periodStart: string;
  periodEnd: string;
  rows: number;
  unknown: string[];
  message: string;
}

/** 商品管理番号 / SKU → 商品ID */
async function listingMap(db: D1Database, caseId: string, mall: string): Promise<Map<string, string>> {
  const { results } = await db
    .prepare(
      `SELECT l.external_id AS ext, l.product_id FROM product_listings l
         JOIN products p ON p.id = l.product_id
        WHERE l.mall = ? AND p.case_id = ?`
    )
    .bind(mall, caseId)
    .all<{ ext: string; product_id: string }>();
  // 楽天で1つの商品管理番号に複数の商品（SKU ごとの別商品）があるときは、どれか1つに決められないので
  // 商品を付けずに残す（商品ごとの広告費は adProducts.ts で売上の比率に按分する）
  const count = new Map<string, Set<string>>();
  for (const r of results) count.set(r.ext, (count.get(r.ext) ?? new Set()).add(r.product_id));
  return new Map(results.filter((r) => count.get(r.ext)!.size === 1).map((r) => [r.ext, r.product_id]));
}

/** 1ファイルを取り込む。同じ日・同じ種類のものは入れ直すので、二重にならない */
export async function importAdFile(
  env: AdsEnv,
  caseId: string,
  fileName: string,
  bytes: ArrayBuffer
): Promise<ImportResult> {
  const parsed = parseAdFile(decodeCsv(bytes));

  const base: ImportResult = {
    fileName, ok: false, mall: parsed.mall, level: parsed.label,
    periodStart: parsed.periodStart, periodEnd: parsed.periodEnd, rows: 0, unknown: [],
    message: parsed.message,
  };
  if (!parsed.ok) return base;

  // 元ファイルは残す。取り込みを直したときに入れ直せるようにするため
  const r2Key = `raw/${parsed.mall}/ads/${caseId}/${parsed.kind}-${parsed.level}/${parsed.periodStart}_${Date.now()}.csv`;
  await env.FILES.put(r2Key, bytes, { httpMetadata: { contentType: "text/csv" } });

  const saved = await saveParsedAds(env, caseId, parsed, { fileName, r2Key, source: "csv" });
  return { ...base, ok: true, rows: saved.rows, unknown: saved.unknown, message: saved.message };
}

/**
 * ZIP も受け付ける入口。楽天のレポートは ZIP で落ちてくるので、中の CSV を1つずつ取り込む。
 * ZIP でなければ、そのまま1ファイルとして取り込む
 */
export async function importAdUpload(env: AdsEnv, caseId: string, fileName: string, bytes: ArrayBuffer): Promise<ImportResult[]> {
  const u8 = new Uint8Array(bytes);
  const isZip = u8.length > 4 && u8[0] === 0x50 && u8[1] === 0x4b && u8[2] === 0x03 && u8[3] === 0x04;   // "PK\x03\x04"
  if (!isZip) return [await importAdFile(env, caseId, fileName, bytes)];
  // 元の ZIP も残しておく（中身の取り込みを直したときに入れ直せるように）
  await env.FILES.put(`raw/zips/${caseId}/${Date.now()}_${fileName}`, bytes, { httpMetadata: { contentType: "application/zip" } });
  const entries = unzipSync(u8, { filter: (f) => /\.(csv|tsv|txt)$/i.test(f.name) && !f.name.startsWith("__MACOSX/") });
  const names = Object.keys(entries);
  if (!names.length) {
    return [{ fileName, ok: false, mall: "", level: "", periodStart: "", periodEnd: "", rows: 0, unknown: [],
      message: "ZIP の中に CSV が見つかりませんでした" }];
  }
  const out: ImportResult[] = [];
  for (const n of names) {
    const e = entries[n];
    const buf = e.buffer.slice(e.byteOffset, e.byteOffset + e.byteLength) as ArrayBuffer;
    try {
      out.push(await importAdFile(env, caseId, `${fileName} > ${n}`, buf));
    } catch (err) {
      out.push({ fileName: `${fileName} > ${n}`, ok: false, mall: "", level: "", periodStart: "", periodEnd: "", rows: 0, unknown: [],
        message: `読み込みに失敗：${String(err instanceof Error ? err.message : err)}` });
    }
  }
  return out;
}

/**
 * 読み取った広告データを保存する。CSV と API の両方がここを通る。
 * 同じ日・同じ粒度・同じ広告の種類は消してから入れるので、何度入れても二重にならない
 */
export async function saveParsedAds(
  env: AdsEnv,
  caseId: string,
  parsed: Pick<ParsedAdFile, "mall" | "kind" | "level" | "periodStart" | "periodEnd" | "rows" | "terms">,
  meta: {
    fileName: string; r2Key: string | null; source: "csv" | "api";
    /**
     * API用。依頼した期間をまるごと消してから入れる。
     * 配信の無かった日は行が返ってこないので、日ごとに消す方式だと古い値が残ってしまう
     */
    clearRange?: { from: string; to: string; adType: string };
  },
): Promise<{ rows: number; unknown: string[]; message: string }> {
  const fileName = meta.fileName;
  const statements: D1PreparedStatement[] = [];
  const unknown = new Set<string>();
  let count = 0;

  if (parsed.kind === "search_terms") {
    // 検索用語：日 × 広告の種類 で入れ直す
    const keys = meta.clearRange ? new Set<string>() : new Set(parsed.terms.map((t) => `${t.date}\u0000${t.adType}`));
    if (meta.clearRange) {
      statements.push(
        env.DB.prepare("DELETE FROM daily_search_terms WHERE case_id = ? AND mall = ? AND date BETWEEN ? AND ? AND ad_type = ?")
          .bind(caseId, parsed.mall, meta.clearRange.from, meta.clearRange.to, meta.clearRange.adType)
      );
    }
    for (const k of keys) {
      const [date, adType] = k.split("\u0000");
      statements.push(
        env.DB.prepare("DELETE FROM daily_search_terms WHERE case_id = ? AND mall = ? AND date = ? AND ad_type = ?")
          .bind(caseId, parsed.mall, date, adType)
      );
    }
    for (const t of parsed.terms as SearchTermRow[]) {
      statements.push(
        env.DB
          .prepare(
            `INSERT INTO daily_search_terms
               (case_id, mall, date, ad_type, campaign, ad_group, targeting, match_type, search_term, portfolio,
                impressions, clicks, cost, orders, sales, imp_rank, imp_share, attribution_days, source_file)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
             ON CONFLICT(case_id, mall, date, ad_type, campaign, ad_group, targeting, match_type, search_term)
             DO UPDATE SET impressions = impressions + excluded.impressions, clicks = clicks + excluded.clicks,
                           cost = cost + excluded.cost, orders = orders + excluded.orders, sales = sales + excluded.sales`
          )
          .bind(caseId, parsed.mall, t.date, t.adType, t.campaign, t.adGroup, t.targeting, t.matchType,
                t.searchTerm, t.portfolio, t.impressions, t.clicks, t.cost, t.orders, t.sales,
                t.impRank, t.impShare, t.attributionDays, fileName)
      );
    }
    count = parsed.terms.length;
  } else {
    // 広告：日 × 粒度 × 広告の種類 で入れ直す。
    // SP と SB を別々のファイルで入れても、互いを消さないようにするため
    const map = await listingMap(env.DB, caseId, parsed.mall);
    const keys = meta.clearRange ? new Set<string>() : new Set(parsed.rows.map((r) => `${r.date}\u0000${r.adType ?? ""}`));
    if (meta.clearRange) {
      statements.push(
        env.DB.prepare("DELETE FROM daily_ads WHERE case_id = ? AND mall = ? AND date BETWEEN ? AND ? AND level = ? AND ad_type IS ?")
          .bind(caseId, parsed.mall, meta.clearRange.from, meta.clearRange.to, parsed.level, meta.clearRange.adType)
      );
    }
    for (const k of keys) {
      const [date, adType] = k.split("\u0000");
      statements.push(
        env.DB
          .prepare("DELETE FROM daily_ads WHERE case_id = ? AND mall = ? AND date = ? AND level = ? AND ad_type IS ?")
          .bind(caseId, parsed.mall, date, parsed.level, adType || null)
      );
    }
    for (const r of parsed.rows as AdRow[]) {
      const productId = r.externalId ? map.get(r.externalId) ?? null : null;
      if (r.externalId && !productId) unknown.add(r.externalId);
      statements.push(
        env.DB
          .prepare(
            `INSERT INTO daily_ads
               (case_id, mall, date, level, campaign, ad_group, keyword, match_type, external_id, product_id,
                impressions, clicks, cost, orders, sales, bid, suggested_cpc, new_clicks, new_sales,
                ad_type, portfolio, budget, budget_coverage, attribution_days, source, source_file)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
             ON CONFLICT(case_id, mall, date, level, campaign, ad_group, keyword, match_type, external_id)
             DO UPDATE SET impressions = impressions + excluded.impressions, clicks = clicks + excluded.clicks,
                           cost = cost + excluded.cost, orders = orders + excluded.orders, sales = sales + excluded.sales`
          )
          .bind(
            caseId, parsed.mall, r.date, r.level, r.campaign, r.adGroup, r.keyword, r.matchType,
            r.externalId, productId, r.impressions, r.clicks, r.cost, r.orders, r.sales,
            r.bid, r.suggestedCpc, r.newClicks, r.newSales,
            r.adType ?? null, r.portfolio ?? null, r.budget ?? null, r.budgetCoverage ?? null,
            r.attributionDays ?? null, meta.source, fileName
          )
      );
    }
    count = parsed.rows.length;
  }

  // 大きいファイルでも D1 の1回あたりの上限に当たらないよう、分けて流す（先頭は削除文）
  for (let i = 0; i < statements.length; i += 400) await env.DB.batch(statements.slice(i, i + 400));

  await env.DB.prepare(
    `INSERT INTO ad_files (id, case_id, mall, level, period_start, period_end, rows, file_name, r2_key)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).bind(crypto.randomUUID(), caseId, parsed.mall,
         parsed.kind === "search_terms" ? "search_term" : parsed.level,
         parsed.periodStart, parsed.periodEnd, count, fileName, meta.r2Key).run();

  const days = new Set((parsed.kind === "search_terms" ? parsed.terms : parsed.rows).map((r) => r.date)).size;
  const note = unknown.size
    ? `商品マスタに無い番号が ${unknown.size} 件：${[...unknown].slice(0, 5).join(", ")}`
    : "";
  return {
    rows: count, unknown: [...unknown],
    message: `${count}行 / ${days}日分を取り込みました${note ? `（${note}）` : ""}`,
  };
}

/* ───────── 取り込み状況 ───────── */

export interface Coverage {
  key: string;
  label: string;
  days: Array<{ date: string; rows: number }>;
  missing: string[];
}

const MALL_JA: Record<string, string> = { amazon: "Amazon", rakuten: "楽天" };
const TYPE_JA: Record<string, string> = { sp: "SP", sb: "SB", sd: "SD", rpp: "RPP" };

/**
 * 直近 n 日について、種類ごとにどの日が入っているかを返す。
 * 一度でも取り込んだことのある種類だけを並べる（使っていない種類を「全部抜け」と出さないため）
 */
export async function adCoverage(db: D1Database, caseId: string, days = 30): Promise<Coverage[]> {
  const today = new Date(Date.now() + 9 * 3600 * 1000);
  const wanted: string[] = [];
  for (let i = days; i >= 1; i--) {
    wanted.push(new Date(today.getTime() - i * 86400000).toISOString().slice(0, 10));
  }

  // 一度でも入ったことのある種類
  const { results: kindsAds } = await db
    .prepare("SELECT DISTINCT mall, level, COALESCE(ad_type, '') AS ad_type FROM daily_ads WHERE case_id = ?")
    .bind(caseId)
    .all<{ mall: string; level: AdLevel; ad_type: string }>();
  const { results: kindsTerms } = await db
    .prepare("SELECT DISTINCT mall, ad_type FROM daily_search_terms WHERE case_id = ?")
    .bind(caseId)
    .all<{ mall: string; ad_type: string }>();

  const { results: adsDays } = await db
    .prepare(
      `SELECT mall, level, COALESCE(ad_type, '') AS ad_type, date, COUNT(*) AS rows FROM daily_ads
        WHERE case_id = ? AND date >= ? GROUP BY mall, level, ad_type, date`
    )
    .bind(caseId, wanted[0])
    .all<{ mall: string; level: string; ad_type: string; date: string; rows: number }>();
  const { results: termDays } = await db
    .prepare(
      `SELECT mall, ad_type, date, COUNT(*) AS rows FROM daily_search_terms
        WHERE case_id = ? AND date >= ? GROUP BY mall, ad_type, date`
    )
    .bind(caseId, wanted[0])
    .all<{ mall: string; ad_type: string; date: string; rows: number }>();

  const out: Coverage[] = [];
  const build = (key: string, label: string, hits: Map<string, number>) => {
    out.push({
      key, label,
      days: wanted.map((d) => ({ date: d, rows: hits.get(d) ?? 0 })),
      missing: wanted.filter((d) => !hits.has(d)),
    });
  };

  const order = (m: string) => (m === "rakuten" ? 1 : 0);
  for (const k of kindsAds.sort((a, b) => order(a.mall) - order(b.mall) || a.level.localeCompare(b.level))) {
    const hits = new Map<string, number>();
    for (const d of adsDays) {
      if (d.mall === k.mall && d.level === k.level && d.ad_type === k.ad_type) hits.set(d.date, d.rows);
    }
    const t = k.ad_type && k.mall === "amazon" ? ` ${TYPE_JA[k.ad_type] ?? k.ad_type}` : "";
    build(`ads:${k.mall}:${k.level}:${k.ad_type}`,
      `${MALL_JA[k.mall] ?? k.mall}${t} ${levelLabel(k.level)}`, hits);
  }
  for (const k of kindsTerms) {
    const hits = new Map<string, number>();
    for (const d of termDays) {
      if (d.mall === k.mall && d.ad_type === k.ad_type) hits.set(d.date, d.rows);
    }
    build(`terms:${k.mall}:${k.ad_type}`,
      `${MALL_JA[k.mall] ?? k.mall} ${TYPE_JA[k.ad_type] ?? k.ad_type} 検索用語`, hits);
  }
  return out;
}

/* ───────── 集計 ───────── */

export type SummaryLevel = AdLevel | "search_term";

/**
 * 粒度を1つに絞って期間を合計する。
 * 混ぜると同じ費用を何度も数えるので、必ず level で絞る。
 * モールと帰属期間が違うものは ROAS の意味が違うので、行を分けて返す
 */
export async function adSummary(
  db: D1Database,
  caseId: string,
  level: SummaryLevel,
  from: string,
  to: string
): Promise<unknown[]> {
  if (level === "search_term") {
    const { results } = await db
      .prepare(
        `SELECT t.search_term AS name, t.mall, t.ad_type, MAX(t.attribution_days) AS attribution_days,
                SUM(t.impressions) AS impressions, SUM(t.clicks) AS clicks, SUM(t.cost) AS cost,
                SUM(t.orders) AS orders, SUM(t.sales) AS sales,
                ROUND(AVG(t.imp_share), 1) AS imp_share, MIN(t.imp_rank) AS imp_rank,
                COUNT(DISTINCT t.targeting) AS targets
           FROM daily_search_terms t
          WHERE t.case_id = ? AND t.date BETWEEN ? AND ?
          GROUP BY t.search_term, t.mall, t.ad_type
          ORDER BY cost DESC
          LIMIT 300`
      )
      .bind(caseId, from, to)
      .all();
    return results;
  }

  const nameExpr = level === "campaign" ? "a.campaign"
    : level === "placement" ? "a.campaign || ' ／ ' || a.ad_group"
    : level === "keyword" ? "a.keyword"
    : "a.external_id";
  const groupBy = level === "campaign" ? "a.campaign"
    : level === "placement" ? "a.campaign, a.ad_group"
    : level === "keyword" ? "a.keyword, a.external_id"
    : "a.external_id";

  const { results } = await db
    .prepare(
      `SELECT ${nameExpr} AS name, a.external_id, a.mall, a.ad_type,
              MAX(a.attribution_days) AS attribution_days,
              p.sku, p.name AS product_name,
              SUM(a.clicks) AS clicks, SUM(a.cost) AS cost,
              SUM(a.orders) AS orders, SUM(a.sales) AS sales,
              SUM(a.impressions) AS impressions,
              MAX(a.bid) AS bid, MAX(a.suggested_cpc) AS suggested_cpc,
              SUM(a.new_clicks) AS new_clicks,
              MAX(a.budget) AS budget, ROUND(AVG(a.budget_coverage), 1) AS budget_coverage
         FROM daily_ads a
         LEFT JOIN products p ON p.id = a.product_id
        WHERE a.case_id = ? AND a.level = ? AND a.date BETWEEN ? AND ?
        GROUP BY a.mall, COALESCE(a.ad_type, ''), ${groupBy}
        ORDER BY cost DESC`
    )
    .bind(caseId, level, from, to)
    .all();
  return results;
}
