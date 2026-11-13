/**
 * 外部広告費（モールの外の広告。SNS広告・インフルエンサーなど）
 *
 * - 案件×月の合計を、税別で手入力する（ダッシュボードの「外部広告費」から）
 * - 期間の集計では、月の金額をその月の日数で割って日ごとに按分する。
 *   月の途中を見ているとき（今月など）は、期間に入っている日数ぶんだけが乗る
 * - ROAS・ACoS・TACoS には入れない（モールの広告の効率を見る数字なので）。
 *   「広告費を引いた利益」からは引く
 */

const daysIn = (month: string) => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
const dayNum = (d: string) => Math.round(Date.parse(`${d}T00:00:00Z`) / 86400000);

export interface ExternalAdCost {
  /** 期間に按分した合計（税別） */
  total: number;
  months: Array<{ month: string; amount: number; days: number; daysInMonth: number; allocated: number }>;
}

/** 期間 from〜to に乗る外部広告費 */
export async function externalAdCost(db: D1Database, caseId: string, from: string, to: string): Promise<ExternalAdCost> {
  const { results } = await db.prepare(
    "SELECT month, amount FROM external_ads WHERE case_id = ? AND month BETWEEN ? AND ? ORDER BY month"
  ).bind(caseId, from.slice(0, 7), to.slice(0, 7)).all<{ month: string; amount: number }>().catch(() => ({ results: [] as Array<{ month: string; amount: number }> }));
  const months: ExternalAdCost["months"] = [];
  let total = 0;
  for (const r of results) {
    const dim = daysIn(r.month);
    const mFrom = `${r.month}-01`, mTo = `${r.month}-${String(dim).padStart(2, "0")}`;
    const s = from > mFrom ? from : mFrom, e = to < mTo ? to : mTo;
    const days = Math.max(0, dayNum(e) - dayNum(s) + 1);
    if (!days) continue;
    const allocated = Math.round((Number(r.amount) * days) / dim);
    months.push({ month: r.month, amount: Number(r.amount), days, daysInMonth: dim, allocated });
    total += allocated;
  }
  return { total, months };
}

/** 月ごとの手入力の金額（外部広告費・月の広告予算）。同じ形のテーブル */
export type MonthlyTable = "external_ads" | "ad_budgets";

/** 入力画面用：直近 n か月（今月を含む）と、その月の金額 */
export async function listExternalAds(db: D1Database, caseId: string, months = 13) {
  return listMonthly(db, "external_ads", caseId, months);
}
export async function listMonthly(db: D1Database, table: MonthlyTable, caseId: string, months = 13) {
  const now = new Date(Date.now() + 9 * 3600000);
  const list: string[] = [];
  for (let i = 0; i < months; i++) list.push(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1)).toISOString().slice(0, 7));
  const { results } = await db.prepare(
    `SELECT month, amount, updated_by, updated_at FROM ${table} WHERE case_id = ? ORDER BY month DESC`
  ).bind(caseId).all<{ month: string; amount: number; updated_by: string | null; updated_at: string }>();
  const map = new Map(results.map((r) => [r.month, r]));
  // 入力済みの古い月も消えないように出す
  for (const r of results) if (!list.includes(r.month)) list.push(r.month);
  return list.sort().reverse().map((m) => ({ month: m, amount: map.get(m)?.amount ?? null,
    updatedBy: map.get(m)?.updated_by ?? null, updatedAt: map.get(m)?.updated_at ?? null }));
}

/** 保存。amount が null なら消す */
export async function saveExternalAds(db: D1Database, caseId: string, rows: Array<{ month: string; amount: number | null }>, by: string | null) {
  return saveMonthly(db, "external_ads", caseId, rows, by);
}
export async function saveMonthly(db: D1Database, table: MonthlyTable, caseId: string, rows: Array<{ month: string; amount: number | null }>, by: string | null) {
  const stmts: D1PreparedStatement[] = [];
  for (const r of rows) {
    if (!/^\d{4}-\d{2}$/.test(r.month)) throw new Error(`月の形が正しくありません：${r.month}`);
    if (r.amount == null) {
      stmts.push(db.prepare(`DELETE FROM ${table} WHERE case_id = ? AND month = ?`).bind(caseId, r.month));
    } else {
      const a = Math.round(Number(r.amount));
      if (!Number.isFinite(a) || a < 0) throw new Error(`${r.month} の金額が正しくありません`);
      stmts.push(db.prepare(
        `INSERT INTO ${table} (case_id, month, amount, updated_by) VALUES (?, ?, ?, ?)
         ON CONFLICT(case_id, month) DO UPDATE SET amount = excluded.amount, updated_by = excluded.updated_by, updated_at = datetime('now')`
      ).bind(caseId, r.month, a, by));
    }
  }
  if (stmts.length) await db.batch(stmts);
}

/** 月の広告予算（Amazon＋楽天の合計・税別）。無ければ null */
export async function adBudgetOf(db: D1Database, caseId: string, month: string): Promise<number | null> {
  const r = await db.prepare("SELECT amount FROM ad_budgets WHERE case_id = ? AND month = ?").bind(caseId, month)
    .first<{ amount: number }>().catch(() => null);
  return r?.amount == null ? null : Number(r.amount);
}
