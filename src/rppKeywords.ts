/**
 * 楽天RPP の登録キーワード一覧（RPP の管理画面の CSV。見出し：コントロールカラム, 商品管理番号, 商品名, 価格, 商品URL, 商品CPC, キーワード, キーワードCPC, 目安CPC）
 *
 * - 画面で読み込む（Shift_JIS を画面側で読んで行を送る）。読み込むたびに、その案件の一覧を丸ごと入れ替える
 * - 使い道：商品ごとの登録数（RPP の上限は1商品20個。2026-08-12 に10→20）、クリック0で広告レポートに出ないキーワードも含めたかぶりの判定、
 *   最初の入札の基準（登録済みのキーワードCPC の中央値・商品CPC）、楽天の商品名（商品ページの提案）
 * - 一括ファイルで追加・削除して「対応済み」にしたら、次に読み込むまでの間はこちらにも反映しておく
 */

import { canonKw } from "./kwNorm";

export const RPP_KW_LIMIT = 20;
const n = (v: unknown) => (v == null || v === "" ? null : Math.round(Number(String(v).replace(/[,¥円\s]/g, ""))));

export interface RppKwRow { num: string; name?: string | null; itemCpc?: number | string | null; keyword: string; cpc?: number | string | null; suggested?: number | string | null }

export async function importRppKeywords(db: D1Database, caseId: string, rows: RppKwRow[], by: string | null): Promise<{ rows: number; items: number }> {
  const clean = rows.map((r) => ({ num: String(r.num ?? "").trim(), keyword: String(r.keyword ?? "").normalize("NFKC").trim().replace(/\s+/g, " "),
    name: r.name ? String(r.name).slice(0, 300) : null, itemCpc: n(r.itemCpc), cpc: n(r.cpc), suggested: n(r.suggested) }))
    .filter((r) => r.num && r.keyword);
  if (!clean.length) throw new Error("キーワードの行がありません（RPP の登録キーワード一覧の CSV か確認してください）");
  const stmts: D1PreparedStatement[] = [db.prepare("DELETE FROM rpp_keywords WHERE case_id = ?").bind(caseId)];
  for (const r of clean) stmts.push(db.prepare(
    `INSERT OR REPLACE INTO rpp_keywords (case_id, external_id, keyword, keyword_cpc, item_cpc, suggested_cpc, item_name) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(caseId, r.num, r.keyword, r.cpc, r.itemCpc, r.suggested, r.name));
  // 楽天の商品名（商品ページの提案用。API で取れていればそちらを優先）
  const names = new Map(clean.filter((r) => r.name).map((r) => [r.num, r.name!]));
  for (const [num, name] of names) stmts.push(db.prepare(
    `INSERT INTO listing_content (case_id, mall, external_id, title, fetched_at) VALUES (?, 'rakuten', ?, ?, datetime('now'))
     ON CONFLICT(case_id, mall, external_id) DO UPDATE SET title = COALESCE(listing_content.title, excluded.title),
       fetched_at = COALESCE(listing_content.fetched_at, excluded.fetched_at)`
  ).bind(caseId, num, name));
  stmts.push(db.prepare(`INSERT INTO app_flags (key, value, updated_by) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = datetime('now')`)
    .bind(`rpp_kw_at:${caseId}`, JSON.stringify({ at: new Date().toISOString(), rows: clean.length, items: names.size || new Set(clean.map((r) => r.num)).size, by }), by));
  for (let i = 0; i < stmts.length; i += 80) await db.batch(stmts.slice(i, i + 80));
  return { rows: clean.length, items: new Set(clean.map((r) => r.num)).size };
}

export interface RppItem { num: string; name: string | null; itemCpc: number | null; keywords: Array<{ keyword: string; canon: string; cpc: number | null; suggested: number | null }> }
export interface RppSnapshot { at: string | null; rows: number; items: Map<string, RppItem> }

export async function rppSnapshot(db: D1Database, caseId: string): Promise<RppSnapshot> {
  const items = new Map<string, RppItem>();
  const { results } = await db.prepare(
    "SELECT external_id, keyword, keyword_cpc, item_cpc, suggested_cpc, item_name FROM rpp_keywords WHERE case_id = ?"
  ).bind(caseId).all<Record<string, string | number | null>>().catch(() => ({ results: [] as Array<Record<string, string | number | null>> }));
  for (const r of results) {
    const num = String(r.external_id);
    const it = items.get(num) ?? { num, name: r.item_name == null ? null : String(r.item_name), itemCpc: r.item_cpc == null ? null : Number(r.item_cpc), keywords: [] };
    it.keywords.push({ keyword: String(r.keyword), canon: canonKw("rakuten", String(r.keyword)), cpc: r.keyword_cpc == null ? null : Number(r.keyword_cpc), suggested: r.suggested_cpc == null ? null : Number(r.suggested_cpc) });
    items.set(num, it);
  }
  const f = await db.prepare("SELECT value FROM app_flags WHERE key = ?").bind(`rpp_kw_at:${caseId}`).first<{ value: string }>().catch(() => null);
  const meta = f?.value ? JSON.parse(f.value) as { at: string; rows: number } : null;
  return { at: meta?.at ?? null, rows: results.length, items };
}

/** 一括ファイルで追加・削除して対応済みにした分を、次に読み込むまでの一覧に反映する */
export async function applyRppChanges(db: D1Database, caseId: string, num: string, add: { keyword: string; cpc: number } | null, remove: string | null) {
  const stmts: D1PreparedStatement[] = [];
  if (remove) stmts.push(db.prepare("DELETE FROM rpp_keywords WHERE case_id = ? AND external_id = ? AND keyword = ?").bind(caseId, num, remove));
  if (add) stmts.push(db.prepare(
    `INSERT OR REPLACE INTO rpp_keywords (case_id, external_id, keyword, keyword_cpc, item_cpc, item_name)
     VALUES (?, ?, ?, ?, (SELECT MAX(item_cpc) FROM rpp_keywords WHERE case_id = ? AND external_id = ?), (SELECT MAX(item_name) FROM rpp_keywords WHERE case_id = ? AND external_id = ?))`
  ).bind(caseId, num, add.keyword, Math.round(add.cpc), caseId, num, caseId, num));
  if (stmts.length) await db.batch(stmts).catch(() => undefined);
}
