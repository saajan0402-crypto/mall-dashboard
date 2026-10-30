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
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: env.AMAZON_LWA_CLIENT_ID,
      client_secret: env.AMAZON_LWA_CLIENT_SECRET,
    }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    error?: string;
    error_description?: string;
  };
  if (!res.ok || !body.access_token) {
    throw new AmazonError(body.error_description ?? body.error ?? `HTTP ${res.status}`, res.status);
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
  init: { method?: string; body?: unknown; profileId?: string; accept?: string } = {}
): Promise<ApiResult> {
  const res = await fetch(ADS_BASE + path, {
    method: init.method ?? "GET",
    headers: {
      authorization: `Bearer ${token}`,
      "Amazon-Advertising-API-ClientId": env.AMAZON_LWA_CLIENT_ID ?? "",
      ...(init.profileId ? { "Amazon-Advertising-API-Scope": init.profileId } : {}),
      accept: init.accept ?? "application/json",
      ...(init.body ? { "content-type": "application/json" } : {}),
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
  return JSON.stringify(body).slice(0, 300);
}
