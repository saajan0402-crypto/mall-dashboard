/**
 * Amazon SP-API / Ads API の呼び出し
 *
 *   - 認証は LWA のリフレッシュトークンからアクセストークンを取るだけ。
 *     SP-API は 2023年以降 AWS の署名（SigV4）が不要になったので、
 *     x-amz-access-token ヘッダだけで呼べる
 *   - 取得したアクセストークンは保存しない。1回の処理の中だけで使い回す
 */

/** 日本のマーケットプレイスID */
export const JP_MARKETPLACE = "A1VC38T7YXB528";

/** SP-API の極東エンドポイント（日本・豪州・シンガポール） */
const SPAPI_BASE = "https://sellingpartnerapi-fe.amazon.com";

/** Amazon Ads API の極東エンドポイント */
const ADS_BASE = "https://advertising-api-fe.amazon.com";

export interface LwaEnv {
  AMAZON_LWA_CLIENT_ID?: string;
  AMAZON_LWA_CLIENT_SECRET?: string;
  /**
   * Ads API 用。Ads API は SP-API とは別の LWA セキュリティプロファイルで承認されることが多い。
   * 未設定なら SP-API と同じクライアントを使う
   */
  AMAZON_ADS_CLIENT_ID?: string;
  AMAZON_ADS_CLIENT_SECRET?: string;
  /** 1つのログインで複数案件のプロフィールを扱うときの共通トークン */
  AMAZON_ADS_REFRESH_TOKEN?: string;
}

/** Ads API で使うクライアント。専用のものがあればそちらを優先 */
export function adsClient(env: LwaEnv): { id?: string; secret?: string; dedicated: boolean } {
  const dedicated = Boolean(env.AMAZON_ADS_CLIENT_ID && env.AMAZON_ADS_CLIENT_SECRET);
  return dedicated
    ? { id: env.AMAZON_ADS_CLIENT_ID, secret: env.AMAZON_ADS_CLIENT_SECRET, dedicated }
    : { id: env.AMAZON_LWA_CLIENT_ID, secret: env.AMAZON_LWA_CLIENT_SECRET, dedicated };
}

/** Ads API のアクセストークン。案件ごとのトークンがあればそれ、無ければ全案件共通のもの */
export async function adsAccessToken(env: LwaEnv, caseToken?: string): Promise<string> {
  const refresh = caseToken || env.AMAZON_ADS_REFRESH_TOKEN;
  if (!refresh) throw new AmazonError("広告APIのリフレッシュトークンが未登録です", 0);
  const c = adsClient(env);
  return accessToken({ AMAZON_LWA_CLIENT_ID: c.id, AMAZON_LWA_CLIENT_SECRET: c.secret }, refresh);
}

export class AmazonError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/** リフレッシュトークンからアクセストークンを取る */
export async function accessToken(env: LwaEnv, refreshToken: string): Promise<string> {
  if (!env.AMAZON_LWA_CLIENT_ID || !env.AMAZON_LWA_CLIENT_SECRET) {
    throw new AmazonError("LWA クライアントIDとシークレットが未設定です", 0);
  }
  const res = await fetch("https://api.amazon.com/auth/o2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    // 貼り付けたときに前後の空白や改行が混ざることがあるので、ここで落とす
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken.trim(),
      client_id: env.AMAZON_LWA_CLIENT_ID.trim(),
      client_secret: env.AMAZON_LWA_CLIENT_SECRET.trim(),
    }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    error?: string;
    error_description?: string;
  };
  if (!res.ok || !body.access_token) {
    // エラーコードで原因の当たりがつくので、日本語の手がかりを添える
    const HINT: Record<string, string> = {
      invalid_client: "クライアントIDかシークレットが違います（写し間違い・シークレットの再発行で古いものが失効、など）",
      unauthorized_client: "このリフレッシュトークンは別のクライアントIDで発行されています",
      invalid_grant: "リフレッシュトークンが無効です（取り消し・写し間違い・別のクライアントで発行）",
    };
    const code = body.error ?? "";
    const desc = body.error_description ?? `HTTP ${res.status}`;
    throw new AmazonError(`${code ? code + "：" : ""}${desc}${HINT[code] ? `。${HINT[code]}` : ""}`, res.status);
  }
  return body.access_token;
}

export interface ApiResult {
  status: number;
  ok: boolean;
  /** 本文。JSON として読めなければ文字列のまま */
  body: unknown;
}

/** SP-API を1回呼ぶ。エラーでも例外にせず、ステータスと本文をそのまま返す */
export async function spapi(
  token: string,
  path: string,
  init: { method?: string; body?: unknown } = {}
): Promise<ApiResult> {
  const res = await fetch(SPAPI_BASE + path, {
    method: init.method ?? "GET",
    headers: {
      "x-amz-access-token": token,
      accept: "application/json",
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* JSON でなければ文字列のまま返す */
  }
  return { status: res.status, ok: res.ok, body };
}

/** Amazon Ads API を1回呼ぶ。profileId は省略可（プロフィール一覧の取得時など） */
export async function adsapi(
  env: LwaEnv,
  token: string,
  path: string,
  init: { method?: string; body?: unknown; profileId?: string; accept?: string; contentType?: string } = {}
): Promise<ApiResult> {
  const res = await fetch(ADS_BASE + path, {
    method: init.method ?? "GET",
    headers: {
      authorization: `Bearer ${token}`,
      "Amazon-Advertising-API-ClientId": (adsClient(env).id ?? "").trim(),
      ...(init.profileId ? { "Amazon-Advertising-API-Scope": init.profileId } : {}),
      accept: init.accept ?? "application/json",
      ...(init.body ? { "content-type": init.contentType ?? "application/json" } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* JSON でなければ文字列のまま */
  }
  return { status: res.status, ok: res.ok, body };
}

/** SP-API のエラー本文から、画面に出せる一文を取り出す */
export function errorMessage(body: unknown): string {
  if (typeof body === "string") return body.slice(0, 300);
  const b = body as { errors?: Array<{ message?: string; code?: string }>; message?: string };
  if (b?.errors?.length) {
    const e = b.errors[0];
    return [e.code, e.message].filter(Boolean).join(": ").slice(0, 300);
  }
  if (b?.message) return String(b.message).slice(0, 300);
  // Ads API は { code, detail } の形で返す
  const d = body as { code?: string; detail?: string; details?: string };
  if (d?.detail || d?.details) return [d.code, d.detail ?? d.details].filter(Boolean).join(": ").slice(0, 300);
  return JSON.stringify(body).slice(0, 300);
}
