/**
 * 案件の管理（追加・名前の変更・休止・設定のコピー・通知のオン/オフ）
 *
 * 案件は消さない。休止（archived）にすると、毎朝の取り込みと通知の対象から外れ、
 * ヘッダーの案件一覧にも出なくなる。データはそのまま残るので、再開すれば元通り見られる。
 */

import { SETTINGS, saveSettings } from "./settings";

export type NotifyKind = "daily_summary" | "stock_alert" | "settings_notice" | "license_alert";
export const NOTIFY_KINDS: NotifyKind[] = ["daily_summary", "stock_alert", "settings_notice", "license_alert"];

/** 通知がオンか（登録が無ければオン） */
export async function notifyEnabled(db: D1Database, caseId: string, kind: NotifyKind): Promise<boolean> {
  const r = await db.prepare(`SELECT ${kind} AS v FROM case_slack WHERE case_id = ?`).bind(caseId).first<{ v: number }>();
  return r == null || Number(r.v) === 1;
}

export async function setNotify(db: D1Database, caseId: string, v: Partial<Record<NotifyKind, boolean>>, by: string | null) {
  const cols = NOTIFY_KINDS.filter((k) => typeof v[k] === "boolean");
  if (!cols.length) return;
  await db.prepare(`INSERT OR IGNORE INTO case_slack (case_id) VALUES (?)`).bind(caseId).run();
  await db.prepare(
    `UPDATE case_slack SET ${cols.map((c) => `${c} = ?`).join(", ")}, updated_by = ?, updated_at = datetime('now') WHERE case_id = ?`
  ).bind(...cols.map((c) => (v[c] ? 1 : 0)), by, caseId).run();
}

/** 一覧（休止中も含む）。新しい案件の準備がどこまで済んだかも一緒に返す */
export async function listAllCases(db: D1Database) {
  const { results } = await db.prepare(
    `SELECT c.id, c.name, c.status, c.created_at,
            (SELECT COUNT(*) FROM products p WHERE p.case_id = c.id AND p.status = 'active') AS products,
            (SELECT COUNT(*) FROM case_malls m WHERE m.case_id = c.id AND m.mall = 'amazon' AND m.credentials_enc IS NOT NULL) AS amazon,
            (SELECT COUNT(*) FROM case_malls m WHERE m.case_id = c.id AND m.mall = 'rakuten' AND m.credentials_enc IS NOT NULL) AS rakuten,
            (SELECT COUNT(*) FROM settings st WHERE st.scope IN ('case', 'case_mall') AND (st.scope_id = c.id OR st.scope_id LIKE c.id || ':%')) AS settings,
            (SELECT MAX(date) FROM daily_sales s WHERE s.case_id = c.id) AS last_sales,
            (SELECT MIN(date) FROM daily_sales s WHERE s.case_id = c.id) AS first_sales,
            (SELECT MAX(date) FROM daily_ads a WHERE a.case_id = c.id) AS last_ads,
            s.webhook_enc IS NOT NULL AS slack, s.channel,
            COALESCE(s.daily_summary, 1) AS daily_summary, COALESCE(s.stock_alert, 1) AS stock_alert,
            COALESCE(s.settings_notice, 1) AS settings_notice, COALESCE(s.license_alert, 1) AS license_alert
       FROM cases c LEFT JOIN case_slack s ON s.case_id = c.id
      ORDER BY c.status = 'active' DESC, c.name`
  ).all<Record<string, string | number | null>>();
  return results.map((r) => ({
    id: String(r.id), name: String(r.name), status: String(r.status), createdAt: String(r.created_at),
    products: Number(r.products), amazon: Number(r.amazon) > 0, rakuten: Number(r.rakuten) > 0,
    hasSettings: Number(r.settings) > 0, firstSales: r.first_sales, lastSales: r.last_sales, lastAds: r.last_ads,
    slack: Number(r.slack) === 1, channel: r.channel,
    notify: Object.fromEntries(NOTIFY_KINDS.map((k) => [k, Number(r[k]) === 1])) as Record<NotifyKind, boolean>,
  }));
}

const cleanName = (s: string) => s.replace(/\s+/g, " ").trim();

export async function createCase(db: D1Database, name: string): Promise<string> {
  const n = cleanName(name);
  if (!n) throw new Error("案件名を入れてください");
  if (n.length > 40) throw new Error("案件名は40文字以内にしてください");
  const dup = await db.prepare("SELECT id FROM cases WHERE name = ?").bind(n).first();
  if (dup) throw new Error(`「${n}」はすでにあります`);
  const id = crypto.randomUUID();
  await db.prepare("INSERT INTO cases (id, name) VALUES (?, ?)").bind(id, n).run();
  return id;
}

export async function renameCase(db: D1Database, caseId: string, name: string): Promise<void> {
  const n = cleanName(name);
  if (!n) throw new Error("案件名を入れてください");
  const dup = await db.prepare("SELECT id FROM cases WHERE name = ? AND id <> ?").bind(n, caseId).first();
  if (dup) throw new Error(`「${n}」はすでにあります`);
  await db.prepare("UPDATE cases SET name = ? WHERE id = ?").bind(n, caseId).run();
}

export async function setCaseStatus(db: D1Database, caseId: string, status: "active" | "archived"): Promise<void> {
  if (!["active", "archived"].includes(status)) throw new Error("状態が不正です");
  await db.prepare("UPDATE cases SET status = ? WHERE id = ?").bind(status, caseId).run();
}

/**
 * 設定を別の案件からコピーする（案件の設定と、案件×モールの料率）。
 * 履歴に残すため saveSettings を通す。コピー元に無い項目は、コピー先でも「上の階層に従う」にそろえる
 */
export async function copySettings(db: D1Database, fromId: string, toId: string, by: string | null): Promise<number> {
  if (fromId === toId) throw new Error("同じ案件にはコピーできません");
  let changed = 0;
  for (const [scope, fromScope, toScope, keys] of [
    ["case", fromId, toId, SETTINGS.filter((d) => d.scopes.includes("case")).map((d) => d.key)],
    ["case_mall", `${fromId}:amazon`, `${toId}:amazon`, SETTINGS.filter((d) => d.scopes.includes("case_mall") && (!d.malls || d.malls.includes("amazon"))).map((d) => d.key)],
    ["case_mall", `${fromId}:rakuten`, `${toId}:rakuten`, SETTINGS.filter((d) => d.scopes.includes("case_mall") && (!d.malls || d.malls.includes("rakuten"))).map((d) => d.key)],
  ] as const) {
    const { results } = await db.prepare("SELECT key, value FROM settings WHERE scope = ? AND scope_id = ?")
      .bind(scope, fromScope).all<{ key: string; value: string }>();
    const src = new Map(results.map((r) => [r.key, Number(JSON.parse(r.value))]));
    const values: Record<string, number | null> = {};
    for (const k of keys) values[k] = src.has(k) ? src.get(k)! : null;
    changed += (await saveSettings(db, scope, toScope, values, by)).length;
  }
  return changed;
}
