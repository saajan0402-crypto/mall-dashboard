/**
 * 楽天 RMS WEB SERVICE の呼び出し
 *
 *   - 認証は Authorization: ESA base64(serviceSecret:licenseKey) の1行だけ
 *   - ライセンスキーには有効期限があり、切れると全APIが一斉に落ちる。
 *     期限は license-management API で取れるので、取り込みのたびに確認して保存する
 */

const BASE = "https://api.rms.rakuten.co.jp/es";

export interface RmsCreds {
  service_secret: string;
  license_key: string;
}

export interface RmsResult {
  status: number;
  ok: boolean;
  body: unknown;
}

function authHeader(creds: RmsCreds): string {
  return "ESA " + btoa(`${creds.service_secret}:${creds.license_key}`);
}

/** RMS を1回呼ぶ。エラーでも例外にせず、ステータスと本文をそのまま返す */
export async function rms(
  creds: RmsCreds,
  path: string,
  init: { method?: string; body?: unknown } = {}
): Promise<RmsResult> {
  const res = await fetch(BASE + path, {
    method: init.method ?? "GET",
    headers: {
      authorization: authHeader(creds),
      accept: "application/json",
      ...(init.body ? { "content-type": "application/json; charset=utf-8" } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* XML を返すAPIもあるので、読めなければ文字列のまま */
  }
  return { status: res.status, ok: res.ok, body };
}

/** ライセンスキーの有効期限（YYYY-MM-DD）。取れなければ null */
export async function licenseExpiry(creds: RmsCreds): Promise<{ date: string | null; result: RmsResult }> {
  const result = await rms(
    creds,
    `/1.0/license-management/license-key/expiry-date?licenseKey=${encodeURIComponent(creds.license_key)}`
  );
  const b = result.body as { expiryDate?: string } | string;
  let date: string | null = null;
  if (typeof b === "object" && b?.expiryDate) {
    date = String(b.expiryDate).slice(0, 10);
  } else if (typeof b === "string") {
    // XML で返ってきた場合の保険
    const m = b.match(/<expiryDate>([^<]+)<\/expiryDate>/);
    if (m) date = m[1].slice(0, 10);
  }
  return { date, result };
}

/** 楽天の日時書式（2026-10-30T00:00:00+0900） */
export function rakutenDatetime(date: Date): string {
  const jst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  return jst.toISOString().replace(/\.\d{3}Z$/, "") + "+0900";
}

/**
 * 楽天ペイ受注APIで注文番号を検索する。
 * dateType 1 = 注文日。orderProgressList は 100〜900（キャンセル・支払待ちも含む全段階）
 */
export async function searchOrders(
  creds: RmsCreds,
  from: Date,
  to: Date,
  opts: { page?: number; perPage?: number } = {}
): Promise<RmsResult> {
  return rms(creds, "/2.0/order/searchOrder/", {
    method: "POST",
    body: {
      dateType: 1,
      startDatetime: rakutenDatetime(from),
      endDatetime: rakutenDatetime(to),
      orderProgressList: [100, 200, 300, 400, 500, 600, 700, 800, 900],
      PaginationRequestModel: {
        requestRecordsAmount: opts.perPage ?? 1000,
        requestPage: opts.page ?? 1,
      },
    },
  });
}

/** 注文番号から明細を取る。version 7 = SKU対応 */
export async function getOrders(creds: RmsCreds, orderNumbers: string[]): Promise<RmsResult> {
  return rms(creds, "/2.0/order/getOrder/", {
    method: "POST",
    body: { orderNumberList: orderNumbers, version: "7" },
  });
}

/** RMS のエラー本文から、画面に出せる一文を取り出す */
export function errorMessage(body: unknown): string {
  if (typeof body === "string") return body.slice(0, 300);
  const b = body as {
    MessageModelList?: Array<{ messageCode?: string; message?: string }>;
    errors?: Array<{ code?: string; message?: string }>;
    message?: string;
  };
  if (b?.MessageModelList?.length) {
    const m = b.MessageModelList[0];
    return [m.messageCode, m.message].filter(Boolean).join(": ").slice(0, 300);
  }
  if (b?.errors?.length) {
    const e = b.errors[0];
    return [e.code, e.message].filter(Boolean).join(": ").slice(0, 300);
  }
  if (b?.message) return String(b.message).slice(0, 300);
  return JSON.stringify(body).slice(0, 300);
}
