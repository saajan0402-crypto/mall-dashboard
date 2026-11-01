/**
 * 過去データの取り込み（案件ごとに一度だけ回す想定）
 *
 * 1回のリクエストで全部やろうとすると時間切れになるので、
 * 「決めた時間だけ進めて、どこまで進んだかを残す」形にしている。
 * 5分ごとのバッチが裏で進め続けるので、画面を閉じても終わりに向かう。
 *
 * 3段階で、順番に意味がある。
 *   1. orders   注文APIから明細を取る。速い（1秒に2回呼べる）
 *   2. traffic  売上・トラフィックレポートでセッション数を足し、
 *               売上をAmazonの公式集計で上書きする。遅い（1日あたり約2分）
 *   3. finances 入金明細で手数料の実額と返品額を入れる
 *
 * traffic が daily_sales の行を作り直すので finances は必ずその後。
 * orders を先に回すのは、遅い traffic を待たずに数字が見えるようにするため。
 */

import { readCreds, type ConnEnv } from "./connections";
import { accessToken, spapi, errorMessage, JP_MARKETPLACE, type LwaEnv } from "./amazon";
import { ingestFinances, type FinanceEnv } from "./ingestFinances";
import { advance } from "./ingestSales";
import { SALES_TRAFFIC } from "./spReports";

export interface BackfillEnv extends ConnEnv, LwaEnv {
  FILES: R2Bucket;
}

export interface Progress {
  caseId: string;
  caseName?: string;
  kind: "orders" | "traffic" | "finances";
  fromDate: string;
  toDate: string;
  done: number;
  total: number;
  status: "running" | "done" | "error";
  note: string | null;
}

/** 日本時間の日付 */
function jst(offsetDays = 0): string {
  return new Date(Date.now() + 9 * 3600 * 1000 - offsetDays * 24 * 3600 * 1000).toISOString().slice(0, 10);
}
const toUtcIso = (date: string, endOfDay = false) =>
  new Date(Date.parse(`${date}T${endOfDay ? "23:59:59" : "00:00:00"}+09:00`)).toISOString();

/* ───────── 開始・状態 ───────── */

/**
 * 取り込みを始める。直近7日はふだんの処理が見ているので、
 * ここでは 8日前より古いところだけを対象にする
 */
export async function startBackfill(
  env: BackfillEnv, caseId: string, days: number, opts: { traffic?: boolean } = {}
): Promise<Progress[]> {
  // Amazon が遡れるのはおおむね2年。それ以上は指定しても空が返る
  const from = jst(Math.min(days, 730));
  const to = jst(8);
  if (from >= to) throw new Error("期間が短すぎます");

  const dayCount = Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1;
  const kinds: Array<["orders" | "traffic" | "finances", number, string | null]> = [
    ["orders", dayCount, null],
    ["finances", dayCount, to],      // 新しい日から古い日へ遡る
  ];
  if (opts.traffic !== false) kinds.splice(1, 0, ["traffic", dayCount, to]);
  else await env.DB.prepare("DELETE FROM backfill WHERE case_id = ? AND kind = 'traffic'").bind(caseId).run();

  for (const [kind, total, cursor] of kinds) {
    await env.DB.prepare(
      `INSERT INTO backfill (case_id, kind, from_date, to_date, cursor, done, total, status, note)
       VALUES (?,?,?,?,?,0,?, 'running', NULL)
       ON CONFLICT(case_id, kind) DO UPDATE SET
         from_date = excluded.from_date, to_date = excluded.to_date, cursor = excluded.cursor,
         done = 0, total = excluded.total, status = 'running', note = NULL, updated_at = datetime('now')`
    ).bind(caseId, kind, from, to, cursor, total).run();
  }
  return backfillStatus(env, caseId);
}

export async function backfillStatus(env: BackfillEnv, caseId?: string): Promise<Progress[]> {
  const { results } = await env.DB
    .prepare(
      `SELECT b.*, c.name AS case_name FROM backfill b JOIN cases c ON c.id = b.case_id
        ${caseId ? "WHERE b.case_id = ?" : ""} ORDER BY c.name, b.kind`
    )
    .bind(...(caseId ? [caseId] : []))
    .all<Record<string, string | number | null>>();

  return results.map((r) => ({
    caseId: String(r.case_id), caseName: String(r.case_name),
    kind: r.kind as "orders" | "traffic" | "finances",
    fromDate: String(r.from_date), toDate: String(r.to_date),
    done: Number(r.done ?? 0), total: Number(r.total ?? 0),
    status: r.status as Progress["status"], note: r.note == null ? null : String(r.note),
  }));
}

/* ───────── 注文 ───────── */

interface OrderRow { AmazonOrderId?: string; PurchaseDate?: string; OrderStatus?: string }
interface ItemRow {
  OrderItemId?: string; SellerSKU?: string; ASIN?: string;
  QuantityOrdered?: number;
  ItemPrice?: { Amount?: string | number };
  PromotionDiscount?: { Amount?: string | number };
}

const money = (v: unknown) => Math.round(Number(v ?? 0)) || 0;

/** 注文を1ページぶん進める。戻り値は、まだ続きがあるか */
async function stepOrders(
  env: BackfillEnv, caseId: string, token: string, state: Record<string, string | number | null>,
  deadline: number
): Promise<{ more: boolean; orders: number; note?: string }> {
  const from = String(state.from_date), to = String(state.to_date);
  const cursor = state.cursor == null ? null : String(state.cursor);

  // 1ページ20件。明細の取得に時間がかかるので、1回の実行に収まる大きさにしている
  const qs = cursor
    ? `MarketplaceIds=${JP_MARKETPLACE}&NextToken=${encodeURIComponent(cursor)}`
    : `MarketplaceIds=${JP_MARKETPLACE}&MaxResultsPerPage=20` +
      `&CreatedAfter=${encodeURIComponent(toUtcIso(from))}&CreatedBefore=${encodeURIComponent(toUtcIso(to, true))}`;

  const r = await spapi(token, `/orders/v0/orders?${qs}`);
  if (!r.ok) return { more: true, orders: 0, note: errorMessage(r.body) };

  const payload = (r.body as { payload?: { Orders?: OrderRow[]; NextToken?: string } }).payload;
  // キャンセルは売上に数えない。Pending は金額もSKUもまだ確定していないので飛ばす
  const orders = (payload?.Orders ?? []).filter(
    (o) => o.OrderStatus !== "Canceled" && o.OrderStatus !== "Pending"
  );
  const nextToken = payload?.NextToken ?? null;

  const { results: listings } = await env.DB
    .prepare(
      `SELECT l.external_id AS sku, l.product_id FROM product_listings l
         JOIN products p ON p.id = l.product_id
        WHERE l.mall = 'amazon' AND p.case_id = ?`
    )
    .bind(caseId)
    .all<{ sku: string; product_id: string }>();
  const bySku = new Map(listings.map((l) => [l.sku, l.product_id]));

  const statements: D1PreparedStatement[] = [];
  const dates = new Set<string>();

  for (const o of orders) {
    if (Date.now() > deadline) break;
    const id = o.AmazonOrderId;
    if (!id || !o.PurchaseDate) continue;
    const date = new Date(Date.parse(o.PurchaseDate) + 9 * 3600 * 1000).toISOString().slice(0, 10);

    let ir = await spapi(token, `/orders/v0/orders/${id}/orderItems`);
    if (ir.status === 429) {
      await new Promise((res) => setTimeout(res, 3000));
      ir = await spapi(token, `/orders/v0/orders/${id}/orderItems`);
    }
    if (!ir.ok) continue;
    const items = ((ir.body as { payload?: { OrderItems?: ItemRow[] } }).payload?.OrderItems ?? []);

    for (const it of items) {
      const itemId = it.OrderItemId;
      if (!itemId) continue;
      const sku = it.SellerSKU ?? null;
      statements.push(
        env.DB
          .prepare(
            `INSERT INTO order_items
               (case_id, mall, order_id, order_item_id, date, sku, product_id, units, revenue, discount, status)
             VALUES (?, 'amazon', ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(case_id, mall, order_item_id) DO UPDATE SET
               date = excluded.date, sku = excluded.sku, product_id = excluded.product_id,
               units = excluded.units, revenue = excluded.revenue, discount = excluded.discount,
               status = excluded.status`
          )
          .bind(caseId, id, itemId, date, sku, sku ? bySku.get(sku) ?? null : null,
                Math.round(Number(it.QuantityOrdered ?? 0)), money(it.ItemPrice?.Amount),
                money(it.PromotionDiscount?.Amount), o.OrderStatus ?? null)
      );
      dates.add(date);
    }
    await new Promise((res) => setTimeout(res, 250));   // 明細は1秒に2回まで
  }

  if (statements.length) await env.DB.batch(statements);

  // 触れた日だけ日次売上を作り直す。直近分はふだんの処理が持っているので上書きしない
  for (const date of dates) {
    if (date > to) continue;
    await env.DB.batch([
      env.DB.prepare("DELETE FROM daily_sales WHERE case_id = ? AND mall = 'amazon' AND date = ?").bind(caseId, date),
      env.DB
        .prepare(
          `INSERT INTO daily_sales (case_id, mall, product_id, date, units, revenue, discounts, source)
           SELECT case_id, 'amazon', product_id, date, SUM(units), SUM(revenue), SUM(discount), 'api'
             FROM order_items
            WHERE case_id = ? AND mall = 'amazon' AND date = ? AND product_id IS NOT NULL
            GROUP BY product_id`
        )
        .bind(caseId, date),
    ]);
  }

  await env.DB.prepare(
    `UPDATE backfill SET cursor = ?, done = done + ?, status = ?, updated_at = datetime('now')
      WHERE case_id = ? AND kind = 'orders'`
  ).bind(nextToken, orders.length, nextToken ? "running" : "done", caseId).run();

  return { more: Boolean(nextToken), orders: orders.length };
}

/* ───────── 売上・トラフィックレポート ───────── */

/**
 * レポートは「依頼 → 生成待ち → 取得」で、依頼も取得もそれぞれ1分に1回しか呼べない。
 * 1日ずつ順番に待っていると空き時間だらけになるので、
 *   先に出来上がっているものを回収し、
 *   そのあと新しい日をまとめて依頼する
 * という流し方にして、待ち時間を重ねる。
 */
async function stepTraffic(
  env: BackfillEnv, caseId: string, state: Record<string, string | number | null>, deadline: number
): Promise<{ more: boolean }> {
  const from = String(state.from_date), to = String(state.to_date);

  const { results: jobs } = await env.DB
    .prepare(
      `SELECT date, status FROM report_jobs
        WHERE case_id = ? AND mall = 'amazon' AND report_type = ? AND date BETWEEN ? AND ?`
    )
    .bind(caseId, SALES_TRAFFIC, from, to)
    .all<{ date: string; status: string }>();

  const byDate = new Map(jobs.map((j) => [j.date, j.status]));
  const finished = jobs.filter((j) => j.status === "done" || j.status === "empty").length;

  // 1) 依頼済みのものを取りに行く（古い順＝依頼が古い順に片づける）
  const waiting = jobs.filter((j) => j.status === "requested" || j.status === "error")
    .map((j) => j.date).sort();
  for (const date of waiting) {
    if (Date.now() > deadline) break;
    await advance(env, caseId, date);
    await reapplyDiscounts(env, caseId, date);
  }

  // 2) まだ依頼していない日を、新しい日から順に依頼する
  const todo: string[] = [];
  for (let d = to; d >= from; d = new Date(Date.parse(d) - 86400000).toISOString().slice(0, 10)) {
    if (!byDate.has(d)) todo.push(d);
  }
  for (const date of todo) {
    if (Date.now() > deadline) break;
    const r = await advance(env, caseId, date);
    if (r.status === "error" && /quota|throttl|429/i.test(r.message)) break;   // 呼び出し制限に当たったら今回はここまで
    if (r.status === "done" || r.status === "empty") await reapplyDiscounts(env, caseId, date);
  }

  // 進み具合を数え直す
  const after = await env.DB
    .prepare(
      `SELECT COUNT(*) AS n FROM report_jobs
        WHERE case_id = ? AND mall = 'amazon' AND report_type = ? AND date BETWEEN ? AND ?
          AND status IN ('done','empty')`
    )
    .bind(caseId, SALES_TRAFFIC, from, to)
    .first<{ n: number }>();
  const done = after?.n ?? finished;
  const total = Number(state.total ?? 0);
  const more = done < total;

  await env.DB.prepare(
    `UPDATE backfill SET done = ?, status = ?, updated_at = datetime('now')
      WHERE case_id = ? AND kind = 'traffic'`
  ).bind(done, more ? "running" : "done", caseId).run();

  return { more };
}

/**
 * レポートの取り込みは日次売上の行を作り直すので、
 * 注文から拾った値引き額が消える。入れ直しておく
 */
async function reapplyDiscounts(env: BackfillEnv, caseId: string, date: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE daily_sales SET discounts = COALESCE((
        SELECT SUM(oi.discount) FROM order_items oi
         WHERE oi.case_id = daily_sales.case_id AND oi.mall = 'amazon'
           AND oi.date = daily_sales.date AND oi.product_id IS daily_sales.product_id), 0)
      WHERE case_id = ? AND mall = 'amazon' AND date = ?`
  ).bind(caseId, date).run();
}

/* ───────── 入金明細 ───────── */

async function stepFinances(
  env: BackfillEnv & FinanceEnv, caseId: string, state: Record<string, string | number | null>, deadline: number
): Promise<{ more: boolean; days: number }> {
  const from = String(state.from_date);
  let cursor = state.cursor == null ? String(state.to_date) : String(state.cursor);
  let days = 0;

  while (Date.now() < deadline && cursor >= from) {
    await ingestFinances(env, caseId, cursor);
    days++;
    cursor = new Date(Date.parse(cursor) - 86400000).toISOString().slice(0, 10);
  }

  const finished = cursor < from;
  await env.DB.prepare(
    `UPDATE backfill SET cursor = ?, done = done + ?, status = ?, updated_at = datetime('now')
      WHERE case_id = ? AND kind = 'finances'`
  ).bind(cursor, days, finished ? "done" : "running", caseId).run();

  return { more: !finished, days };
}

/* ───────── 入口 ───────── */

/**
 * 進行中の取り込みを、決めた時間だけ進める。
 * 画面から呼ぶときは50秒ほど、バッチから呼ぶときは長めに取る
 */
export async function runBackfill(
  env: BackfillEnv & FinanceEnv,
  opts: { caseId?: string; budgetMs?: number } = {}
): Promise<{ progress: Progress[]; worked: boolean }> {
  const deadline = Date.now() + (opts.budgetMs ?? 50000);

  const { results } = await env.DB
    .prepare(
      // 必ず orders → traffic → finances の順。traffic が日次売上を作り直すため
      `SELECT * FROM backfill WHERE status = 'running' ${opts.caseId ? "AND case_id = ?" : ""}
        ORDER BY CASE kind WHEN 'orders' THEN 1 WHEN 'traffic' THEN 2 ELSE 3 END, case_id`
    )
    .bind(...(opts.caseId ? [opts.caseId] : []))
    .all<Record<string, string | number | null>>();

  let worked = false;
  for (const state of results) {
    if (Date.now() > deadline) break;
    const caseId = String(state.case_id);
    const creds = await readCreds(env, caseId, "amazon");
    if (!creds?.refresh_token) {
      await env.DB.prepare("UPDATE backfill SET status = 'error', note = ? WHERE case_id = ? AND kind = ?")
        .bind("Amazon の接続情報が未登録です", caseId, String(state.kind)).run();
      continue;
    }
    let token: string;
    try {
      token = await accessToken(env, creds.refresh_token);
    } catch (e) {
      await env.DB.prepare("UPDATE backfill SET status = 'error', note = ? WHERE case_id = ? AND kind = ?")
        .bind(String(e).slice(0, 200), caseId, String(state.kind)).run();
      continue;
    }

    try {
      if (state.kind === "orders") {
        const r = await stepOrders(env, caseId, token, state, deadline);
        if (r.note) {
          await env.DB.prepare("UPDATE backfill SET note = ? WHERE case_id = ? AND kind = 'orders'")
            .bind(r.note, caseId).run();
        }
      } else if (state.kind === "traffic") {
        await stepTraffic(env, caseId, state, deadline);
      } else {
        await stepFinances(env, caseId, state, deadline);
      }
      worked = true;
    } catch (e) {
      await env.DB.prepare("UPDATE backfill SET status = 'error', note = ? WHERE case_id = ? AND kind = ?")
        .bind(String(e).slice(0, 200), caseId, String(state.kind)).run();
    }
  }

  return { progress: await backfillStatus(env, opts.caseId), worked };
}
