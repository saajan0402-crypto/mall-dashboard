/**
 * 接続情報の暗号化
 *
 * 案件ごとの API キーは、Workers のシークレット SECRET_KEY から導いた鍵で
 * 暗号化してからデータベースに入れる。平文はどこにも残さない。
 */

async function aesKey(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromBase64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** オブジェクトを暗号化して1本の文字列にする（先頭12バイトが初期化ベクトル） */
export async function seal(secret: string, value: unknown): Promise<string> {
  const key = await aesKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(JSON.stringify(value));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, data));
  const joined = new Uint8Array(iv.length + ct.length);
  joined.set(iv, 0);
  joined.set(ct, iv.length);
  return toBase64(joined);
}

export async function open<T = Record<string, string>>(secret: string, blob: string): Promise<T> {
  const key = await aesKey(secret);
  const raw = fromBase64(blob);
  const iv = raw.slice(0, 12);
  const ct = raw.slice(12);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return JSON.parse(new TextDecoder().decode(plain)) as T;
}

/** 画面に出すための伏せ字。値そのものは絶対に返さない */
export function mask(value: string): string {
  if (!value) return "";
  if (value.length <= 8) return "••••";
  return `${value.slice(0, 4)}••••${value.slice(-4)}`;
}
