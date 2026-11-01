/**
 * 入金明細の取り込み
 *
 * 1日ぶんずつ financialEvents を取り、fee_events に入れ直してから
 * daily_sales の手数料実額・返品額を更新する。
 * 同じ日を何度取り込んでも二重にならないよう、その日を消してから入れる。
 */

import { readCreds, type ConnEnv } from "./connections";
import { accessToken, spapi, errorMessage, type LwaEnv } from "./amazon";
import { parseFinancialEvents, type FeeRow } from "./finances";

export interface FinanceEnv extends ConnEnv, LwaEnv {
  FILES: R2Bucket;
}

export interface FinanceOutcome {
  caseId: string;
  date: string;
  status: "done" | "error";
  message: string;
  rows?: number;
  fees?: number;
}

/** 日本時間の 00:00 を UTC の ISO 文字列にする */
function jstMidnightUtc(date: string, addDays = 0): string {
  const base = Date.parse(`${date}T00:00:00+09:00`);
  return new Date(base + addDays * 24 * 60 * 60 * 1000).toISOString();
}

const MAX_PAGES = 15;        // 1日ぶんでこれ以上は想定していない
const PAGE_WAIT_MS = 2200;   // Finances は 0.5 リクエスト/秒

/** 1日ぶんのイベントをすべて取る（ページを順にたどる） */
async function fetchDay(
  token: string,
  date: string
): Promise<{ ok: boolean; rows: FeeRow[]; ignored: Record<string, number>; raw: unknown[]; message: string }> {
  const rows: FeeRow[] = [];
  const ignored: Record<string, number> = {};
  const raw: unknown[] = [];
  let nextToken: string | undefined;

  for (let page = 0; page < MAX_PAGES; page++) {
    const qs = nextToken
      ? `NextToken=${encodeURIComponent(nextToken)}`
      : `PostedAfter=${encodeURIComponent(jstMidnightUtc(date))}` +
        `&PostedBefore=${encodeURIComponent(jstMidnightUtc(date, 1))}` +
        `&MaxResultsPerPage=100`;

    const r = await spapi(token, `/finances/v0/financialEvents?${qs}`);
    if (!r.ok) return { ok: false, rows, ignored, raw, message: errorMessage(r.body) };

    const payload = (r.body as { payload?: { FinancialEvents?: Record<string, unknown>; NextToken?: string } }).payload;
    const events = payload?.FinancialEvents ?? {};
    raw.push(events);

    const parsed = parseFinancialEvents(events, date);
    rows.push(...parsed.rows);
    for (const [k, v] of Object.entries(parsed.ignored)) ignored[k] = (ignored[k] ?? 0) + v;

    nextToken = payload?.NextToken;
    if (!nextToken) break;
    await new Promise((r2) => setTimeout(r2, PAGE_WAIT_MS));
  }
  return { ok: true, rows, ignored, raw, message: "取得しました" };
}

/**
 * Amazon SKU → 商品ID。
 * 案件ごとにセラーアカウントが別なので、同じSKU名が別案件に存在しうる。
 * その案件の商品だけを読む
 */
async function skuMap(db: D1Database, caseId: string): Promise<Map<string, string>> {
  const { results } = await db
    .prepare(
      `SELECT l.external_id AS sku, l.product_id
         FROM product_listings l JOIN products p ON p.id = l.product_id
        WHERE l.mall = 'amazon' AND p.case_id = ?`
    )
    .bind(caseId)
    .all<{ sku: string; product_id: string }>();
  const m = new Map<string, string>();
  for (const r of results) m.set(r.sku, r.product_id);
  return m;
}

/**
 * 1案件1日ぶんを取り込む。
 * 案件ごとにセラーアカウントが別なので、取れる明細はすべてその案件のもの。
 * SKUの付かない行（注文単位の手数料・月額登録料など）もその案件の費用として扱う
 */
export async function ingestFinances(
  env: FinanceEnv,
  caseId: string,
  date: string
): Promise<FinanceOutcome> {
  const creds = await readCreds(env, caseId, "amazon");
  if (!creds?.refresh_token) {
    return { caseId, date, status: "error", message: "Amazon の接続情報が未登録です" };
  }

  let token: string;
  try {
    token = await accessToken(env, creds.refresh_token);
  } catch (e) {
    return { caseId, date, status: "error", message: `アクセストークンを取れません：${String(e)}` };
  }

  const got = await fetchDay(token, date);
  if (!got.ok) {
    await env.DB.prepare(
      `INSERT INTO ingests (id, case_id, mall, kind, period_start, period_end, rows, status, error, source)
       VALUES (?, ?, 'amazon', 'settlement', ?, ?, 0, 'error', ?, 'api')`
    ).bind(crypto.randomUUID(), caseId, date, date, got.message).run();
    return { caseId, date, status: "error", message: got.message };
  }

  // 生データは残す。内訳を聞かれたときに取り直さずに答えられるようにするため
  const r2Key = `raw/amazon/finances/${caseId}/${date}.json`;
  await env.FILES.put(r2Key, JSON.stringify(got.raw), { httpMetadata: { contentType: "application/json" } });

  const map = await skuMap(env.DB, caseId);
  const statements: D1PreparedStatement[] = [
    env.DB.prepare("DELETE FROM fee_events WHERE case_id = ? AND mall = 'amazon' AND date = ?").bind(caseId, date),
  ];

  let kept = 0;
  const unknown = new Set<string>();
  for (const row of got.rows) {
    const productId = row.sku ? map.get(row.sku) ?? null : null;
    if (row.sku && !productId) unknown.add(row.sku);
    statements.push(
      env.DB
        .prepare(
          `INSERT INTO fee_events (id, case_id, mall, date, order_id, sku, product_id, event_type, kind, name, amount)
           VALUES (?, ?, 'amazon', ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          // 取得期間はその日の日本時間 0時〜24時なので、計上日は必ずこの date になる。
          // 行ごとの PostedDate ではなく date を入れることで、
          // 取り直したときに必ず同じ行が消えるようにしている（生の日時は R2 に残している）
          crypto.randomUUID(), caseId, date, row.orderId, row.sku,
          productId, row.eventType, row.kind, row.name, row.amount
        )
    );
    kept++;
  }

  // daily_sales の手数料実額と返品額を、入った明細から引き直す。
  // 符号はここで反転させる（費用はマイナスで持っているため）
  statements.push(
    env.DB
      .prepare(
        `UPDATE daily_sales SET
           fee_actual = (SELECT -COALESCE(SUM(f.amount), 0) FROM fee_events f
                          WHERE f.case_id = daily_sales.case_id AND f.mall = daily_sales.mall
                            AND f.date = daily_sales.date AND f.product_id IS daily_sales.product_id
                            AND f.kind IN ('fee', 'promotion', 'tax_withheld')),
           returns = (SELECT -COALESCE(SUM(f.amount), 0) FROM fee_events f
                       WHERE f.case_id = daily_sales.case_id AND f.mall = daily_sales.mall
                         AND f.date = daily_sales.date AND f.product_id IS daily_sales.product_id
                         AND f.event_type = 'refund' AND f.kind = 'charge')
         WHERE case_id = ? AND mall = 'amazon' AND date = ?`
      )
      .bind(caseId, date)
  );

  await env.DB.batch(statements);

  const fees = got.rows.filter((r) => r.kind === "fee").reduce((n, r) => n + r.amount, 0);
  const notes: string[] = [];
  if (unknown.size) {
    notes.push(`商品マスタに無いSKUが ${unknown.size} 件：${[...unknown].slice(0, 10).join(", ")}`);
  }
  if (Object.keys(got.ignored).length) {
    notes.push(`未対応の種類：${Object.entries(got.ignored).map(([k, v]) => `${k} ${v}件`).join(", ")}`);
  }
  const note = notes.length ? notes.join(" ／ ") : null;

  await env.DB.prepare(
    `INSERT INTO ingests (id, case_id, mall, kind, period_start, period_end, rows, status, error, r2_key, source)
     VALUES (?, ?, 'amazon', 'settlement', ?, ?, ?, 'ok', ?, ?, 'api')`
  ).bind(crypto.randomUUID(), caseId, date, date, kept, note, r2Key).run();

  return {
    caseId, date, status: "done", rows: kept, fees: -fees,
    message: `${kept} 行を取り込みました（手数料 ${(-fees).toLocaleString("ja-JP")} 円）${note ? ` ／ ${note}` : ""}`,
  };
}

/** 日次バッチ用。取り込めていない日を古い順に埋める */
export async function pumpFinances(
  env: FinanceEnv,
  opts: { days?: number; perCase?: number } = {}
): Promise<FinanceOutcome[]> {
  const days = opts.days ?? 10;        // 入金明細は売上より遅れて確定するので広めに見る
  const perCase = opts.perCase ?? 3;

  const { results: cases } = await env.DB.prepare(
    `SELECT c.id FROM cases c
       JOIN case_malls m ON m.case_id = c.id AND m.mall = 'amazon' AND m.credentials_enc IS NOT NULL
      WHERE c.status = 'active'`
  ).all<{ id: string }>();

  const out: FinanceOutcome[] = [];
  for (const c of cases) {
    let touched = 0;
    for (let i = days; i >= 1 && touched < perCase; i--) {
      const date = new Date(Date.now() + 9 * 3600 * 1000 - i * 24 * 3600 * 1000).toISOString().slice(0, 10);
      const done = await env.DB
        .prepare(
          `SELECT 1 AS hit FROM ingests
            WHERE case_id = ? AND mall = 'amazon' AND kind = 'settlement'
              AND period_start = ? AND status = 'ok' LIMIT 1`
        )
        .bind(c.id, date)
        .first<{ hit: number }>();
      if (done) continue;
      out.push(await ingestFinances(env, c.id, date));
      touched++;
    }
  }
  return out;
}
