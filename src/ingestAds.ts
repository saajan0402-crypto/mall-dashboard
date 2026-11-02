/**
 * 広告レポートの保存と、取り込み状況の把握
 *
 * 楽天の商品別・キーワード別レポートは1回の操作で1日分しか落とせない。
 * なので「どの日が入っていて、どの日が抜けているか」が見えることが大事になる。
 * 抜けを見せないと、気づかないまま分析が歪む。
 */

import { parseAdFile, levelLabel, type AdLevel, type AdRow } from "./adImport";

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
  return new Map(results.map((r) => [r.ext, r.product_id]));
}

/** 1ファイルを取り込む。同じ日・同じ粒度のものは入れ直すので、二重にならない */
export async function importAdFile(
  env: AdsEnv,
  caseId: string,
  fileName: string,
  bytes: ArrayBuffer
): Promise<ImportResult> {
  const { decodeCsv } = await import("./adImport");
  const parsed = parseAdFile(decodeCsv(bytes));

  const base: ImportResult = {
    fileName, ok: false, mall: parsed.mall, level: levelLabel(parsed.level),
    periodStart: parsed.periodStart, periodEnd: parsed.periodEnd, rows: 0, unknown: [],
    message: parsed.message,
  };
  if (!parsed.ok) return base;

  // 元ファイルは残す。取り込みを直したときに入れ直せるようにするため
  const r2Key = `raw/${parsed.mall}/ads/${caseId}/${parsed.level}/${parsed.periodStart}_${Date.now()}.csv`;
  await env.FILES.put(r2Key, bytes, { httpMetadata: { contentType: "text/csv" } });

  const map = await listingMap(env.DB, caseId, parsed.mall);
  const unknown = new Set<string>();
  const dates = [...new Set(parsed.rows.map((r) => r.date))];

  const statements: D1PreparedStatement[] = [];
  for (const date of dates) {
    statements.push(
      env.DB
        .prepare("DELETE FROM daily_ads WHERE case_id = ? AND mall = ? AND date = ? AND level = ?")
        .bind(caseId, parsed.mall, date, parsed.level)
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
              source, source_file)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'csv', ?)`
        )
        .bind(
          caseId, parsed.mall, r.date, r.level, r.campaign, r.adGroup, r.keyword, r.matchType,
          r.externalId, productId, r.impressions, r.clicks, r.cost, r.orders, r.sales,
          r.bid, r.suggestedCpc, r.newClicks, r.newSales, fileName
        )
    );
  }
  await env.DB.batch(statements);

  await env.DB.prepare(
    `INSERT INTO ad_files (id, case_id, mall, level, period_start, period_end, rows, file_name, r2_key)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).bind(crypto.randomUUID(), caseId, parsed.mall, parsed.level,
         parsed.periodStart, parsed.periodEnd, parsed.rows.length, fileName, r2Key).run();

  const note = unknown.size
    ? `商品マスタに無い番号が ${unknown.size} 件：${[...unknown].slice(0, 5).join(", ")}`
    : "";
  return {
    ...base, ok: true, rows: parsed.rows.length, unknown: [...unknown],
    message: `${parsed.rows.length}行 / ${dates.length}日分を取り込みました${note ? `（${note}）` : ""}`,
  };
}

/* ───────── 取り込み状況 ───────── */

export interface Coverage {
  level: AdLevel;
  label: string;
  days: Array<{ date: string; rows: number }>;
  missing: string[];
}

/** 直近 n 日について、粒度ごとにどの日が入っているかを返す */
export async function adCoverage(db: D1Database, caseId: string, days = 30): Promise<Coverage[]> {
  const today = new Date(Date.now() + 9 * 3600 * 1000);
  const wanted: string[] = [];
  for (let i = days; i >= 1; i--) {
    wanted.push(new Date(today.getTime() - i * 86400000).toISOString().slice(0, 10));
  }

  const { results } = await db
    .prepare(
      `SELECT level, date, COUNT(*) AS rows FROM daily_ads
        WHERE case_id = ? AND date >= ? GROUP BY level, date`
    )
    .bind(caseId, wanted[0])
    .all<{ level: AdLevel; date: string; rows: number }>();

  const byLevel = new Map<AdLevel, Map<string, number>>();
  for (const r of results) {
    const m = byLevel.get(r.level) ?? new Map<string, number>();
    m.set(r.date, r.rows);
    byLevel.set(r.level, m);
  }

  return (["campaign", "product", "keyword"] as AdLevel[]).map((level) => {
    const m = byLevel.get(level) ?? new Map<string, number>();
    return {
      level,
      label: levelLabel(level),
      days: wanted.map((d) => ({ date: d, rows: m.get(d) ?? 0 })),
      missing: wanted.filter((d) => !m.has(d)),
    };
  });
}

/* ───────── 集計 ───────── */

/**
 * 粒度を1つに絞って期間を合計する。
 * 混ぜると同じ費用を何度も数えるので、必ず level で絞る
 */
export async function adSummary(
  db: D1Database,
  caseId: string,
  level: AdLevel,
  from: string,
  to: string
): Promise<unknown[]> {
  const groupBy = level === "campaign" ? "a.campaign"
    : level === "keyword" ? "a.keyword, a.external_id"
    : "a.external_id";

  const { results } = await db
    .prepare(
      `SELECT ${level === "campaign" ? "a.campaign AS name, '' AS external_id" :
               level === "keyword" ? "a.keyword AS name, a.external_id" :
               "a.external_id AS name, a.external_id"},
              p.sku, p.name AS product_name,
              SUM(a.clicks) AS clicks, SUM(a.cost) AS cost,
              SUM(a.orders) AS orders, SUM(a.sales) AS sales,
              SUM(a.impressions) AS impressions,
              MAX(a.bid) AS bid, MAX(a.suggested_cpc) AS suggested_cpc,
              SUM(a.new_clicks) AS new_clicks
         FROM daily_ads a
         LEFT JOIN products p ON p.id = a.product_id
        WHERE a.case_id = ? AND a.level = ? AND a.date BETWEEN ? AND ?
        GROUP BY ${groupBy}
        ORDER BY cost DESC`
    )
    .bind(caseId, level, from, to)
    .all();
  return results;
}
