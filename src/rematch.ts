/**
 * 商品マスタを直したあとに、取り込み済みのデータを照合し直す
 *
 * Amazon のデータは「出品者SKU」で商品マスタと照らし合わせ、合わない行は商品に紐づかないまま残る
 * （売上は捨てられ、手数料は「商品に紐づかない費用」になる）。
 * 2026-11 Monchouchou で、マスタの Amazon SKU と ASIN が反対に入っていて、Amazon の売上がほぼ0になっていた。
 * マスタを直したら、API を呼び直さずに次の2段で照合し直す。
 *   1. すぐ：入金明細・注文明細・広告の行の商品を、SKU で付け直す（UPDATE だけなので一瞬）
 *   2. 裏で：日次売上を、R2 に残した売上・トラフィックレポートから作り直す（5分ごとの実行で少しずつ）
 */

import { reapplyStoredReport, type IngestEnv } from "./ingestSales";
import { reapplyDiscounts } from "./backfill";
import { recalcFeeEst } from "./settings";
import { SALES_TRAFFIC } from "./spReports";

const listingSql = (col: string, table: string) => `(SELECT l.product_id FROM product_listings l JOIN products p ON p.id = l.product_id
   WHERE l.mall = 'amazon' AND p.case_id = ${table}.case_id AND l.external_id = ${table}.${col} LIMIT 1)`;

export async function startRematch(db: D1Database, caseId: string): Promise<void> {
  await db.batch([
    db.prepare(`UPDATE fee_events SET product_id = ${listingSql("sku", "fee_events")}
                 WHERE case_id = ? AND mall = 'amazon' AND sku IS NOT NULL`).bind(caseId),
    db.prepare(`UPDATE order_items SET product_id = ${listingSql("sku", "order_items")}
                 WHERE case_id = ? AND mall = 'amazon' AND sku IS NOT NULL`).bind(caseId),
    db.prepare(`UPDATE daily_ads SET product_id = ${listingSql("external_id", "daily_ads")}
                 WHERE case_id = ? AND mall = 'amazon' AND external_id IS NOT NULL AND external_id <> ''`).bind(caseId),
    // 日次売上の作り直しは昨日から古い方へ。cursor を app_flags に置く
    db.prepare(`INSERT INTO app_flags (key, value) VALUES (?, ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`)
      .bind(`rematch:${caseId}`, new Date(Date.now() + 9 * 3600000 - 86400000).toISOString().slice(0, 10)),
  ]);
}

export async function rematchStatus(db: D1Database, caseId: string): Promise<{ running: boolean; cursor: string | null; from: string | null }> {
  const f = await db.prepare("SELECT value FROM app_flags WHERE key = ?").bind(`rematch:${caseId}`).first<{ value: string }>();
  const m = await db.prepare(
    "SELECT MIN(date) AS d FROM report_jobs WHERE case_id = ? AND mall = 'amazon' AND report_type = ? AND status = 'done'"
  ).bind(caseId, SALES_TRAFFIC).first<{ d: string | null }>();
  return { running: Boolean(f), cursor: f?.value ?? null, from: m?.d ?? null };
}

/** 5分ごとの実行と画面から呼ぶ */
export async function runRematch(env: IngestEnv, opts: { budgetMs?: number; caseId?: string } = {}): Promise<number> {
  const deadline = Date.now() + (opts.budgetMs ?? 40000);
  const { results } = await env.DB.prepare(
    `SELECT key, value FROM app_flags WHERE key ${opts.caseId ? "= ?" : "LIKE 'rematch:%'"}`
  ).bind(...(opts.caseId ? [`rematch:${opts.caseId}`] : [])).all<{ key: string; value: string }>();
  let n = 0;
  for (const f of results) {
    const caseId = f.key.slice("rematch:".length);
    const { from } = await rematchStatus(env.DB, caseId);
    let cursor = f.value;
    while (from && cursor >= from && Date.now() < deadline) {
      if (await reapplyStoredReport(env, caseId, cursor)) { await reapplyDiscounts(env, caseId, cursor); n++; }
      cursor = new Date(Date.parse(cursor) - 86400000).toISOString().slice(0, 10);
    }
    if (!from || cursor < from) {
      await env.DB.prepare("DELETE FROM app_flags WHERE key = ?").bind(f.key).run();
      await recalcFeeEst(env.DB, caseId, "amazon");
    } else {
      await env.DB.prepare("UPDATE app_flags SET value = ?, updated_at = datetime('now') WHERE key = ?").bind(cursor, f.key).run();
    }
  }
  return n;
}
