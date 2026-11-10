/**
 * Amazon の入金明細（新 API：Finances 2024-06-19 listTransactions）の取り込み
 *
 * 旧 API（Finances v0、ingestFinances.ts）は、注文の取引を「お金が使えるようになった日」
 * （出荷の7〜10日後）で返してくる。そのため月の合計がセラーセントラルの日付範囲レポートと合わず、
 * 売上（注文日）と費用の時期も約1週間ずれていた（2026-11 Anomasala 10月で確認）。
 * 新 API は出荷・計上した日（postedDate）で返し、留保中（DEFERRED）の取引も含む。
 *
 * - 1日ずつ（日本時間 0時〜24時）取り、fee_events に basis='posted' で入れ直す
 * - 留保中→支払い済みに状態が変わるので、直近14日は毎日取り直す
 * - 金額は breakdowns（入れ子）の末端を1行ずつにする。末端の合計が取引の合計と合わない取引は数えて記録する
 * - どちらの日付で粗利を数えるかは app_flags.amazon_fee_basis で切り替える（amazonFin.ts）
 * - 留保（DEFERRED）が解けると、Amazon は「元の取引（出荷日・状態が DEFERRED_RELEASED に変わる）」に加えて
 *   「同じ中身の新しい取引（解けた日・RELEASED・DEFERRED_TRANSACTION_ID に元の取引ID）」を返す。
 *   両方数えると注文の金額が2倍になる（2026-11 Anomasala 10月で確認）ので、後者は数えない
 */

import { readCreds, type ConnEnv } from "./connections";
import { accessToken, spapi, errorMessage, JP_MARKETPLACE, type LwaEnv } from "./amazon";
import type { FeeRow } from "./finances";

export interface TxEnv extends ConnEnv, LwaEnv {
  FILES: R2Bucket;
}

interface Amt { currencyAmount?: number; currencyCode?: string }
interface Brk { breakdownType?: string; breakdownAmount?: Amt; breakdowns?: Brk[] }
interface Ctx { contextType?: string; sku?: string; asin?: string; quantityShipped?: number }
interface TxItem { description?: string; totalAmount?: Amt; breakdowns?: Brk[]; contexts?: Ctx[] }
interface Tx {
  transactionType?: string; transactionId?: string; transactionStatus?: string; description?: string;
  postedDate?: string; totalAmount?: Amt;
  relatedIdentifiers?: Array<{ relatedIdentifierName?: string; relatedIdentifierValue?: string }>;
  items?: TxItem[]; breakdowns?: Brk[]; contexts?: Ctx[];
}

export interface TxRow extends FeeRow {
  quantity: number | null;
  deferred: boolean;
}

const yen = (a: Amt | undefined) => Math.round(Number(a?.currencyAmount ?? 0));

/** 入れ子の breakdowns を末端だけに均す（path は上から順の名前） */
function leaves(list: Brk[] | undefined, path: string[] = []): Array<{ path: string[]; amount: number }> {
  const out: Array<{ path: string[]; amount: number }> = [];
  for (const b of list ?? []) {
    const p = [...path, b.breakdownType ?? "不明"];
    if (b.breakdowns && b.breakdowns.length) out.push(...leaves(b.breakdowns, p));
    else out.push({ path: p, amount: yen(b.breakdownAmount) });
  }
  return out;
}

function eventTypeOf(txType: string): FeeRow["eventType"] | null {
  if (/transfer|disburse|payout/i.test(txType)) return null;   // 振込みは費用ではない
  if (/refund|chargeback|guarantee/i.test(txType)) return "refund";
  if (/shipment|order/i.test(txType)) return "shipment";
  if (/adjust|reimburs|liquidation/i.test(txType)) return "adjustment";
  return "service_fee";
}

/** 末端の名前（と親の名前）から、旧 API と同じ種類に分ける */
function kindOf(path: string[]): FeeRow["kind"] {
  const leaf = path[path.length - 1] ?? "";
  const all = path.join("/");
  if (/withheld/i.test(all)) return "tax_withheld";
  if (/fee|commission/i.test(leaf)) return "fee";
  if (/point/i.test(all)) return "points";
  if (/promotion|discount|rebate|coupon/i.test(all)) return "promotion";
  if (/expense|amazonfees|fees|charges?back/i.test(all)) return "fee";
  return "charge";
}

/** 名前を旧 API とそろえる（月次確定の並べ方が名前を見ているため）。例：OurPricePrincipal → Principal */
function nameOf(path: string[]): string {
  const leaf = path[path.length - 1] ?? "不明";
  if (/fee|commission|point|promotion|discount|withheld/i.test(leaf)) return leaf;
  if (/shipping/i.test(leaf)) return /tax/i.test(leaf) ? "ShippingTax" : "ShippingCharge";
  if (/giftwrap/i.test(leaf)) return /tax/i.test(leaf) ? "GiftWrapTax" : "GiftWrap";
  if (/principal|itemprice/i.test(leaf)) return "Principal";
  if (/tax/i.test(leaf)) return "Tax";
  return leaf;
}

export function parseTransactions(list: Tx[], date: string): { rows: TxRow[]; mismatch: number; deferred: number; releaseCopies: number; types: Record<string, number> } {
  const rows: TxRow[] = [];
  let mismatch = 0, deferred = 0, releaseCopies = 0;
  const types: Record<string, number> = {};
  for (const tx of list) {
    const txType = tx.transactionType ?? "不明";
    types[txType] = (types[txType] ?? 0) + 1;
    const eventType = eventTypeOf(txType);
    if (!eventType) continue;
    // 留保が解けたときの写し（元の取引は出荷日で数えている）
    if (tx.relatedIdentifiers?.some((r) => /^DEFERRED_TRANSACTION_ID$/i.test(r.relatedIdentifierName ?? ""))) { releaseCopies++; continue; }
    const isDeferred = /^deferred$/i.test(tx.transactionStatus ?? "");
    if (isDeferred) deferred++;
    const orderId = tx.relatedIdentifiers?.find((r) => /^order_?id$/i.test(r.relatedIdentifierName ?? ""))?.relatedIdentifierValue ?? null;
    const txCtx = (tx.contexts ?? []).find((c) => c.sku);
    const before = rows.length;

    const push = (sku: string | null, path: string[], amount: number, quantity: number | null) => {
      if (!amount && quantity == null) return;
      // 月額登録料などのサービス料は、名前に Fee が無くても費用
      const k = kindOf(path);
      const kind = k === "charge" && eventType === "service_fee" ? "fee" : k;
      rows.push({ date, orderId, sku, eventType, kind, name: nameOf(path), amount, quantity, deferred: isDeferred });
    };

    const items = (tx.items ?? []).filter((it) => (it.breakdowns ?? []).length || yen(it.totalAmount));
    if (items.length) {
      for (const it of items) {
        const ctx = (it.contexts ?? []).find((c) => c.sku || c.quantityShipped != null) ?? txCtx;
        const sku = ctx?.sku ?? null;
        const qty = ctx?.quantityShipped != null ? Math.round(Number(ctx.quantityShipped)) * (eventType === "refund" ? -1 : 1) : null;
        const lv = leaves(it.breakdowns);
        if (!lv.length) { push(sku, [it.description ?? txType], yen(it.totalAmount), qty); continue; }
        lv.forEach((l, i) => push(sku, l.path, l.amount, i === 0 ? qty : null));
      }
    } else {
      const lv = leaves(tx.breakdowns);
      if (lv.length) lv.forEach((l) => push(txCtx?.sku ?? null, l.path, l.amount, null));
      else push(txCtx?.sku ?? null, [tx.description ?? txType], yen(tx.totalAmount), null);
    }
    // 末端の合計が取引の合計と合わないものは数えておく（取り込み方の見直しの手がかり）
    const sum = rows.slice(before).reduce((n, r) => n + r.amount, 0);
    if (tx.totalAmount && Math.abs(sum - yen(tx.totalAmount)) > 1) mismatch++;
  }
  return { rows, mismatch, deferred, releaseCopies, types };
}

/** 日本時間の 00:00 を UTC の ISO 文字列にする */
const jstMidnightUtc = (date: string, addDays = 0) =>
  new Date(Date.parse(`${date}T00:00:00+09:00`) + addDays * 86400000).toISOString();

const PAGE_WAIT_MS = 2200;   // 0.5 リクエスト/秒

async function fetchDay(token: string, date: string): Promise<{ ok: boolean; list: Tx[]; message: string; status?: number }> {
  const list: Tx[] = [];
  let next: string | undefined;
  for (let page = 0; page < 20; page++) {
    const qs = new URLSearchParams({
      postedAfter: jstMidnightUtc(date), postedBefore: jstMidnightUtc(date, 1), marketplaceId: JP_MARKETPLACE,
    });
    if (next) qs.set("nextToken", next);
    const r = await spapi(token, `/finances/2024-06-19/transactions?${qs}`);
    if (r.status === 429) { await new Promise((res) => setTimeout(res, 5000)); page--; continue; }
    if (!r.ok) return { ok: false, list, message: errorMessage(r.body), status: r.status };
    const payload = (r.body as { payload?: { transactions?: Tx[]; nextToken?: string } }).payload;
    list.push(...(payload?.transactions ?? []));
    next = payload?.nextToken;
    if (!next) break;
    await new Promise((res) => setTimeout(res, PAGE_WAIT_MS));
  }
  return { ok: true, list, message: "取得しました" };
}

async function skuMap(db: D1Database, caseId: string): Promise<Map<string, string>> {
  const { results } = await db.prepare(
    `SELECT l.external_id AS sku, l.product_id FROM product_listings l JOIN products p ON p.id = l.product_id
      WHERE l.mall = 'amazon' AND p.case_id = ?`
  ).bind(caseId).all<{ sku: string; product_id: string }>();
  return new Map(results.map((r) => [r.sku, r.product_id]));
}

/** 1案件1日ぶんを取り込む */
export async function ingestTransactionsDay(env: TxEnv, caseId: string, date: string, token?: string):
  Promise<{ status: "ok" | "error" | "unavailable"; rows: number; message: string }> {
  if (!token) {
    const creds = await readCreds(env, caseId, "amazon");
    if (!creds?.refresh_token) return { status: "error", rows: 0, message: "Amazon の接続情報が未登録です" };
    token = await accessToken(env, creds.refresh_token);
  }
  const got = await fetchDay(token, date);
  if (!got.ok) {
    // 古すぎる日など、取れない日は「取れない」と記録して、毎回取りに行かないようにする
    const unavailable = got.status === 400 && /date|range|older|before|after/i.test(got.message);
    await env.DB.prepare(
      `INSERT INTO ingests (id, case_id, mall, kind, period_start, period_end, rows, status, error, source)
       VALUES (?, ?, 'amazon', 'transactions', ?, ?, 0, ?, ?, 'api')`
    ).bind(crypto.randomUUID(), caseId, date, date, unavailable ? "unavailable" : "error", got.message).run();
    return { status: unavailable ? "unavailable" : "error", rows: 0, message: got.message };
  }

  const r2Key = `raw/amazon/transactions/${caseId}/${date}.json`;
  await env.FILES.put(r2Key, JSON.stringify(got.list), { httpMetadata: { contentType: "application/json" } });
  const w = await writeTxDay(env.DB, caseId, date, got.list);
  await env.DB.prepare(
    `INSERT INTO ingests (id, case_id, mall, kind, period_start, period_end, rows, status, error, r2_key, source, parser)
     VALUES (?, ?, 'amazon', 'transactions', ?, ?, ?, 'ok', ?, ?, 'api', ${TX_PARSER})`
  ).bind(crypto.randomUUID(), caseId, date, date, w.rows, w.note, r2Key).run();
  return { status: "ok", rows: w.rows, message: `${got.list.length}件の取引・${w.rows}行${w.note ? `（${w.note}）` : ""}` };
}

/** 新APIの取引を読むプログラムの版。読み方を変えたら上げる（上げると R2 の生データから読み直す） */
export const TX_PARSER = 2;

/** 1日ぶんの取引を fee_events（basis='posted'）に入れ直す */
async function writeTxDay(db: D1Database, caseId: string, date: string, list: Tx[]): Promise<{ rows: number; note: string | null }> {
  const parsed = parseTransactions(list, date);
  const map = await skuMap(db, caseId);
  const unknown = new Set<string>();
  const statements: D1PreparedStatement[] = [
    db.prepare("DELETE FROM fee_events WHERE case_id = ? AND mall = 'amazon' AND basis = 'posted' AND date = ?").bind(caseId, date),
  ];
  for (const row of parsed.rows) {
    const productId = row.sku ? map.get(row.sku) ?? null : null;
    if (row.sku && !productId) unknown.add(row.sku);
    statements.push(db.prepare(
      `INSERT INTO fee_events (id, case_id, mall, date, order_id, sku, product_id, event_type, kind, name, amount, basis, quantity, deferred)
       VALUES (?, ?, 'amazon', ?, ?, ?, ?, ?, ?, ?, ?, 'posted', ?, ?)`
    ).bind(crypto.randomUUID(), caseId, date, row.orderId, row.sku, productId, row.eventType, row.kind, row.name, row.amount,
      row.quantity, row.deferred ? 1 : 0));
  }
  await db.batch(statements);

  const notes: string[] = [];
  if (parsed.deferred) notes.push(`留保中 ${parsed.deferred}件`);
  if (parsed.releaseCopies) notes.push(`留保解除の写し ${parsed.releaseCopies}件（出荷日で数え済み）`);
  if (parsed.mismatch) notes.push(`内訳の合計が合わない取引 ${parsed.mismatch}件`);
  if (unknown.size) notes.push(`商品マスタに無いSKU：${[...unknown].slice(0, 5).join(", ")}`);
  return { rows: parsed.rows.length, note: notes.join(" ／ ") || null };
}

/**
 * 読み方を変えたときに、R2 に残した生データから読み直す（API は呼ばない）。
 * 5分ごとの実行で少しずつ進める
 */
export async function reparseTransactions(env: TxEnv, limit = 60): Promise<number> {
  const { results } = await env.DB.prepare(
    `SELECT case_id, period_start AS date, MAX(r2_key) AS r2_key FROM ingests
      WHERE mall = 'amazon' AND kind = 'transactions' AND status = 'ok' AND COALESCE(parser, 1) < ? AND r2_key IS NOT NULL
      GROUP BY case_id, period_start ORDER BY period_start DESC LIMIT ?`
  ).bind(TX_PARSER, limit).all<{ case_id: string; date: string; r2_key: string }>();
  let done = 0;
  for (const r of results) {
    const obj = await env.FILES.get(r.r2_key);
    let note: string | null = null, rows: number | null = null;
    if (obj) {
      const list = (await obj.json()) as Tx[];
      const w = await writeTxDay(env.DB, r.case_id, r.date, Array.isArray(list) ? list : []);
      note = w.note; rows = w.rows;
    }
    // 生データが無い日も、何度も探しに行かないよう印をつける
    await env.DB.prepare(
      `UPDATE ingests SET parser = ?, rows = COALESCE(?, rows), error = CASE WHEN ? IS NULL THEN error ELSE ? END
        WHERE case_id = ? AND mall = 'amazon' AND kind = 'transactions' AND period_start = ? AND status = 'ok'`
    ).bind(TX_PARSER, rows, obj ? 1 : null, note, r.case_id, r.date).run();
    done++;
  }
  return done;
}

const jstDay = (offset: number) => new Date(Date.now() + 9 * 3600000 - offset * 86400000).toISOString().slice(0, 10);

/**
 * 5分ごとの実行から呼ぶ。案件ごとに
 *   ① 直近14日：今日まだ取っていない日を取り直す（留保中→支払い済みの変化を拾う）
 *   ② それより古い日：まだ取れていない日を新しい順に埋める（売上データの最初の日まで）
 * を、時間の許す範囲で進める
 */
export async function pumpTransactions(env: TxEnv, opts: { budgetMs?: number; caseId?: string } = {}): Promise<number> {
  const deadline = Date.now() + (opts.budgetMs ?? 50000);
  const { results: cases } = await env.DB.prepare(
    `SELECT c.id, (SELECT MIN(date) FROM daily_sales s WHERE s.case_id = c.id AND s.mall = 'amazon') AS first
       FROM cases c JOIN case_malls m ON m.case_id = c.id AND m.mall = 'amazon' AND m.credentials_enc IS NOT NULL
      WHERE c.status = 'active' ${opts.caseId ? "AND c.id = ?" : ""}`
  ).bind(...(opts.caseId ? [opts.caseId] : [])).all<{ id: string; first: string | null }>();
  const todayStartUtc = new Date(Date.parse(`${jstDay(0)}T00:00:00+09:00`)).toISOString().slice(0, 19).replace("T", " ");
  let done = 0;

  for (const c of cases) {
    if (Date.now() > deadline) break;
    const { results: hist } = await env.DB.prepare(
      `SELECT period_start AS d, MAX(created_at) AS at, MAX(status = 'ok') AS ok, MAX(status = 'unavailable') AS na
         FROM ingests WHERE case_id = ? AND mall = 'amazon' AND kind = 'transactions' GROUP BY period_start`
    ).bind(c.id).all<{ d: string; at: string; ok: number; na: number }>();
    const h = new Map(hist.map((x) => [x.d, x]));
    const oldestNa = hist.filter((x) => x.na).map((x) => x.d).sort().pop() ?? null;

    const todo: string[] = [];
    for (let i = 1; i <= 14; i++) {
      const d = jstDay(i), x = h.get(d);
      if (!x || x.at < todayStartUtc) todo.push(d);
    }
    const first = c.first ?? jstDay(60);
    for (let i = 15; i < 800; i++) {
      const d = jstDay(i);
      if (d < first || (oldestNa && d <= oldestNa)) break;
      if (!h.get(d)?.ok) todo.push(d);
    }
    if (!todo.length) continue;

    const creds = await readCreds(env, c.id, "amazon");
    if (!creds?.refresh_token) continue;
    let token: string;
    try { token = await accessToken(env, creds.refresh_token); } catch { continue; }
    for (const d of todo) {
      if (Date.now() > deadline) break;
      const r = await ingestTransactionsDay(env, c.id, d, token);
      done++;
      if (r.status === "unavailable") break;             // これより古い日は取れない
      await new Promise((res) => setTimeout(res, PAGE_WAIT_MS));
    }
  }
  return done;
}
