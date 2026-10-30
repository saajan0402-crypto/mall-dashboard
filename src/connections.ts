/**
 * 案件ごとのモール接続情報の管理
 *
 *   - 入力はこの画面からだけ。チャットやコード、リポジトリには残さない
 *   - 保存時に暗号化し、画面に返すのは「設定済みかどうか」と伏せ字だけ
 *   - Amazon の LWA クライアントIDとシークレットはアプリ共通なので Workers のシークレットに置く
 */

import { seal, open, mask } from "./crypto";

export interface ConnEnv {
  DB: D1Database;
  SECRET_KEY?: string;
  AMAZON_LWA_CLIENT_ID?: string;
  AMAZON_LWA_CLIENT_SECRET?: string;
}

export type Mall = "amazon" | "rakuten";

/** モールごとに持つ項目。label は画面に出す名前 */
export const FIELDS: Record<Mall, Array<{ key: string; label: string; hint: string }>> = {
  amazon: [
    { key: "refresh_token", label: "リフレッシュトークン", hint: "Atzr| で始まる文字列。セラーセントラルの自己認可で発行" },
    { key: "ads_refresh_token", label: "広告APIのリフレッシュトークン", hint: "Amazon Ads API の承認後に入力（任意）" },
    { key: "seller_id", label: "セラーID", hint: "任意。レポートの照合に使う" },
  ],
  rakuten: [
    { key: "service_secret", label: "serviceSecret", hint: "SP で始まる文字列" },
    { key: "license_key", label: "ライセンスキー", hint: "SL で始まる文字列。有効期限あり" },
  ],
};

/* ───────── 管理者 ───────── */

async function readSetting<T>(db: D1Database, key: string): Promise<T | null> {
  const row = await db
    .prepare("SELECT value FROM settings WHERE scope = 'company' AND scope_id = '' AND key = ?")
    .bind(key)
    .first<{ value: string }>();
  return row ? (JSON.parse(row.value) as T) : null;
}

async function writeSetting(db: D1Database, key: string, value: unknown, by: string | null): Promise<void> {
  await db
    .prepare(
      `INSERT INTO settings (scope, scope_id, key, value, updated_by)
       VALUES ('company', '', ?, ?, ?)
       ON CONFLICT(scope, scope_id, key)
       DO UPDATE SET value = excluded.value, updated_at = datetime('now'), updated_by = excluded.updated_by`
    )
    .bind(key, JSON.stringify(value), by)
    .run();
}

/**
 * 管理者の一覧。まだ誰も登録されていなければ、最初に開いた人が管理者になる。
 * 社員4名しか入れない画面なので、設定ファイルを増やさずこの形にしている。
 */
export async function ensureAdmin(db: D1Database, email: string | null): Promise<{ admins: string[]; isAdmin: boolean }> {
  const admins = (await readSetting<string[]>(db, "admins")) ?? [];
  if (admins.length === 0 && email) {
    await writeSetting(db, "admins", [email], email);
    return { admins: [email], isAdmin: true };
  }
  return { admins, isAdmin: Boolean(email && admins.includes(email)) };
}

export async function addAdmin(db: D1Database, email: string, by: string | null): Promise<string[]> {
  const admins = (await readSetting<string[]>(db, "admins")) ?? [];
  if (!admins.includes(email)) admins.push(email);
  await writeSetting(db, "admins", admins, by);
  return admins;
}

/* ───────── 接続情報 ───────── */

interface CaseMallRow {
  id: string;
  case_id: string;
  mall: Mall;
  account_label: string | null;
  credentials_enc: string | null;
  license_expires_on: string | null;
  attribution_days: number | null;
  default_fulfillment: string | null;
}

/** 案件×モールの一覧。値は返さず、設定済みかどうかと伏せ字だけを返す */
export async function listConnections(env: ConnEnv): Promise<unknown> {
  const { results: cases } = await env.DB.prepare(
    "SELECT id, name FROM cases WHERE status = 'active' ORDER BY name"
  ).all<{ id: string; name: string }>();

  const { results: rows } = await env.DB.prepare("SELECT * FROM case_malls").all<CaseMallRow>();
  const byCase = new Map<string, CaseMallRow[]>();
  for (const r of rows) {
    const list = byCase.get(r.case_id) ?? [];
    list.push(r);
    byCase.set(r.case_id, list);
  }

  const out = [];
  for (const c of cases) {
    const malls: Record<string, unknown> = {};
    for (const mall of ["amazon", "rakuten"] as Mall[]) {
      const row = (byCase.get(c.id) ?? []).find((r) => r.mall === mall);
      let fields: Record<string, string> = {};
      if (row?.credentials_enc && env.SECRET_KEY) {
        try {
          const creds = await open<Record<string, string>>(env.SECRET_KEY, row.credentials_enc);
          fields = Object.fromEntries(Object.entries(creds).map(([k, v]) => [k, mask(v)]));
        } catch {
          fields = { _error: "復号できません（SECRET_KEY が変わった可能性があります）" };
        }
      }
      malls[mall] = {
        configured: Boolean(row?.credentials_enc),
        masked: fields,
        licenseExpiresOn: row?.license_expires_on ?? null,
        attributionDays: row?.attribution_days ?? 7,
        defaultFulfillment: row?.default_fulfillment ?? "fba",
        connectedAt: row ? (row as unknown as { connected_at?: string }).connected_at ?? null : null,
      };
    }
    out.push({ id: c.id, name: c.name, malls });
  }
  return {
    cases: out,
    appLevel: {
      lwaClientId: Boolean(env.AMAZON_LWA_CLIENT_ID),
      lwaClientSecret: Boolean(env.AMAZON_LWA_CLIENT_SECRET),
      encryption: Boolean(env.SECRET_KEY),
    },
  };
}

/** 入力された接続情報を暗号化して保存する。空欄の項目は既存の値を残す */
export async function saveConnection(
  env: ConnEnv,
  caseId: string,
  mall: Mall,
  values: Record<string, string>,
  meta: { licenseExpiresOn?: string | null; attributionDays?: number | null },
  by: string | null
): Promise<void> {
  if (!env.SECRET_KEY) throw new Error("SECRET_KEY が未設定です");

  const row = await env.DB.prepare("SELECT * FROM case_malls WHERE case_id = ? AND mall = ?")
    .bind(caseId, mall)
    .first<CaseMallRow>();

  let creds: Record<string, string> = {};
  if (row?.credentials_enc) {
    try {
      creds = await open<Record<string, string>>(env.SECRET_KEY, row.credentials_enc);
    } catch {
      creds = {};
    }
  }
  for (const [k, v] of Object.entries(values)) {
    const trimmed = (v ?? "").trim();
    if (trimmed) creds[k] = trimmed;        // 空欄は「変更しない」の意味
  }
  const blob = await seal(env.SECRET_KEY, creds);

  if (row) {
    await env.DB.prepare(
      `UPDATE case_malls
          SET credentials_enc = ?, license_expires_on = ?, attribution_days = ?, connected_at = datetime('now')
        WHERE id = ?`
    )
      .bind(blob, meta.licenseExpiresOn ?? row.license_expires_on, meta.attributionDays ?? row.attribution_days, row.id)
      .run();
  } else {
    await env.DB.prepare(
      `INSERT INTO case_malls (id, case_id, mall, credentials_enc, license_expires_on, attribution_days, connected_at)
       VALUES (?,?,?,?,?,?, datetime('now'))`
    )
      .bind(crypto.randomUUID(), caseId, mall, blob, meta.licenseExpiresOn ?? null, meta.attributionDays ?? 7)
      .run();
  }

  await env.DB.prepare(
    `INSERT INTO settings_log (id, scope, scope_id, key, old_value, new_value, changed_by)
     VALUES (?, 'case_mall', ?, ?, NULL, '(接続情報を更新)', ?)`
  )
    .bind(crypto.randomUUID(), caseId, `connection:${mall}`, by)
    .run();
}

/**
 * 接続テスト。
 * Amazon は LWA でアクセストークンを取れるかだけ確かめる（取得したトークンは保存しない）。
 * 楽天は値の形式だけを見る。実際の呼び出しは取り込み処理を作るときに合わせて確認する。
 */
export async function testConnection(
  env: ConnEnv,
  caseId: string,
  mall: Mall
): Promise<{ ok: boolean; message: string }> {
  if (!env.SECRET_KEY) return { ok: false, message: "SECRET_KEY が未設定です" };

  const row = await env.DB.prepare("SELECT credentials_enc FROM case_malls WHERE case_id = ? AND mall = ?")
    .bind(caseId, mall)
    .first<{ credentials_enc: string | null }>();
  if (!row?.credentials_enc) return { ok: false, message: "まだ登録されていません" };

  const creds = await open<Record<string, string>>(env.SECRET_KEY, row.credentials_enc);

  if (mall === "amazon") {
    if (!env.AMAZON_LWA_CLIENT_ID || !env.AMAZON_LWA_CLIENT_SECRET) {
      return { ok: false, message: "LWA クライアントIDとシークレットが未設定です（Workers のシークレットに登録してください）" };
    }
    if (!creds.refresh_token) return { ok: false, message: "リフレッシュトークンが未登録です" };
    const res = await fetch("https://api.amazon.com/auth/o2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: creds.refresh_token,
        client_id: env.AMAZON_LWA_CLIENT_ID,
        client_secret: env.AMAZON_LWA_CLIENT_SECRET,
      }),
    });
    if (res.ok) return { ok: true, message: "アクセストークンを取得できました" };
    const body = (await res.json().catch(() => ({}))) as { error_description?: string; error?: string };
    return { ok: false, message: `Amazon から拒否されました：${body.error_description ?? body.error ?? res.status}` };
  }

  if (!creds.service_secret || !creds.license_key) {
    return { ok: false, message: "serviceSecret とライセンスキーの両方が必要です" };
  }
  if (!creds.service_secret.startsWith("SP") || !creds.license_key.startsWith("SL")) {
    return { ok: false, message: "値の形式が想定と違います（SP… と SL… で始まるはずです）" };
  }
  return { ok: true, message: "形式は問題ありません（実際の呼び出しは取り込み処理の実装時に確認します）" };
}
