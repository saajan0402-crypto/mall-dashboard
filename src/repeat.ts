/**
 * リピート率 ＝ 直近13か月に買った人のうち、2回以上（別の日に）買った人の割合
 *
 * 楽天・Amazon とも同じ定義にそろえる（Amazon Marketing Cloud の保存期間が13か月のため、楽天も13か月に合わせた）。
 * 期間の最終日から13か月さかのぼった範囲で数える。同じ日の複数の注文は1回とみなす。
 *
 * 楽天：注文データから計算する。
 *   - 注文者の氏名＋電話番号（無ければ氏名＋郵便番号、さらに無ければメールアドレス）を、
 *     SECRET_KEY から作った鍵で HMAC-SHA256 にかけた「購入者の印」を注文ごとに持つ（customer_orders）。
 *     印から個人情報には戻せない。氏名・電話番号そのものは保存しない
 *   - 取り込み済みの履歴が13か月より短いと、そのぶん低く出る（historyFrom で分かるようにする）
 *
 * Amazon：Amazon Marketing Cloud（AMC）で集計する。
 *   - 注文 API・ブランド分析からは「同じ人が別の月にまた買ったか」が分からないため
 *   - AMC の conversions_all（広告を見ていない人も含む、自社 ASIN のすべての購入）を使う。
 *     有料機能「Amazon Insights（Flexible Shopping Insights）」の購読が必要（2026年末までは無料で使える）
 *   - 案件の接続に AMC インスタンスID・AMC アカウントID を入れた案件だけ。週に1回実行する
 *   - AMC はプライバシーのため、人数が少ない結果を返さない（およそ100人未満）。その場合は「人数が少なく出せない」と出す
 */

import { readCreds, type ConnEnv } from "./connections";
import { adsapi, adsAccessToken, errorMessage, JP_MARKETPLACE, type LwaEnv } from "./amazon";


/* ───────── 楽天：購入者の印 ───────── */

interface ROrderer {
  familyName?: string; firstName?: string; familyNameKana?: string; firstNameKana?: string;
  phoneNumber1?: string; phoneNumber2?: string; phoneNumber3?: string;
  zipCode1?: string; zipCode2?: string; emailAddress?: string;
}
interface ROrderLike {
  orderNumber?: string; orderDatetime?: string; orderProgress?: number;
  OrdererModel?: ROrderer;
  PackageModelList?: Array<{ ItemModelList?: Array<{ price?: number; units?: number }> }>;
}

const norm = (s: string | undefined) => (s ?? "").normalize("NFKC").replace(/[\s　]/g, "").toLowerCase();

let keyCache: { secret: string; key: CryptoKey } | null = null;
async function hmacKey(secret: string): Promise<CryptoKey> {
  if (keyCache?.secret === secret) return keyCache.key;
  // 暗号化の鍵そのものではなく、用途を混ぜて作った別の鍵で印を作る
  const raw = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`customer-key:v1:${secret}`));
  const key = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  keyCache = { secret, key };
  return key;
}

/** 注文から購入者の印を作る。作れなければ null */
export async function customerKey(o: ROrderLike, secret: string): Promise<{ key: string; basis: string } | null> {
  const m = o.OrdererModel ?? (o as Record<string, unknown>).ordererModel as ROrderer | undefined;
  if (!m) return null;
  const name = norm(m.familyName) + norm(m.firstName) || norm(m.familyNameKana) + norm(m.firstNameKana);
  const phone = `${m.phoneNumber1 ?? ""}${m.phoneNumber2 ?? ""}${m.phoneNumber3 ?? ""}`.replace(/\D/g, "");
  const zip = `${m.zipCode1 ?? ""}${m.zipCode2 ?? ""}`.replace(/\D/g, "");
  const email = norm(m.emailAddress);
  let src: string, basis: string;
  if (name && phone.length >= 10) { src = `np|${name}|${phone}`; basis = "氏名＋電話"; }
  else if (name && zip.length === 7) { src = `nz|${name}|${zip}`; basis = "氏名＋郵便番号"; }
  else if (email) { src = `e|${email}`; basis = "メール"; }
  else return null;
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), new TextEncoder().encode(src));
  const hex = [...new Uint8Array(sig)].slice(0, 16).map((b) => b.toString(16).padStart(2, "0")).join("");
  return { key: hex, basis };
}

/** 取り込んだ期間の注文について、購入者の印を入れ直す（キャンセル確定は数えない） */
export async function writeRakutenCustomers(
  env: ConnEnv, caseId: string, from: string, to: string, list: unknown[],
): Promise<{ total: number; identified: number; note: string | null }> {
  const orders = list as ROrderLike[];
  if (!env.SECRET_KEY) return { total: 0, identified: 0, note: "SECRET_KEY が無いためリピート率の判定をしていません" };
  const stmts: D1PreparedStatement[] = [
    env.DB.prepare("DELETE FROM customer_orders WHERE case_id = ? AND mall = 'rakuten' AND date BETWEEN ? AND ?").bind(caseId, from, to),
  ];
  let total = 0, identified = 0;
  const bases: Record<string, number> = {};
  for (const o of orders) {
    if (o.orderProgress === 900 || !o.orderNumber) continue;
    const date = (o.orderDatetime ?? "").slice(0, 10);
    if (!date) continue;
    total++;
    const k = await customerKey(o, env.SECRET_KEY);
    if (!k) continue;
    identified++;
    bases[k.basis] = (bases[k.basis] ?? 0) + 1;
    let revenue = 0;
    for (const p of o.PackageModelList ?? []) for (const it of p.ItemModelList ?? []) revenue += Math.round(Number(it.price ?? 0)) * Math.round(Number(it.units ?? 0));
    stmts.push(env.DB.prepare(
      `INSERT INTO customer_orders (case_id, mall, order_id, date, customer, revenue) VALUES (?, 'rakuten', ?, ?, ?, ?)
       ON CONFLICT(case_id, mall, order_id) DO UPDATE SET date = excluded.date, customer = excluded.customer, revenue = excluded.revenue`
    ).bind(caseId, o.orderNumber, date, k.key, revenue));
  }
  for (let i = 0; i < stmts.length; i += 400) await env.DB.batch(stmts.slice(i, i + 400));
  const note = total
    ? `リピート判定：${identified}/${total}件（${Object.entries(bases).map(([b, n]) => `${b} ${n}`).join("・") || "判定できず"}）`
    : null;
  return { total, identified, note };
}

/**
 * これまでに取り込んだ楽天の注文（R2 の生データ）から、購入者の印を作る。API は呼ばない。
 * ingests.parser＝2 が印を作り済みの印
 */
export async function reparseRakutenCustomers(env: ConnEnv & { FILES: R2Bucket }, limit = 6): Promise<number> {
  if (!env.SECRET_KEY) return 0;
  const { results } = await env.DB.prepare(
    `SELECT case_id, r2_key, MIN(period_start) AS f, MAX(period_end) AS t FROM ingests
      WHERE mall = 'rakuten' AND kind = 'orders' AND status = 'ok' AND r2_key IS NOT NULL AND COALESCE(parser, 1) < 2
      GROUP BY case_id, r2_key ORDER BY MAX(created_at) DESC LIMIT ?`
  ).bind(limit).all<{ case_id: string; r2_key: string; f: string; t: string }>();
  let done = 0;
  for (const r of results) {
    const obj = await env.FILES.get(r.r2_key);
    if (obj) {
      const orders = (await obj.json()) as ROrderLike[];
      await writeRakutenCustomers(env, r.case_id, r.f, r.t, Array.isArray(orders) ? orders : []);
    }
    await env.DB.prepare(
      "UPDATE ingests SET parser = 2 WHERE case_id = ? AND mall = 'rakuten' AND kind = 'orders' AND r2_key = ?"
    ).bind(r.case_id, r.r2_key).run();
    done++;
  }
  return done;
}

/* ───────── Amazon：AMC ───────── */

const AMC_SQL = `WITH buyers AS (
  SELECT user_id, COUNT(DISTINCT event_date_utc) AS purchase_days
  FROM conversions_all
  WHERE event_subtype = 'order' AND user_id IS NOT NULL
  GROUP BY user_id
)
SELECT COUNT(user_id) AS customers,
       SUM(CASE WHEN purchase_days >= 2 THEN 1 ELSE 0 END) AS repeaters
FROM buyers`;

interface AmcState {
  status: "pending" | "ok" | "error" | "small";
  executionId?: string; from?: string; to?: string; at: string; message?: string;
  result?: { from: string; to: string; customers: number; repeaters: number; rate: number | null; at: string };
}
const amcKey = (caseId: string) => `amc_repeat:${caseId}`;
async function readAmc(db: D1Database, caseId: string): Promise<AmcState | null> {
  const r = await db.prepare("SELECT value FROM app_flags WHERE key = ?").bind(amcKey(caseId)).first<{ value: string }>();
  try { return r ? (JSON.parse(r.value) as AmcState) : null; } catch { return null; }
}
async function writeAmc(db: D1Database, caseId: string, s: AmcState) {
  await db.prepare(
    `INSERT INTO app_flags (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
  ).bind(amcKey(caseId), JSON.stringify(s)).run();
}

const dayAdd = (d: string, add: number) => new Date(Date.parse(`${d}T00:00:00Z`) + add * 86400000).toISOString().slice(0, 10);
/** 13か月前の翌日（例：2026-10-31 → 2025-10-01） */
export const window13 = (to: string) => {
  const t = new Date(`${to}T00:00:00Z`);
  const y = t.getUTCFullYear(), m = t.getUTCMonth() - 13;
  const dim = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();          // 13か月前の月の日数（31日→30日などにそろえる）
  const f = new Date(Date.UTC(y, m, Math.min(t.getUTCDate(), dim)) + 86400000);
  return f.toISOString().slice(0, 10);
};
const jstDay = (offset: number) => new Date(Date.now() + 9 * 3600000 - offset * 86400000).toISOString().slice(0, 10);

/** CSV（1行目が見出し）を読む。カンマ・引用符だけの簡単なもの */
function parseCsv(text: string): Array<Record<string, string>> {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const split = (l: string) => l.split(",").map((v) => v.replace(/^"|"$/g, "").trim());
  const head = split(lines[0]);
  return lines.slice(1).map((l) => { const v = split(l); const o: Record<string, string> = {}; head.forEach((h, i) => { o[h] = v[i] ?? ""; }); return o; });
}

/**
 * AMC API を呼ぶ。AMC は種類ごとの専用の Content-Type / Accept（application/vnd.amc….v1+json）を求めることがあるので、
 * まず専用の型で送り、415/406 が返ったら普通の JSON で送り直す
 */
async function amcCall(env: LwaEnv, token: string, accountId: string, path: string, body?: unknown) {
  const headers = { "Amazon-Advertising-API-AdvertiserId": accountId, "Amazon-Advertising-API-MarketplaceId": JP_MARKETPLACE };
  const vnd = "application/vnd.amcworkflowexecutions.v1+json";
  const r = await adsapi(env, token, path, { method: body ? "POST" : "GET", body, headers, accept: vnd, contentType: vnd });
  if (r.status !== 415 && r.status !== 406) return r;
  return adsapi(env, token, path, { method: body ? "POST" : "GET", body, headers });
}

/**
 * 5分ごとの実行から呼ぶ。AMC の ID がある案件ごとに
 *   実行中なら状態を見て、終わっていれば結果を取り込む／最後の結果が7日より古ければ新しく実行する
 * 失敗した案件は1日おきにだけ試し直す
 */
export async function pumpRepeatAmazon(env: ConnEnv & LwaEnv, opts: { budgetMs?: number; caseId?: string; force?: boolean } = {}): Promise<number> {
  const deadline = Date.now() + (opts.budgetMs ?? 20000);
  const { results: cases } = await env.DB.prepare(
    `SELECT c.id FROM cases c JOIN case_malls m ON m.case_id = c.id AND m.mall = 'amazon' AND m.credentials_enc IS NOT NULL
      WHERE c.status = 'active' ${opts.caseId ? "AND c.id = ?" : ""}`
  ).bind(...(opts.caseId ? [opts.caseId] : [])).all<{ id: string }>();
  let done = 0;
  for (const c of cases) {
    if (Date.now() > deadline) break;
    const creds = await readCreds(env, c.id, "amazon");
    const instanceId = creds?.amc_instance_id?.trim(), accountId = creds?.amc_account_id?.trim();
    if (!instanceId || !accountId) continue;
    const st = await readAmc(env.DB, c.id);
    const ageH = st ? (Date.now() - Date.parse(st.at)) / 3600000 : Infinity;
    if (!opts.force && st?.status === "pending" && ageH < 0.25) continue;            // 実行は15分以上かかる
    if (!opts.force && st?.status === "error" && ageH < 24) continue;
    if (!opts.force && st?.status !== "pending" && st?.result && (Date.now() - Date.parse(st.result.at)) / 3600000 < 24 * 7) continue;

    let token: string;
    try { token = await adsAccessToken(env, creds?.ads_refresh_token); } catch { continue; }
    const base = `/amc/reporting/${encodeURIComponent(instanceId)}/workflowExecutions`;
    const now = new Date().toISOString();

    if (st?.status === "pending" && st.executionId) {
      const r = await amcCall(env, token, accountId, `${base}/${encodeURIComponent(st.executionId)}`);
      const b = (r.body ?? {}) as { status?: string; statusReason?: string; errorDetails?: unknown };
      if (!r.ok) { await writeAmc(env.DB, c.id, { ...st, status: "error", at: now, message: errorMessage(r.body) }); done++; continue; }
      if (b.status === "PENDING" || b.status === "RUNNING") {
        if (ageH > 24) await writeAmc(env.DB, c.id, { ...st, status: "error", at: now, message: "24時間たっても終わりませんでした" });
        continue;
      }
      if (b.status !== "SUCCEEDED") {
        await writeAmc(env.DB, c.id, { ...st, status: "error", at: now, message: `AMC の実行が ${b.status ?? "不明"}：${b.statusReason ?? JSON.stringify(b.errorDetails ?? "").slice(0, 200)}` });
        done++; continue;
      }
      const u = await amcCall(env, token, accountId, `${base}/${encodeURIComponent(st.executionId)}/downloadUrls`);
      const urls = ((u.body ?? {}) as { downloadUrls?: string[] }).downloadUrls ?? [];
      if (!u.ok || !urls.length) { await writeAmc(env.DB, c.id, { ...st, status: "error", at: now, message: u.ok ? "結果のファイルがありません" : errorMessage(u.body) }); done++; continue; }
      const f = await fetch(urls[0]);
      const rows = f.ok ? parseCsv(await f.text()) : [];
      const row = rows[0];
      const cu = Number(row?.customers ?? ""), re = Number(row?.repeaters ?? "");
      if (!row || !Number.isFinite(cu) || !cu || row.customers === "") {
        // 人数が少ないと AMC が結果を消す（プライバシーのしきい値）
        await writeAmc(env.DB, c.id, { ...st, status: "small", at: now, message: "購入者の人数が少ないため、AMC が結果を出しませんでした" });
      } else {
        await writeAmc(env.DB, c.id, { status: "ok", at: now,
          result: { from: st.from!, to: st.to!, customers: cu, repeaters: Number.isFinite(re) ? re : 0, rate: Math.round(((Number.isFinite(re) ? re : 0) / cu) * 1000) / 10, at: now } });
      }
      done++;
      continue;
    }

    // 新しく実行する（AMC のデータは数日遅れて揃うので、3日前までを数える）
    const to = jstDay(3), from = window13(to);
    const r = await amcCall(env, token, accountId, base, {
      sqlQuery: AMC_SQL,
      timeWindowType: "EXPLICIT",
      timeWindowStart: `${from}T00:00:00`,
      timeWindowEnd: `${dayAdd(to, 1)}T00:00:00`,
      timeWindowTimeZone: "Asia/Tokyo",
      workflowExecutionTimeoutSeconds: 86400,
    });
    const id = ((r.body ?? {}) as { workflowExecutionId?: string }).workflowExecutionId;
    if (r.ok && id) await writeAmc(env.DB, c.id, { status: "pending", executionId: id, from, to, at: now, result: st?.result });
    else await writeAmc(env.DB, c.id, { status: "error", at: now, message: `AMC に実行を依頼できませんでした：${errorMessage(r.body)}`, result: st?.result });
    done++;
  }
  return done;
}

/* ───────── 期間のリピート率 ───────── */

export interface RepeatSummary {
  /** 直近13か月（期間の最終日まで）に買った人のうち、2回以上（別の日に）買った人の割合 */
  rakuten: null | { rate: number | null; customers: number; repeaters: number; from: string; to: string;
    /** 取り込み済みの最初の注文日。13か月より短いと低く出る */
    historyFrom: string | null; short: boolean };
  amazon: null | { rate: number | null; customers: number; repeaters: number; from: string; to: string; at: string };
  /** AMC の状態（未設定・実行中・失敗・人数が少ない） */
  amazonStatus: null | { status: string; message: string | null };
}

export async function repeatSummary(db: D1Database, caseId: string, _from: string, to: string): Promise<RepeatSummary> {
  const out: RepeatSummary = { rakuten: null, amazon: null, amazonStatus: null };
  try {
    const wf = window13(to);
    const rk = await db.prepare(
      `SELECT COUNT(*) AS customers, SUM(CASE WHEN d >= 2 THEN 1 ELSE 0 END) AS repeaters,
              (SELECT MIN(date) FROM customer_orders WHERE case_id = ?1 AND mall = 'rakuten') AS hist
         FROM (SELECT customer, COUNT(DISTINCT date) AS d FROM customer_orders
                WHERE case_id = ?1 AND mall = 'rakuten' AND date BETWEEN ?2 AND ?3 GROUP BY customer)`
    ).bind(caseId, wf, to).first<{ customers: number; repeaters: number | null; hist: string | null }>();
    if (rk && Number(rk.customers) > 0) {
      const cu = Number(rk.customers), re = Number(rk.repeaters ?? 0);
      out.rakuten = { rate: Math.round((re / cu) * 1000) / 10, customers: cu, repeaters: re, from: wf, to,
        historyFrom: rk.hist, short: !!rk.hist && rk.hist > wf };
    }
    const st = await readAmc(db, caseId);
    if (st?.result) out.amazon = { ...st.result };
    if (st && st.status !== "ok") out.amazonStatus = { status: st.status, message: st.message ?? null };
  } catch {
    /* テーブルがまだ無い（D1 の更新前）ときは出さない */
  }
  return out;
}
