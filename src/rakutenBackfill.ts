/**
 * 楽天の過去の売上の取り込み
 *
 * ふだんの取り込み（pumpRakuten）は直近7日だけ。接続したばかりの案件は、それより前の月が空のままになる
 * （2026-11 Monchouchou の10月が、楽天・Amazonとも実際よりずっと少なく出ていた原因の一つ）。
 * 30日ずつ、新しい方から古い方へさかのぼって ingestRakutenSales を呼ぶ。期間ごとに消して入れ直すので、何度やっても二重にならない
 */

import { ingestRakutenSales, type RakutenEnv } from "./ingestRakuten";
import { recalcFeeEst } from "./settings";

const day = (d: string, add: number) => new Date(Date.parse(`${d}T00:00:00Z`) + add * 86400000).toISOString().slice(0, 10);
const jstDay = (offset: number) => new Date(Date.now() + 9 * 3600000 - offset * 86400000).toISOString().slice(0, 10);

export async function startRakutenBackfill(db: D1Database, caseId: string, days: number, by: string | null) {
  const d = Math.min(730, Math.max(30, Math.round(days)));
  await db.prepare(
    `INSERT INTO rakuten_backfill (case_id, from_date, cursor, status, windows, orders, fails, error, started_by)
     VALUES (?, ?, ?, 'running', 0, 0, 0, NULL, ?)
     ON CONFLICT(case_id) DO UPDATE SET from_date = excluded.from_date, cursor = excluded.cursor, status = 'running',
       windows = 0, orders = 0, fails = 0, error = NULL, started_by = excluded.started_by, updated_at = datetime('now')`
  ).bind(caseId, jstDay(d), jstDay(8), by).run();
  return rakutenBackfillStatus(db, caseId);
}

export async function rakutenBackfillStatus(db: D1Database, caseId: string) {
  return db.prepare("SELECT * FROM rakuten_backfill WHERE case_id = ?").bind(caseId).first<Record<string, string | number | null>>();
}

/** 5分ごとの実行と、画面を開いている間の両方から呼ぶ */
export async function runRakutenBackfill(env: RakutenEnv, opts: { budgetMs?: number; caseId?: string } = {}): Promise<number> {
  const deadline = Date.now() + (opts.budgetMs ?? 40000);
  const { results } = await env.DB.prepare(
    `SELECT * FROM rakuten_backfill WHERE status = 'running' ${opts.caseId ? "AND case_id = ?" : ""}`
  ).bind(...(opts.caseId ? [opts.caseId] : [])).all<{ case_id: string; from_date: string; cursor: string; fails: number }>();
  let done = 0;
  for (const r of results) {
    let cursor = r.cursor;
    let fails = r.fails;
    while (Date.now() < deadline && cursor >= r.from_date) {
      const from = day(cursor, -29) < r.from_date ? r.from_date : day(cursor, -29);
      const out = await ingestRakutenSales(env, r.case_id, from, cursor)
        .catch((e) => ({ status: "error" as const, message: String(e instanceof Error ? e.message : e), rows: 0 }));
      if (out.status === "error") {
        fails++;
        await env.DB.prepare(
          `UPDATE rakuten_backfill SET fails = ?, error = ?, status = ?, updated_at = datetime('now') WHERE case_id = ?`
        ).bind(fails, `${from}〜${cursor}：${out.message}`, fails >= 3 ? "error" : "running", r.case_id).run();
        break;
      }
      cursor = day(from, -1);
      done++;
      await env.DB.prepare(
        `UPDATE rakuten_backfill SET cursor = ?, windows = windows + 1, orders = orders + ?, fails = 0, error = NULL,
           status = ?, updated_at = datetime('now') WHERE case_id = ?`
      ).bind(cursor, Number(out.rows ?? 0), cursor < r.from_date ? "done" : "running", r.case_id).run();
      fails = 0;
    }
    // 取り込んだ日の手数料の概算（料率＋RSLの暫定物流費）を入れる
    if (cursor !== r.cursor) await recalcFeeEst(env.DB, r.case_id, "rakuten");
  }
  return done;
}
