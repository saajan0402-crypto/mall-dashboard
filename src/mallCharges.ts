/**
 * モールの請求明細（実額）
 *
 * 楽天には手数料のAPIが無い。料率からの概算だけだと、
 * 粗利も損益分岐ROASもその料率の精度までしか信用できない。
 * RMSから落とせる請求明細を入れてもらい、その月を実額に置き換える。
 *
 * 請求明細は店舗単位で、商品ごとの内訳は無い。
 * 商品別の粗利を出すには売上で按分するしかないので、
 * 「店舗合計は実額／商品別は按分」であることを必ず残して表示する。
 */

import { decodeCsv, parseCsv } from "./adImport";

export interface ChargeEnv {
  DB: D1Database;
  FILES: R2Bucket;
}

export interface ChargeRow {
  name: string;
  amount: number;
}

export interface ChargeImport {
  ok: boolean;
  fileName: string;
  rows: ChargeRow[];
  total: number;
  message: string;
  /** 自動で読めなかったときに、判断材料として返す */
  headers?: string[];
  sample?: string[][];
}

const toInt = (v: string): number => {
  const s = (v ?? "").replace(/[,¥円\s　]/g, "");
  if (!s) return 0;
  const neg = /^\(.*\)$/.test(s) || s.startsWith("△") || s.startsWith("▲");
  const n = Number(s.replace(/^[(（△▲]|[)）]$/g, ""));
  if (!Number.isFinite(n)) return 0;
  return Math.round(neg ? -n : n);
};

const NAME_KEYS = ["項目", "項目名", "費目", "内容", "明細", "名称", "区分", "請求項目"];
const AMOUNT_KEYS = ["金額", "請求金額", "税込金額", "合計", "合計金額", "税込", "ご請求金額", "金額(税込)"];

/** 見出しの中から、費目の列と金額の列を探す */
function findColumns(header: string[]): { name: number; amount: number } | null {
  const norm = header.map((h) => h.replace(/[（(].*?[）)]/g, "").replace(/\s/g, ""));
  const name = norm.findIndex((h) => NAME_KEYS.some((k) => h.includes(k)));
  const amount = norm.findIndex((h) => AMOUNT_KEYS.some((k) => h.includes(k)));
  if (name < 0 || amount < 0) return null;
  return { name, amount };
}

/**
 * 請求明細のCSVを読む。
 * 書式がモールや時期で変わるので、読めなかったときは見出しと先頭数行を返して
 * 何が入っているかを人が見られるようにする
 */
export function parseChargeCsv(bytes: ArrayBuffer, fileName: string): ChargeImport {
  const text = decodeCsv(bytes);
  const table = parseCsv(text);
  if (!table.length) {
    return { ok: false, fileName, rows: [], total: 0, message: "中身が空でした" };
  }

  // 見出しは先頭にあるとは限らない。前置きのある書式も多いので10行まで探す
  let headerIdx = -1;
  let cols: { name: number; amount: number } | null = null;
  for (let i = 0; i < Math.min(table.length, 10); i++) {
    const c = findColumns(table[i]);
    if (c) { headerIdx = i; cols = c; break; }
  }

  if (!cols || headerIdx < 0) {
    return {
      ok: false, fileName, rows: [], total: 0,
      message: "費目と金額の列を見つけられませんでした。見出しを見て対応づけを足します",
      headers: table[0],
      sample: table.slice(0, 5),
    };
  }

  const rows: ChargeRow[] = [];
  for (const r of table.slice(headerIdx + 1)) {
    const name = (r[cols.name] ?? "").trim();
    const amount = toInt(r[cols.amount] ?? "");
    if (!name || amount === 0) continue;
    // 「合計」行は内訳と二重になるので入れない
    if (/^(合計|総計|小計|ご請求金額合計)$/.test(name.replace(/\s/g, ""))) continue;
    rows.push({ name, amount });
  }

  if (!rows.length) {
    return {
      ok: false, fileName, rows: [], total: 0,
      message: "費目の行を読み取れませんでした",
      headers: table[headerIdx], sample: table.slice(headerIdx, headerIdx + 5),
    };
  }

  const total = rows.reduce((n, r) => n + r.amount, 0);
  return { ok: true, fileName, rows, total, message: `${rows.length}件・合計 ${total.toLocaleString("ja-JP")}円` };
}

/* ───────── 保存と反映 ───────── */

/** その月の明細を入れ直す */
export async function saveCharges(
  env: ChargeEnv,
  caseId: string,
  mall: string,
  month: string,
  rows: ChargeRow[],
  opts: { fileName?: string; r2Key?: string; source?: "csv" | "manual" } = {}
): Promise<{ total: number; allocated: number }> {
  const start = `${month}-01`;
  const end = `${month}-31`;

  const statements: D1PreparedStatement[] = [
    env.DB
      .prepare("DELETE FROM mall_charges WHERE case_id = ? AND mall = ? AND period_start = ?")
      .bind(caseId, mall, start),
  ];
  for (const r of rows) {
    statements.push(
      env.DB
        .prepare(
          `INSERT INTO mall_charges (id, case_id, mall, period_start, period_end, name, amount, source, source_file, r2_key)
           VALUES (?,?,?,?,?,?,?,?,?,?)`
        )
        .bind(crypto.randomUUID(), caseId, mall, start, end, r.name, r.amount,
              opts.source ?? "csv", opts.fileName ?? null, opts.r2Key ?? null)
    );
  }
  await env.DB.batch(statements);

  const total = rows.reduce((n, r) => n + r.amount, 0);
  const allocated = await allocateCharges(env.DB, caseId, mall, month);
  return { total, allocated };
}

/**
 * 月の請求合計を、その月の売上で按分して商品ごとの手数料にする。
 * 入金明細（API）から実額が入っている行は上書きしない
 */
export async function allocateCharges(
  db: D1Database,
  caseId: string,
  mall: string,
  month: string
): Promise<number> {
  const start = `${month}-01`;
  const end = `${month}-31`;

  const charge = await db
    .prepare("SELECT COALESCE(SUM(amount), 0) AS total FROM mall_charges WHERE case_id = ? AND mall = ? AND period_start = ?")
    .bind(caseId, mall, start)
    .first<{ total: number }>();
  const total = charge?.total ?? 0;

  const rev = await db
    .prepare(
      `SELECT COALESCE(SUM(revenue), 0) AS revenue FROM daily_sales
        WHERE case_id = ? AND mall = ? AND date BETWEEN ? AND ?
          AND (fee_source IS NULL OR fee_source = 'allocated')`
    )
    .bind(caseId, mall, start, end)
    .first<{ revenue: number }>();
  const revenue = rev?.revenue ?? 0;

  if (total <= 0 || revenue <= 0) return 0;

  const r = await db
    .prepare(
      `UPDATE daily_sales
          SET fee_actual = CAST(ROUND(revenue * 1.0 * ? / ?) AS INTEGER),
              fee_source = 'allocated'
        WHERE case_id = ? AND mall = ? AND date BETWEEN ? AND ?
          AND (fee_source IS NULL OR fee_source = 'allocated')`
    )
    .bind(total, revenue, caseId, mall, start, end)
    .run();
  return (r.meta as { changes?: number })?.changes ?? 0;
}

/** その月に入っている明細 */
export async function listCharges(
  db: D1Database,
  caseId: string,
  month: string
): Promise<Array<{ mall: string; name: string; amount: number; source: string }>> {
  const { results } = await db
    .prepare(
      `SELECT mall, name, amount, source FROM mall_charges
        WHERE case_id = ? AND period_start = ? ORDER BY mall, amount DESC`
    )
    .bind(caseId, `${month}-01`)
    .all<{ mall: string; name: string; amount: number; source: string }>();
  return results;
}
