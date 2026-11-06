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

/* ───────── 楽天の請求・支払明細（Shop_Billpay.csv） ───────── */

export interface BillpayRow {
  month: string;           // YYYY-MM（行ごとの精算対象期間から）
  category: string;        // 集約科目
  name: string;            // 品目（半角カナは全角に直す）
  amount: number;          // 税込・費用はプラス
  amountEx: number;        // 税抜
  taxRate: number;         // 10 / 8 / 0
  excluded: boolean;       // 手数料に数えない（RPPの広告掲載料）
}

export interface BillpayImport {
  ok: true;
  fileName: string;
  statementNo: string;     // 店舗別内訳書No
  shop: string;
  issued: string;
  rows: BillpayRow[];
  months: string[];
  /** 明細の「消費税」行と、行ごとに計算した消費税の差（0なら一致） */
  taxDiff: number;
  /** 入金（楽天ペイ決済金など）の合計。費用ではないので取り込まない。確認用 */
  payments: number;
}

const BILLPAY_HEADERS = ["店舗別内訳書No", "品目", "支払/請求分類", "精算対象期間開始日"];

/** 楽天の請求・支払明細かどうか（見出しで見分ける） */
export function isBillpay(table: string[][]): boolean {
  const h = (table[0] ?? []).map((x) => x.trim());
  return BILLPAY_HEADERS.every((k) => h.includes(k));
}

const ym = (d: string | undefined): string | null => {
  const m = (d ?? "").trim().match(/^(\d{4})[\/-](\d{1,2})/);
  return m ? `${m[1]}-${m[2].padStart(2, "0")}` : null;
};

/**
 * 請求・支払明細を読む。
 * - 「支払」（楽天ペイ決済金・クーポン代金）は売上の入金なので取り込まない
 * - 「支払控除」（後払い決済の手数料など）は税込で費用にする
 * - 「請求」は税抜で載っているので、行の税率で税込に直す。明細末尾の「消費税」行は照合だけに使う
 * - 月は行ごとの精算対象期間で決める（同じ明細でも項目ごとに対象月が違う）
 * - RPP の広告掲載料は広告費として別に数えているので、手数料からは外す（記録は残す）
 */
export function parseBillpay(table: string[][], fileName: string): BillpayImport | { ok: false; message: string } {
  const h = table[0].map((x) => x.trim());
  const col = (k: string) => h.indexOf(k);
  const c = {
    issued: col("発行日"), no: col("店舗別内訳書No"), shop: col("店舗名"),
    pay: col("支払（税込額）"), ex: col("請求（税抜額）"), tax: col("請求（税額）"),
    kind: col("支払/請求分類"), cat: col("集約科目"), item: col("品目"),
    start: col("精算対象期間開始日"), end: col("精算対象期間終了日"), rate: col("税率"),
  };
  const rows: BillpayRow[] = [];
  let statementNo = "", shop = "", issued = "", payments = 0, taxLine = 0, taxCalc = 0;

  for (const r of table.slice(1)) {
    if (!r.length || r.every((x) => !x.trim())) continue;
    statementNo ||= (r[c.no] ?? "").trim();
    shop ||= (r[c.shop] ?? "").trim();
    issued ||= (r[c.issued] ?? "").trim();
    const kind = (r[c.kind] ?? "").trim();
    const name = (r[c.item] ?? "").trim().normalize("NFKC");
    const category = (r[c.cat] ?? "").trim().replace(/^-$/, "");
    const rate = Number((r[c.rate] ?? "").trim()) || 0;
    const month = ym(r[c.start]) ?? ym(r[c.end]) ?? ym(issued);
    if (!month) continue;

    if (kind === "支払") { payments += toInt(r[c.pay]); continue; }
    if (name === "消費税") {
      if (kind === "請求") taxLine += toInt(r[c.tax]);
      continue;
    }
    if (kind === "支払控除") {
      // 入金から差し引かれた費用。税込で載っている（マイナス）
      const incl = -toInt(r[c.pay]);
      if (!incl) continue;
      rows.push({ month, category: category || "支払控除", name, amount: incl,
        amountEx: rate ? Math.round(incl / (1 + rate / 100)) : incl, taxRate: rate, excluded: false });
      continue;
    }
    if (kind === "請求") {
      const ex = toInt(r[c.ex]);
      if (!ex) continue;
      const incl = Math.round(ex * (1 + rate / 100));
      if (rate === 10) taxCalc += incl - ex;
      rows.push({ month, category: category || "その他", name, amount: incl, amountEx: ex, taxRate: rate,
        excluded: /RPP|検索連動型広告/.test(name) });
    }
  }

  if (!statementNo) return { ok: false, message: "店舗別内訳書No が読めませんでした" };
  if (!rows.length) return { ok: false, message: "費用の行がありませんでした（入金の行だけの明細です）" };
  const months = [...new Set(rows.map((x) => x.month))].sort();
  return { ok: true, fileName, statementNo, shop, issued, rows, months, taxDiff: taxLine ? taxCalc - taxLine : 0, payments };
}

/** 請求・支払明細を1本入れる。同じ店舗別内訳書No の行だけを入れ直す */
export async function saveBillpay(
  env: ChargeEnv, caseId: string, mall: string, b: BillpayImport, r2Key: string
): Promise<Array<{ month: string } & MonthStatus>> {
  const statements: D1PreparedStatement[] = [
    env.DB.prepare("DELETE FROM mall_charges WHERE case_id = ? AND mall = ? AND statement_no = ?").bind(caseId, mall, b.statementNo),
  ];
  for (const r of b.rows) {
    statements.push(env.DB.prepare(
      `INSERT INTO mall_charges (id, case_id, mall, period_start, period_end, name, amount, source, source_file, r2_key,
                                 statement_no, category, amount_ex, tax_rate, excluded, note)
       VALUES (?,?,?,?,?,?,?, 'csv', ?,?,?,?,?,?,?,?)`
    ).bind(crypto.randomUUID(), caseId, mall, `${r.month}-01`, `${r.month}-31`, r.name, r.amount,
      b.fileName, r2Key, b.statementNo, r.category, r.amountEx, r.taxRate, r.excluded ? 1 : 0, `発行 ${b.issued}`));
  }
  await env.DB.batch(statements);
  const out: Array<{ month: string } & MonthStatus> = [];
  for (const m of b.months) {
    await allocateCharges(env.DB, caseId, mall, m);
    out.push({ month: m, ...(await monthStatus(env.DB, caseId, mall, m)) });
  }
  return out;
}

export interface MonthStatus {
  /** 実額として使える（その月の主な項目がそろった） */
  complete: boolean;
  /** 手数料として数える合計（税込・広告掲載料を除く） */
  total: number;
  /** 手数料から外した合計（RPPの広告掲載料） */
  excluded: number;
  /** まだ届いていない主な項目 */
  missing: string[];
}

/**
 * 楽天の月の手数料は、システム利用料と楽天ペイ利用料が別の月の明細で届く（後者は1か月早い）。
 * 片方だけで実額に置き換えると手数料が少なく見えるので、両方そろうまでは料率の概算のままにする。
 * 手入力や旧書式（店舗別内訳書No の無い行）は、入れた人がその月の全額として入れたものとして扱う
 */
export async function monthStatus(db: D1Database, caseId: string, mall: string, month: string): Promise<MonthStatus> {
  const { results } = await db.prepare(
    `SELECT name, category, amount, excluded, statement_no FROM mall_charges WHERE case_id = ? AND mall = ? AND period_start = ?`
  ).bind(caseId, mall, `${month}-01`).all<{ name: string; category: string | null; amount: number; excluded: number; statement_no: string | null }>();
  const total = results.filter((r) => !r.excluded).reduce((n, r) => n + r.amount, 0);
  const excluded = results.filter((r) => r.excluded).reduce((n, r) => n + r.amount, 0);
  if (!results.length) return { complete: false, total: 0, excluded: 0, missing: ["請求明細"] };
  if (mall !== "rakuten" || results.some((r) => r.statement_no == null)) return { complete: total > 0, total, excluded, missing: [] };
  const missing: string[] = [];
  if (!results.some((r) => /^システム利用料_(PC|モバイル)/.test(r.name))) missing.push("システム利用料");
  if (!results.some((r) => /楽天ペイ利用料/.test(r.name))) missing.push("楽天ペイ利用料");
  // RSL を使っている店舗は、物流費もそろうまで待つ（そろわないうちに実額へ切り替えると、暫定の物流費が消えて少なく見える）
  if (!results.some((r) => r.category === "物流費")) {
    const used = await db.prepare(
      `SELECT 1 AS x FROM mall_charges WHERE case_id = ? AND mall = ? AND category = '物流費' LIMIT 1`
    ).bind(caseId, mall).first<{ x: number }>();
    if (used) missing.push("物流費（RSL）");
  }
  return { complete: missing.length === 0, total, excluded, missing };
}

/* ───────── 保存と反映 ───────── */

/** その月の明細を入れ直す（手入力・旧書式）。請求・支払明細から入れた行は残す */
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
      .prepare("DELETE FROM mall_charges WHERE case_id = ? AND mall = ? AND period_start = ? AND statement_no IS NULL")
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

  const st = await monthStatus(db, caseId, mall, month);
  if (!st.complete) {
    // そろっていない月は概算に戻す（前に按分していたら外す）
    await db.prepare(
      `UPDATE daily_sales SET fee_actual = NULL, fee_source = NULL
        WHERE case_id = ? AND mall = ? AND date BETWEEN ? AND ? AND fee_source = 'allocated'`
    ).bind(caseId, mall, start, end).run();
    return 0;
  }
  const total = st.total;

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
) {
  const { results } = await db
    .prepare(
      `SELECT mall, name, amount, source, category, excluded, statement_no AS statementNo, note FROM mall_charges
        WHERE case_id = ? AND period_start = ? ORDER BY mall, excluded, amount DESC`
    )
    .bind(caseId, `${month}-01`)
    .all<{ mall: string; name: string; amount: number; source: string; category: string | null; excluded: number;
           statementNo: string | null; note: string | null }>();
  return results;
}

/** 楽天の手数料が実額になっている最新の月（無ければ null） */
export async function latestCompleteMonth(db: D1Database, caseId: string, mall: string): Promise<string | null> {
  const { results } = await db.prepare(
    `SELECT DISTINCT substr(period_start, 1, 7) AS m FROM mall_charges WHERE case_id = ? AND mall = ? ORDER BY m DESC LIMIT 24`
  ).bind(caseId, mall).all<{ m: string }>();
  for (const r of results) if ((await monthStatus(db, caseId, mall, r.m)).complete) return r.m;
  return null;
}
