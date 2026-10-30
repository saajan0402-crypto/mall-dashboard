/**
 * Amazon の日次売上の取り込み
 *
 * 売上・トラフィックレポートを1日1本依頼し、SKU単位の販売数・売上・
 * セッション数を daily_sales に入れる。
 *
 * 案件の切り分けは商品マスタで行う。同じセラーアカウントに複数案件が
 * 入っていても、その案件に登録されているSKUの行だけを取る。
 * どの案件にも登録されていないSKUは「未登録」として件数と名前を残し、
 * 商品マスタに足してもらう手がかりにする。
 */

import { readCreds, type ConnEnv } from "./connections";
import { accessToken, type LwaEnv } from "./amazon";
import {
  SALES_TRAFFIC, requestDailyReport, checkReport, downloadReport, parseSalesTraffic,
  type SalesTrafficRow,
} from "./spReports";

export interface IngestEnv extends ConnEnv, LwaEnv {
  FILES: R2Bucket;
}

export interface IngestOutcome {
  caseId: string;
  date: string;
  status: "requested" | "waiting" | "done" | "empty" | "error";
  message: string;
  rows?: number;
  unknownSkus?: string[];
}

/** 日本時間の日付（YYYY-MM-DD）。offset 日前 */
export function jstDate(offsetDays = 0): string {
  const d = new Date(Date.now() + 9 * 60 * 60 * 1000 - offsetDays * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

/* ───────── 保存 ───────── */

interface Listing {
  sku: string;
  product_id: string;
  case_id: string;
}

/** Amazon SKU から商品を引くための対応表。全案件ぶん読む */
async function skuMap(db: D1Database): Promise<Map<string, Listing>> {
  const { results } = await db
    .prepare(
      `SELECT l.external_id AS sku, l.product_id, p.case_id
         FROM product_listings l
         JOIN products p ON p.id = l.product_id
        WHERE l.mall = 'amazon'`
    )
    .all<Listing>();
  const m = new Map<string, Listing>();
  for (const r of results) m.set(r.sku, r);
  return m;
}

/**
 * 1日分を書き込む。
 * レポートはその日の全量なので、先にその日の行を消してから入れ直す。
 * 同じ日を何度取り込んでも二重にならない
 */
async function writeDay(
  db: D1Database,
  caseId: string,
  date: string,
  rows: SalesTrafficRow[],
  map: Map<string, Listing>
): Promise<{ saved: number; unknown: string[] }> {
  const mine: Array<{ productId: string; row: SalesTrafficRow }> = [];
  const unknown: string[] = [];

  for (const row of rows) {
    const hit = map.get(row.sku);
    if (!hit) {
      // どの案件にも無いSKU。マスタ登録漏れの可能性があるので名前を残す
      if (row.units > 0 || row.revenue > 0) unknown.push(row.sku);
      continue;
    }
    if (hit.case_id !== caseId) continue;          // 別案件のSKU。ここでは扱わない
    mine.push({ productId: hit.product_id, row });
  }

  const statements: D1PreparedStatement[] = [
    db.prepare("DELETE FROM daily_sales WHERE case_id = ? AND mall = 'amazon' AND date = ?").bind(caseId, date),
  ];
  for (const { productId, row } of mine) {
    statements.push(
      db
        .prepare(
          `INSERT INTO daily_sales (case_id, mall, product_id, date, units, revenue, sessions, page_views, source)
           VALUES (?, 'amazon', ?, ?, ?, ?, ?, ?, 'api')`
        )
        .bind(caseId, productId, date, row.units, row.revenue, row.sessions, row.pageViews)
    );
  }
  await db.batch(statements);
  return { saved: mine.length, unknown };
}

/* ───────── レポートの進行管理 ───────── */

async function jobFor(db: D1Database, caseId: string, date: string) {
  return db
    .prepare("SELECT * FROM report_jobs WHERE case_id = ? AND mall = 'amazon' AND report_type = ? AND date = ?")
    .bind(caseId, SALES_TRAFFIC, date)
    .first<{
      id: string; report_id: string | null; status: string; attempts: number;
    }>();
}

async function upsertJob(
  db: D1Database,
  caseId: string,
  date: string,
  patch: { reportId?: string | null; status: string; error?: string | null; rows?: number; r2Key?: string | null }
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO report_jobs (id, case_id, mall, report_type, date, report_id, status, attempts, rows, error, r2_key)
       VALUES (?, ?, 'amazon', ?, ?, ?, ?, 1, ?, ?, ?)
       ON CONFLICT(case_id, mall, report_type, date) DO UPDATE SET
         report_id = COALESCE(excluded.report_id, report_jobs.report_id),
         status = excluded.status,
         attempts = report_jobs.attempts + 1,
         rows = excluded.rows,
         error = excluded.error,
         r2_key = COALESCE(excluded.r2_key, report_jobs.r2_key),
         updated_at = datetime('now')`
    )
    .bind(
      crypto.randomUUID(), caseId, SALES_TRAFFIC, date,
      patch.reportId ?? null, patch.status, patch.rows ?? 0, patch.error ?? null, patch.r2Key ?? null
    )
    .run();
}

/** 取り込みの履歴に1件残す */
async function logIngest(
  db: D1Database,
  caseId: string,
  date: string,
  rows: number,
  status: "ok" | "error",
  note: string | null,
  r2Key: string | null
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO ingests (id, case_id, mall, kind, period_start, period_end, rows, status, error, r2_key, source)
       VALUES (?, ?, 'amazon', 'sales', ?, ?, ?, ?, ?, ?, 'api')`
    )
    .bind(crypto.randomUUID(), caseId, date, date, rows, status, note, r2Key)
    .run();
}

/* ───────── 入口 ───────── */

/**
 * 1案件1日ぶんを進める。
 *   - まだ依頼していなければ依頼する（戻り値は requested）
 *   - 依頼済みなら取りに行く（生成中なら waiting）
 * wait を true にすると、その場で最大 maxWaitMs だけ生成を待つ（画面から押したとき用）
 */
export async function advance(
  env: IngestEnv,
  caseId: string,
  date: string,
  opts: { wait?: boolean; maxWaitMs?: number } = {}
): Promise<IngestOutcome> {
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

  let job = await jobFor(env.DB, caseId, date);

  // まだ依頼していない、または前回失敗していれば依頼する
  if (!job?.report_id || job.status === "error") {
    const req = await requestDailyReport(token, SALES_TRAFFIC, date);
    if (!req.ok) {
      await upsertJob(env.DB, caseId, date, { status: "error", error: req.message });
      await logIngest(env.DB, caseId, date, 0, "error", req.message, null);
      return { caseId, date, status: "error", message: req.message };
    }
    await upsertJob(env.DB, caseId, date, { reportId: req.reportId, status: "requested", error: null });
    job = await jobFor(env.DB, caseId, date);
    if (!opts.wait) {
      return { caseId, date, status: "requested", message: "レポートを依頼しました。生成まで数分かかります" };
    }
  }

  const reportId = job?.report_id;
  if (!reportId) return { caseId, date, status: "error", message: "レポートIDが残っていません" };

  // 状態を見る。画面から押されたときだけ、その場で少し待つ
  const deadline = Date.now() + (opts.maxWaitMs ?? 0);
  let st = await checkReport(token, reportId);
  while (opts.wait && st.state === "waiting" && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 15000));
    st = await checkReport(token, reportId);
  }

  if (st.state === "waiting") {
    await upsertJob(env.DB, caseId, date, { status: "requested", error: null });
    return { caseId, date, status: "waiting", message: "まだ生成中です。あとでもう一度取りに行きます" };
  }
  if (st.state === "empty") {
    await upsertJob(env.DB, caseId, date, { status: "empty", error: null });
    await logIngest(env.DB, caseId, date, 0, "ok", "対象データがありませんでした", null);
    return { caseId, date, status: "empty", message: "その日は対象データがありませんでした" };
  }
  if (st.state === "failed" || !st.documentId) {
    await upsertJob(env.DB, caseId, date, { status: "error", error: st.message });
    await logIngest(env.DB, caseId, date, 0, "error", st.message, null);
    return { caseId, date, status: "error", message: st.message };
  }

  const dl = await downloadReport(token, st.documentId);
  if (!dl.ok || !dl.text) {
    await upsertJob(env.DB, caseId, date, { status: "error", error: dl.message });
    await logIngest(env.DB, caseId, date, 0, "error", dl.message, null);
    return { caseId, date, status: "error", message: dl.message };
  }

  // 生データは消さずに残す。あとから計算をやり直せるようにするため
  const r2Key = `raw/amazon/sales_traffic/${caseId}/${date}.json`;
  await env.FILES.put(r2Key, dl.text, { httpMetadata: { contentType: "application/json" } });

  let parsed: { rows: SalesTrafficRow[] };
  try {
    parsed = parseSalesTraffic(dl.text);
  } catch (e) {
    const msg = `レポートの中身を読めませんでした：${String(e)}`;
    await upsertJob(env.DB, caseId, date, { status: "error", error: msg, r2Key });
    await logIngest(env.DB, caseId, date, 0, "error", msg, r2Key);
    return { caseId, date, status: "error", message: msg };
  }

  const map = await skuMap(env.DB);
  const { saved, unknown } = await writeDay(env.DB, caseId, date, parsed.rows, map);

  const note = unknown.length
    ? `商品マスタに無いSKUが ${unknown.length} 件：${unknown.slice(0, 10).join(", ")}`
    : null;
  await upsertJob(env.DB, caseId, date, { status: "done", error: note, rows: saved, r2Key });
  await logIngest(env.DB, caseId, date, saved, "ok", note, r2Key);

  return {
    caseId, date, status: "done", rows: saved, unknownSkus: unknown,
    message: `${saved} 商品ぶんを取り込みました${note ? `（${note}）` : ""}`,
  };
}

/**
 * 日次バッチ用。全案件について、未取得の日を古い順に進める。
 * 1回の実行で欲張らず、案件ごとに数日ぶんだけ触る
 */
export async function pump(env: IngestEnv, opts: { days?: number; perCase?: number } = {}): Promise<IngestOutcome[]> {
  const days = opts.days ?? 7;            // どこまで遡って穴を埋めるか
  const perCase = opts.perCase ?? 3;      // 1回の実行で1案件あたり触る日数

  const { results: cases } = await env.DB.prepare(
    `SELECT c.id FROM cases c
       JOIN case_malls m ON m.case_id = c.id AND m.mall = 'amazon' AND m.credentials_enc IS NOT NULL
      WHERE c.status = 'active'`
  ).all<{ id: string }>();

  const out: IngestOutcome[] = [];
  for (const c of cases) {
    // 当日は確定していないので前日から。古い日を先に片づける
    const targets: string[] = [];
    for (let i = days; i >= 1; i--) targets.push(jstDate(i));

    let touched = 0;
    for (const date of targets) {
      if (touched >= perCase) break;
      const job = await jobFor(env.DB, c.id, date);
      if (job?.status === "done" || job?.status === "empty") continue;
      out.push(await advance(env, c.id, date));
      touched++;
    }
  }
  return out;
}
