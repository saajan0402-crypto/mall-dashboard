/**
 * Slack への通知
 *
 * 送り先は案件ごと。案件に Webhook が登録されていなければ、全体の Webhook（SLACK_WEBHOOK_URL）に
 * 案件名をつけて送る。Webhook URL は知っていれば誰でも投稿できる鍵なので、暗号化して保存する。
 */

import { seal, open, mask } from "./crypto";

export interface SlackEnv {
  DB: D1Database;
  SECRET_KEY?: string;
  SLACK_WEBHOOK_URL?: string;
}

const jst = (n = 0) => new Date(Date.now() + 9 * 3600 * 1000 - n * 86400000).toISOString().slice(0, 10);

/** 案件の Webhook。無ければ null */
async function caseWebhook(env: SlackEnv, caseId: string): Promise<string | null> {
  if (!env.SECRET_KEY) return null;
  const r = await env.DB.prepare("SELECT webhook_enc FROM case_slack WHERE case_id = ?").bind(caseId)
    .first<{ webhook_enc: string | null }>();
  if (!r?.webhook_enc) return null;
  try { return (await open<{ url: string }>(env.SECRET_KEY, r.webhook_enc)).url; } catch { return null; }
}

/**
 * 送る。caseId を渡すと案件のチャンネルへ、無ければ全体のチャンネルへ。
 * 全体のチャンネルに送るときは、どの案件の話か分かるよう先頭に案件名をつける
 */
export async function postSlack(
  env: SlackEnv, caseId: string | null, text: string,
): Promise<{ ok: boolean; where: "case" | "company" | null; message: string }> {
  let url: string | null = null, where: "case" | "company" | null = null;
  if (caseId) { url = await caseWebhook(env, caseId); if (url) where = "case"; }
  if (!url && env.SLACK_WEBHOOK_URL) { url = env.SLACK_WEBHOOK_URL; where = "company"; }
  if (!url) return { ok: false, where: null, message: "Slack の送り先が登録されていません" };
  let body = text;
  if (where === "company" && caseId) {
    const c = await env.DB.prepare("SELECT name FROM cases WHERE id = ?").bind(caseId).first<{ name: string }>();
    if (c && !text.includes(c.name)) body = `【${c.name}】\n${text}`;
  }
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: body }) });
  const msg = res.ok ? "送信しました" : `Slack に拒否されました：HTTP ${res.status} ${(await res.text()).slice(0, 200)}`;
  return { ok: res.ok, where, message: msg };
}

/** 案件ごとの通知先（画面用。URL そのものは返さない） */
export async function listCaseSlack(env: SlackEnv) {
  const { results } = await env.DB.prepare(
    `SELECT c.id, c.name, s.webhook_enc, s.channel, COALESCE(s.daily_summary, 1) AS daily_summary, s.updated_by, s.updated_at
       FROM cases c LEFT JOIN case_slack s ON s.case_id = c.id WHERE c.status = 'active' ORDER BY c.name`
  ).all<Record<string, string | number | null>>();
  const out = [];
  for (const r of results) {
    let masked: string | null = null;
    if (r.webhook_enc && env.SECRET_KEY) {
      try { masked = mask((await open<{ url: string }>(env.SECRET_KEY, String(r.webhook_enc))).url); } catch { masked = "（読めません）"; }
    }
    out.push({ caseId: String(r.id), caseName: String(r.name), webhook: masked, channel: r.channel == null ? null : String(r.channel),
      dailySummary: Number(r.daily_summary) === 1, updatedBy: r.updated_by, updatedAt: r.updated_at });
  }
  return { cases: out, company: Boolean(env.SLACK_WEBHOOK_URL) };
}

/** 案件の通知先を保存する。webhook は空なら変更しない、"-" なら削除 */
export async function saveCaseSlack(
  env: SlackEnv, caseId: string, v: { webhook?: string; channel?: string | null; dailySummary?: boolean }, by: string | null,
): Promise<void> {
  if (!env.SECRET_KEY) throw new Error("SECRET_KEY が未設定です");
  const w = (v.webhook ?? "").trim();
  if (w && w !== "-" && !/^https:\/\/hooks\.slack\.com\/services\//.test(w)) {
    throw new Error("Slack の Incoming Webhook URL（https://hooks.slack.com/services/…）を入れてください");
  }
  const cur = await env.DB.prepare("SELECT webhook_enc FROM case_slack WHERE case_id = ?").bind(caseId).first<{ webhook_enc: string | null }>();
  const enc = w === "-" ? null : w ? await seal(env.SECRET_KEY, { url: w }) : cur?.webhook_enc ?? null;
  await env.DB.prepare(
    `INSERT INTO case_slack (case_id, webhook_enc, channel, daily_summary, updated_by, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(case_id) DO UPDATE SET webhook_enc = excluded.webhook_enc, channel = excluded.channel,
       daily_summary = excluded.daily_summary, updated_by = excluded.updated_by, updated_at = excluded.updated_at`
  ).bind(caseId, enc, v.channel?.trim() || null, v.dailySummary === false ? 0 : 1, by).run();
}

/** 毎朝の日次サマリを送る対象の案件 */
export async function summaryCases(env: SlackEnv): Promise<string[]> {
  const { results } = await env.DB.prepare(
    `SELECT c.id FROM cases c LEFT JOIN case_slack s ON s.case_id = c.id
      WHERE c.status = 'active' AND COALESCE(s.daily_summary, 1) = 1
        AND EXISTS (SELECT 1 FROM case_malls m WHERE m.case_id = c.id AND m.credentials_enc IS NOT NULL)`
  ).all<{ id: string }>();
  return results.map((r) => r.id);
}

export { jst as slackJst };
