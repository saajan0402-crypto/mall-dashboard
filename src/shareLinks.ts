/**
 * 共有URL（AIに読ませる用）
 *
 * アプリ全体は Cloudflare Access で守っているので、外のAIからは読めない。
 * そこで /share/<鍵> だけを外から読めるようにし、鍵を知っている人（AI）だけが
 * その案件のレポートを読めるようにする。
 *   - 鍵は推測できない長さ（32バイト）。照合はハッシュで行う
 *   - 期限つき。いつでも無効にできる
 *   - 読めるのはレポート（集計済みの文章）だけ。APIや接続情報には届かない
 */

import { seal, open } from "./crypto";

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function sha256(text: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface ShareLink {
  id: string; caseId: string; caseName: string; label: string | null;
  createdBy: string | null; createdAt: string; expiresAt: string;
  revokedAt: string | null; lastAccessAt: string | null; accessCount: number;
  active: boolean;
  /** 再表示用。SECRET_KEY が無いときは出せない */
  url: string | null;
}

const ALLOWED_DAYS = [1, 7, 30, 90];

export async function createShareLink(
  env: { DB: D1Database; SECRET_KEY?: string },
  origin: string, caseId: string, days: number, label: string | null, by: string | null,
): Promise<{ id: string; url: string; expiresAt: string }> {
  if (!ALLOWED_DAYS.includes(days)) throw new Error("有効期限は 1・7・30・90 日から選んでください");
  const c = await env.DB.prepare("SELECT id FROM cases WHERE id = ?").bind(caseId).first();
  if (!c) throw new Error("案件が見つかりません");

  const token = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const id = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + days * 86400000).toISOString().slice(0, 19).replace("T", " ");
  const enc = env.SECRET_KEY ? await seal(env.SECRET_KEY, { token }) : null;
  await env.DB.prepare(
    `INSERT INTO share_links (id, case_id, token_hash, token_enc, label, created_by, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, caseId, await sha256(token), enc, label, by, expiresAt).run();
  return { id, url: `${origin}/share/${token}`, expiresAt };
}

export async function listShareLinks(
  env: { DB: D1Database; SECRET_KEY?: string }, origin: string, caseId: string,
): Promise<ShareLink[]> {
  const { results } = await env.DB.prepare(
    `SELECT l.*, c.name AS case_name,
            (l.revoked_at IS NULL AND l.expires_at > datetime('now')) AS active
       FROM share_links l JOIN cases c ON c.id = l.case_id
      WHERE l.case_id = ? ORDER BY l.created_at DESC LIMIT 30`
  ).bind(caseId).all<Record<string, string | number | null>>();

  const out: ShareLink[] = [];
  for (const r of results) {
    let url: string | null = null;
    const active = Number(r.active) === 1;
    if (active && r.token_enc && env.SECRET_KEY) {
      try { url = `${origin}/share/${(await open<{ token: string }>(env.SECRET_KEY, String(r.token_enc))).token}`; } catch { url = null; }
    }
    out.push({
      id: String(r.id), caseId: String(r.case_id), caseName: String(r.case_name),
      label: r.label == null ? null : String(r.label),
      createdBy: r.created_by == null ? null : String(r.created_by), createdAt: String(r.created_at),
      expiresAt: String(r.expires_at), revokedAt: r.revoked_at == null ? null : String(r.revoked_at),
      lastAccessAt: r.last_access_at == null ? null : String(r.last_access_at),
      accessCount: Number(r.access_count ?? 0), active, url,
    });
  }
  return out;
}

export async function revokeShareLink(db: D1Database, id: string): Promise<boolean> {
  const r = await db.prepare("UPDATE share_links SET revoked_at = datetime('now') WHERE id = ? AND revoked_at IS NULL")
    .bind(id).run();
  return (r.meta.changes ?? 0) > 0;
}

/** 鍵から案件を引く。期限切れ・無効化済みは null */
export async function resolveShareToken(db: D1Database, token: string): Promise<{ id: string; caseId: string } | null> {
  if (!/^[A-Za-z0-9_-]{40,60}$/.test(token)) return null;
  const r = await db.prepare(
    `SELECT id, case_id FROM share_links
      WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > datetime('now')`
  ).bind(await sha256(token)).first<{ id: string; case_id: string }>();
  if (!r) return null;
  await db.prepare("UPDATE share_links SET access_count = access_count + 1, last_access_at = datetime('now') WHERE id = ?")
    .bind(r.id).run();
  return { id: r.id, caseId: r.case_id };
}
