/**
 * 要対応の状態（未対応／対応済み／今はしない）と、その記録
 *
 * 要対応はデータから毎回計算し直すので、項目ごとに決まった鍵（key）を持たせて状態を結びつける。
 *   - 在庫や赤字キャンペーンのように「対象」がはっきりしたもの … 対象で鍵を作る（stock:amazon:SKU など）
 *   - 入札の見直しのように毎週出直すもの … 週で鍵を作る（ad_bids:2026-W45）。「今週の見直しは済んだ」を記録する
 *
 * いったん消えた項目（3日以上出なかったもの）がまた出てきたら、新しい問題として未対応に戻す。
 * 例：在庫切れを手配して「対応済み」→ 在庫が戻る → 1か月後にまた在庫切れ → 未対応として出る
 *
 * 状態を変えた記録は todo_events にすべて残し、お客様向けレポートの「今月対応したこと」に使う。
 */

/** other ＝ 自由記述（例：お客様に通達済み）。中身はメモ欄に入れる */
export type TodoStatus = "open" | "done" | "skip" | "other";
export const STATUS_JA: Record<TodoStatus, string> = { open: "未対応", done: "対応済み", skip: "今はしない", other: "その他" };

const jst = (n = 0) => new Date(Date.now() + 9 * 3600 * 1000 - n * 86400000).toISOString().slice(0, 10);

/** ISO 週（月曜始まり）。例 2026-W45 */
export function isoWeek(day = jst(0)): string {
  const d = new Date(day + "T00:00:00Z");
  const dow = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dow + 3);              // その週の木曜
  const year = d.getUTCFullYear();
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const week = 1 + Math.round(((d.getTime() - jan4.getTime()) / 86400000 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

/** 文章から日数や金額を除いて、毎日少しずつ変わる注意書きにも同じ鍵がつくようにする */
export const textKey = (s: string) => s.replace(/[0-9０-９,，.¥%（）()〜~\-／/:：\s]/g, "").slice(0, 80);

export interface Statused {
  key: string;
  text: string;
  basis?: string;
  area: string;
  priority: string;
  status?: TodoStatus;
  statusBy?: string | null;
  statusAt?: string | null;
  note?: string | null;
}

/** 状態をつける。あわせて「最後に出た日」を更新し、しばらく消えていたものは未対応に戻す */
export async function applyTodoStatus<T extends Statused>(
  db: D1Database, caseId: string, todos: T[], opts: { write?: boolean } = {},
): Promise<T[]> {
  if (!todos.length) return todos;
  const today = jst(0), stale = jst(3);
  const { results } = await db.prepare(
    `SELECT key, status, updated_by, updated_at, last_seen, note FROM todo_status WHERE case_id = ?`
  ).bind(caseId).all<{ key: string; status: TodoStatus; updated_by: string | null; updated_at: string; last_seen: string | null; note: string | null }>();
  const map = new Map(results.map((r) => [r.key, r]));
  const writes: D1PreparedStatement[] = [];
  for (const t of todos) {
    const r = map.get(t.key);
    let status: TodoStatus = r?.status ?? "open";
    if (r && status !== "open" && r.last_seen && r.last_seen < stale) {
      // しばらく出ていなかった＝一度解決した問題がまた起きた
      status = "open";
      writes.push(db.prepare(
        `INSERT INTO todo_events (id, case_id, key, status, title, basis, area, note, changed_by, day)
         VALUES (?, ?, ?, 'open', ?, ?, ?, '再発のため未対応に戻しました', 'system', ?)`
      ).bind(crypto.randomUUID(), caseId, t.key, t.text, t.basis ?? null, t.area, today));
    }
    t.status = status;
    t.statusBy = status === "open" ? null : r?.updated_by ?? null;
    t.statusAt = status === "open" ? null : r?.updated_at ?? null;
    t.note = status === "open" ? null : r?.note ?? null;
    if (!r || r.last_seen !== today || status !== r.status) {
      writes.push(db.prepare(
        `INSERT INTO todo_status (case_id, key, status, title, basis, area, priority, last_seen)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(case_id, key) DO UPDATE SET last_seen = excluded.last_seen, title = excluded.title,
           basis = excluded.basis, priority = excluded.priority,
           status = CASE WHEN excluded.status = 'open' AND todo_status.status <> 'open' THEN 'open' ELSE todo_status.status END`
      ).bind(caseId, t.key, status, t.text, t.basis ?? null, t.area, t.priority, today));
    }
  }
  // 通知などの裏の処理から呼ぶときは書き込まない（「最後に出た日」は画面で見た期間を基準にする）
  if (writes.length && opts.write !== false) await db.batch(writes);
  return todos;
}

/** 状態を変える（画面から） */
export async function setTodoStatus(
  db: D1Database, caseId: string,
  v: { key: string; status: TodoStatus; text?: string; basis?: string | null; area?: string; priority?: string; note?: string | null },
  by: string | null,
): Promise<void> {
  if (!["open", "done", "skip", "other"].includes(v.status)) throw new Error("状態が不正です");
  if (v.status === "other" && !v.note?.trim()) throw new Error("自由記述の内容を入れてください");
  const today = jst(0);
  await db.batch([
    db.prepare(
      `INSERT INTO todo_status (case_id, key, status, title, basis, area, priority, note, updated_by, updated_at, last_seen)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)
       ON CONFLICT(case_id, key) DO UPDATE SET status = excluded.status, note = excluded.note,
         updated_by = excluded.updated_by, updated_at = excluded.updated_at,
         title = COALESCE(excluded.title, todo_status.title), basis = COALESCE(excluded.basis, todo_status.basis)`
    ).bind(caseId, v.key, v.status, v.text ?? null, v.basis ?? null, v.area ?? null, v.priority ?? null, v.note ?? null, by, today),
    db.prepare(
      `INSERT INTO todo_events (id, case_id, key, status, title, basis, area, note, changed_by, day)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(crypto.randomUUID(), caseId, v.key, v.status, v.text ?? null, v.basis ?? null, v.area ?? null, v.note ?? null, by, today),
  ]);
}

export interface DoneItem {
  key: string; title: string; basis: string | null; area: string | null; day: string; by: string | null; note: string | null;
  /** done ＝ 対応済み／other ＝ 自由記述（お客様に通達済み など） */
  status: "done" | "other";
}

/**
 * ある月に「対応済み」または自由記述（お客様に通達済み など）にしたもの。
 * 同じ項目を月の中で戻した場合は、月末時点（最後の操作）で判断する
 */
export async function doneInMonth(db: D1Database, caseId: string, month: string): Promise<DoneItem[]> {
  const { results } = await db.prepare(
    `SELECT e.key, e.status, e.title, e.basis, e.area, e.day, e.changed_by, e.note
       FROM todo_events e
      WHERE e.case_id = ? AND substr(e.day, 1, 7) = ? AND e.changed_by IS NOT 'system'
        AND e.changed_at = (SELECT MAX(changed_at) FROM todo_events x
                             WHERE x.case_id = e.case_id AND x.key = e.key AND substr(x.day, 1, 7) = ? AND x.changed_by IS NOT 'system')
      ORDER BY e.day, e.changed_at`
  ).bind(caseId, month, month).all<Record<string, string | null>>();
  return results.filter((r) => r.status === "done" || r.status === "other").map((r) => ({
    key: String(r.key), title: String(r.title ?? ""), basis: r.basis, area: r.area, day: String(r.day), by: r.changed_by, note: r.note,
    status: r.status as "done" | "other",
  }));
}

/** 期間の中で「対応済み」「自由記述」にしたもの（週次レポート用）。期間の最後の操作で判断する */
export async function actionsBetween(db: D1Database, caseId: string, from: string, to: string): Promise<DoneItem[]> {
  const { results } = await db.prepare(
    `SELECT e.key, e.status, e.title, e.basis, e.area, e.day, e.changed_by, e.note
       FROM todo_events e
      WHERE e.case_id = ? AND e.day BETWEEN ? AND ? AND e.changed_by IS NOT 'system'
        AND e.changed_at = (SELECT MAX(changed_at) FROM todo_events x
                             WHERE x.case_id = e.case_id AND x.key = e.key AND x.day BETWEEN ? AND ? AND x.changed_by IS NOT 'system')
      ORDER BY e.day, e.changed_at`
  ).bind(caseId, from, to, from, to).all<Record<string, string | null>>();
  return results.filter((r) => r.status === "done" || r.status === "other").map((r) => ({
    key: String(r.key), title: String(r.title ?? ""), basis: r.basis, area: r.area, day: String(r.day), by: r.changed_by, note: r.note,
    status: r.status as "done" | "other",
  }));
}

/** 「今はしない」にしたもの（画面でまとめて見せる） */
export async function skippedTodos(db: D1Database, caseId: string) {
  const { results } = await db.prepare(
    `SELECT key, title, basis, area, note, updated_by, updated_at FROM todo_status
      WHERE case_id = ? AND status = 'skip' ORDER BY updated_at DESC LIMIT 50`
  ).bind(caseId).all();
  return results;
}
