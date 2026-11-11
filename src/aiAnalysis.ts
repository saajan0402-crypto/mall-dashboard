/**
 * AI の週次分析（Claude API）
 *
 * - 案件の設定「AI分析」（ai_weekly）：0＝オフ（既定・API の利用料がかかるため）、1＝毎週月曜＋手動、2＝手動のみ
 * - 週に1回、広告の相談用データ＋キーワード発見の材料を Claude に渡し、新しいキーワード・競合を踏まえた提案を作る。
 *   Web 検索ツールを最大5回まで使わせる（競合の商品ページ・検索結果を見るため）
 * - 画面の「今すぐ分析する」は、依頼（queued）を積むだけ。実行は5分ごとの実行が拾う
 *   （画面からの通信は100秒で切れるので、その場で待たない）
 * - 1回の費用の目安：入力 3〜5万トークン・出力 3千トークン・Web 検索数回で、数十円
 *
 * API キーは Cloudflare のシークレット CLAUDE_API_KEY。モデルは CLAUDE_MODEL（無ければ claude-sonnet-4-5）
 */

import { resolveSettings } from "./settings";
import { resolvePeriod } from "./caseSummary";
import { renderAdsMarkdown, adsPrompt } from "./adsReport";
import { keywordMarkdown } from "./kwDiscovery";

export interface AiEnv {
  DB: D1Database;
  CLAUDE_API_KEY?: string;
  CLAUDE_MODEL?: string;
}

const DEFAULT_MODEL = "claude-sonnet-4-5";
/** 100万トークンあたりのドル（目安）。モデル名で大まかに分ける */
function price(model: string): { in: number; out: number } {
  if (/opus/i.test(model)) return { in: 15, out: 75 };
  if (/haiku/i.test(model)) return { in: 1, out: 5 };
  return { in: 3, out: 15 };
}

/** 0＝オフ、1＝毎週月曜＋手動、2＝手動のみ */
export async function aiMode(db: D1Database, caseId: string): Promise<number> {
  const st = await resolveSettings(db, { caseId });
  return st.case.find((s) => s.key === "ai_weekly")?.effective ?? 0;
}
export async function aiEnabled(db: D1Database, caseId: string): Promise<boolean> {
  return (await aiMode(db, caseId)) > 0;
}

/** 画面の「今すぐ分析する」 */
export async function queueAiReport(env: AiEnv, caseId: string, by: string | null): Promise<{ ok: boolean; message: string }> {
  if (!env.CLAUDE_API_KEY) return { ok: false, message: "Claude の API キーが未設定です（Cloudflare の CLAUDE_API_KEY）" };
  if (!(await aiEnabled(env.DB, caseId))) return { ok: false, message: "この案件は設定で「AI分析」がオフです" };
  const busy = await env.DB.prepare("SELECT 1 AS x FROM ai_reports WHERE case_id = ? AND status IN ('queued', 'running') LIMIT 1").bind(caseId).first();
  if (busy) return { ok: false, message: "すでに分析の依頼が入っています" };
  await env.DB.prepare("INSERT INTO ai_reports (id, case_id, status, trigger_kind, requested_by) VALUES (?, ?, 'queued', 'manual', ?)")
    .bind(crypto.randomUUID(), caseId, by).run();
  return { ok: true, message: "依頼しました。5分以内に始まり、数分で結果が出ます" };
}

export async function listAiReports(db: D1Database, caseId: string) {
  const { results } = await db.prepare(
    `SELECT id, created_at, finished_at, status, trigger_kind, requested_by, model, input_tokens, output_tokens, web_searches, cost_usd, content, error
       FROM ai_reports WHERE case_id = ? ORDER BY created_at DESC LIMIT 12`
  ).bind(caseId).all<Record<string, unknown>>();
  return results;
}

async function buildPrompt(db: D1Database, caseId: string): Promise<{ prompt: string; caseName: string }> {
  const c = await db.prepare("SELECT name FROM cases WHERE id = ?").bind(caseId).first<{ name: string }>();
  const name = c?.name ?? caseId;
  const per = await resolvePeriod(db, caseId, { preset: "last30" });
  const st = await resolveSettings(db, { caseId, mall: "amazon" });
  const am = st.case.find((x) => x.key === "ad_profit_margin")?.effective ?? 10;
  const ads = await renderAdsMarkdown(db, caseId, name, per.from, per.to, am);
  const kw = await keywordMarkdown(db, caseId).catch(() => "");
  const prompt = adsPrompt(name, per.from, per.to) + ads + "\n\n" + kw + "\n\n" + [
    "────────",
    "出力の形：日本語の Markdown。見出しは「## 要約」「## 新しく入札するキーワード」「## 競合と自社の比較」「## ツールの提案の実行可否」「## 広告以外の打ち手」の5つ。",
    "表は使ってよい。前置きや挨拶は不要。担当者がそのまま作業できるように、具体的に書く。",
  ].join("\n");
  return { prompt, caseName: name };
}

async function runOne(env: AiEnv, id: string, caseId: string): Promise<void> {
  const model = env.CLAUDE_MODEL || DEFAULT_MODEL;
  await env.DB.prepare("UPDATE ai_reports SET status = 'running', model = ? WHERE id = ?").bind(model, id).run();
  try {
    const { prompt } = await buildPrompt(env.DB, caseId);
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": env.CLAUDE_API_KEY!, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model, max_tokens: 6000,
        messages: [{ role: "user", content: prompt }],
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5, user_location: { type: "approximate", country: "JP" } }],
      }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      content?: Array<{ type: string; text?: string }>; error?: { message?: string };
      usage?: { input_tokens?: number; output_tokens?: number; server_tool_use?: { web_search_requests?: number } };
    };
    if (!res.ok) throw new Error(`Claude API ${res.status}：${body.error?.message ?? JSON.stringify(body).slice(0, 300)}`);
    const text = (body.content ?? []).filter((b) => b.type === "text" && b.text).map((b) => b.text).join("\n").trim();
    const u = body.usage ?? {};
    const p = price(model);
    const searches = u.server_tool_use?.web_search_requests ?? 0;
    const cost = ((u.input_tokens ?? 0) * p.in + (u.output_tokens ?? 0) * p.out) / 1e6 + searches * 0.01;
    await env.DB.prepare(
      `UPDATE ai_reports SET status = 'done', finished_at = datetime('now'), input_tokens = ?, output_tokens = ?, web_searches = ?, cost_usd = ?, content = ? WHERE id = ?`
    ).bind(u.input_tokens ?? null, u.output_tokens ?? null, searches, Math.round(cost * 1000) / 1000, text || "（AI から本文が返りませんでした）", id).run();
  } catch (e) {
    await env.DB.prepare("UPDATE ai_reports SET status = 'error', finished_at = datetime('now'), error = ? WHERE id = ?")
      .bind(String(e instanceof Error ? e.message : e).slice(0, 1000), id).run();
  }
}

/**
 * 5分ごとの実行から呼ぶ。
 *   ① 画面から依頼されたもの（queued）を1件実行
 *   ② 設定がオンで、最後の分析から7日たった案件を1件実行（月曜の朝以降）
 * 1回の実行で動かすのは1件だけ（時間と費用を読みやすくするため）
 */
export async function pumpAi(env: AiEnv): Promise<number> {
  if (!env.CLAUDE_API_KEY) return 0;
  // 止まったまま（running のまま30分）のものは失敗にする
  await env.DB.prepare("UPDATE ai_reports SET status = 'error', error = '時間切れで止まりました' WHERE status = 'running' AND created_at < datetime('now', '-30 minutes')").run();
  const q = await env.DB.prepare("SELECT id, case_id FROM ai_reports WHERE status = 'queued' ORDER BY created_at LIMIT 1").first<{ id: string; case_id: string }>();
  if (q) {
    if (await aiEnabled(env.DB, q.case_id)) await runOne(env, q.id, q.case_id);
    else await env.DB.prepare("UPDATE ai_reports SET status = 'error', error = '設定がオフになったため実行しませんでした' WHERE id = ?").bind(q.id).run();
    return 1;
  }
  const now = new Date(Date.now() + 9 * 3600000);
  if (now.getUTCDay() !== 1 || now.getUTCHours() < 8) return 0;        // 月曜 8時（日本時間）以降
  const { results: cases } = await env.DB.prepare("SELECT id FROM cases WHERE status = 'active'").all<{ id: string }>();
  for (const c of cases) {
    if ((await aiMode(env.DB, c.id)) !== 1) continue;      // 毎週は「毎週月曜＋手動」の案件だけ
    const last = await env.DB.prepare(
      "SELECT 1 AS x FROM ai_reports WHERE case_id = ? AND trigger_kind = 'weekly' AND created_at > datetime('now', '-6 days') LIMIT 1"
    ).bind(c.id).first();
    if (last) continue;
    const id = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO ai_reports (id, case_id, status, trigger_kind) VALUES (?, ?, 'queued', 'weekly')").bind(id, c.id).run();
    await runOne(env, id, c.id);
    return 1;
  }
  return 0;
}
