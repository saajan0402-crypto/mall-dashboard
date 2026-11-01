/**
 * 定期おトク便の取り込み（Replenishment API）
 *
 * 3本呼んで1行にまとめる。
 *   設定   offers/search          … 継続購読数・在庫・出品資格
 *   実績   offers/metrics/search  … 直近1週間の出荷数・売上・在庫切れによる未配送
 *   予測   offers/metrics/search  … 今後30/60/90日の出荷予測
 *
 * このAPIは呼び出し制限が厳しく、続けて叩くと 429 を返す。間隔をあける。
 * また実績は「ちょうど1週間（日曜〜土曜）」でないと受け付けられない。
 */

import { readCreds, type ConnEnv } from "./connections";
import { accessToken, spapi, errorMessage, JP_MARKETPLACE, type LwaEnv } from "./amazon";

export interface SnsEnv extends ConnEnv, LwaEnv {}

export interface SnsOutcome {
  caseId: string;
  status: "done" | "error";
  message: string;
  rows?: number;
}

const PATH_OFFERS = "/replenishment/2022-11-07/offers/search";
const PATH_METRICS = "/replenishment/2022-11-07/offers/metrics/search";

/* ───────── 期間の計算 ───────── */

const day = (d: Date, n: number) => new Date(d.getTime() + n * 24 * 60 * 60 * 1000);
const stamp = (d: Date) => d.toISOString().slice(0, 10) + "T00:00:00Z";

/** 直近の「終わった週」。週は日曜はじまり・土曜おわり */
export function lastFullWeek(now = new Date()): { startDate: string; endDate: string } {
  const today = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const back = ((today.getUTCDay() - 6) + 7) % 7 || 7;
  const sat = day(today, -back);
  return { startDate: stamp(day(sat, -6)), endDate: stamp(sat) };
}

/** これから先の8週間（次の日曜から） */
function nextWeeks(now = new Date()): { startDate: string; endDate: string } {
  const today = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const to = (7 - today.getUTCDay()) % 7 || 7;
  const sun = day(today, to);
  return { startDate: stamp(sun), endDate: stamp(day(sun, 55)) };
}

/* ───────── 呼び出し ───────── */

interface Offer {
  asin?: string;
  sku?: string;
  sellerSku?: string;
  [k: string]: unknown;
}

async function call(
  token: string,
  path: string,
  body: Record<string, unknown>
): Promise<{ ok: boolean; offers: Offer[]; message: string }> {
  const offers: Offer[] = [];
  for (let page = 0; page < 5; page++) {
    const withPage = { ...body, pagination: { limit: 50, offset: page * 50 } };
    let r = await spapi(token, path, { method: "POST", body: withPage });
    if (r.status === 429) {
      await new Promise((res) => setTimeout(res, 12000));
      r = await spapi(token, path, { method: "POST", body: withPage });
    }
    if (!r.ok) return { ok: false, offers, message: errorMessage(r.body) };

    const got = ((r.body as { offers?: Offer[] }).offers ?? []);
    offers.push(...got);
    if (got.length < 50) break;
    await new Promise((res) => setTimeout(res, 3000));
  }
  return { ok: true, offers, message: "取得しました" };
}

/** 数値として読めれば整数で返す */
function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
}

/** ASIN か SKU。どちらも無い行は捨てる */
function keyOf(o: Offer): string | null {
  const k = o.asin ?? o.sku ?? o.sellerSku;
  return typeof k === "string" && k.trim() ? k.trim() : null;
}

interface Merged {
  key: string;
  asin: string | null;
  sku: string | null;
  subscriptions: number | null;
  eligibility: string | null;
  amazonInventory: number | null;
  shippedUnits: number | null;
  shippedRevenue: number | null;
  oosNotDelivered: number | null;
  oosLostRevenue: number | null;
  next30: number | null;
  next60: number | null;
  next90: number | null;
  next30Revenue: number | null;
}

function blank(key: string, o: Offer): Merged {
  return {
    key,
    asin: typeof o.asin === "string" ? o.asin : null,
    sku: typeof (o.sku ?? o.sellerSku) === "string" ? String(o.sku ?? o.sellerSku) : null,
    subscriptions: null, eligibility: null, amazonInventory: null,
    shippedUnits: null, shippedRevenue: null, oosNotDelivered: null, oosLostRevenue: null,
    next30: null, next60: null, next90: null, next30Revenue: null,
  };
}

/** 1案件ぶんを取り込む */
export async function ingestSns(env: SnsEnv, caseId: string): Promise<SnsOutcome> {
  const creds = await readCreds(env, caseId, "amazon");
  if (!creds?.refresh_token) return { caseId, status: "error", message: "Amazon の接続情報が未登録です" };

  let token: string;
  try {
    token = await accessToken(env, creds.refresh_token);
  } catch (e) {
    return { caseId, status: "error", message: `アクセストークンを取れません：${String(e)}` };
  }

  const base = { marketplaceId: JP_MARKETPLACE, programTypes: ["SUBSCRIBE_AND_SAVE"] };
  const week = lastFullWeek();
  const future = nextWeeks();

  const settings = await call(token, PATH_OFFERS, { filters: base });
  await new Promise((r) => setTimeout(r, 3000));
  const perf = await call(token, PATH_METRICS, {
    filters: { ...base, aggregationFrequency: "WEEK", timeInterval: week, timePeriodType: "PERFORMANCE" },
    metrics: ["SHIPPED_SUBSCRIPTION_UNITS", "TOTAL_SUBSCRIPTIONS_REVENUE"],
  });
  await new Promise((r) => setTimeout(r, 3000));
  const fcst = await call(token, PATH_METRICS, {
    filters: { ...base, timeInterval: future, timePeriodType: "FORECAST" },
    metrics: ["SHIPPED_SUBSCRIPTION_UNITS", "TOTAL_SUBSCRIPTIONS_REVENUE"],
  });

  const failed = [settings, perf, fcst].find((r) => !r.ok);
  if (failed) {
    await env.DB.prepare(
      `INSERT INTO ingests (id, case_id, mall, kind, rows, status, error, source)
       VALUES (?, ?, 'amazon', 'sns', 0, 'error', ?, 'api')`
    ).bind(crypto.randomUUID(), caseId, failed.message).run();
    return { caseId, status: "error", message: failed.message };
  }

  const merged = new Map<string, Merged>();
  const take = (o: Offer, fill: (m: Merged) => void) => {
    const k = keyOf(o);
    if (!k) return;
    const m = merged.get(k) ?? blank(k, o);
    if (!m.asin && typeof o.asin === "string") m.asin = o.asin;
    if (!m.sku && typeof (o.sku ?? o.sellerSku) === "string") m.sku = String(o.sku ?? o.sellerSku);
    fill(m);
    merged.set(k, m);
  };

  for (const o of settings.offers) {
    take(o, (m) => {
      m.subscriptions = num(o.subscriptions);
      m.eligibility = typeof o.eligibility === "string" ? o.eligibility : null;
      m.amazonInventory = num(o.inventory);
    });
  }
  for (const o of perf.offers) {
    take(o, (m) => {
      m.shippedUnits = num(o.shippedSubscriptionUnits);
      m.shippedRevenue = num(o.totalSubscriptionsRevenue);
      m.oosNotDelivered = num(o.notDeliveredDueToOOS);
      m.oosLostRevenue = num(o.lostRevenueDueToOOS);
    });
  }
  for (const o of fcst.offers) {
    take(o, (m) => {
      m.next30 = num(o.next30DayShippedSubscriptionUnits);
      m.next60 = num(o.next60DayShippedSubscriptionUnits);
      m.next90 = num(o.next90DayShippedSubscriptionUnits);
      m.next30Revenue = num(o.next30DayTotalSubscriptionsRevenue);
    });
  }

  // 商品の照合。ASIN が主、無ければ Amazon SKU
  const { results: listings } = await env.DB
    .prepare(
      `SELECT l.external_id AS sku, l.asin, l.product_id
         FROM product_listings l JOIN products p ON p.id = l.product_id
        WHERE l.mall = 'amazon' AND p.case_id = ?`
    )
    .bind(caseId)
    .all<{ sku: string; asin: string | null; product_id: string }>();
  const byAsin = new Map<string, string>();
  const bySku = new Map<string, string>();
  for (const l of listings) {
    if (l.asin) byAsin.set(l.asin, l.product_id);
    bySku.set(l.sku, l.product_id);
  }

  const date = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  const statements: D1PreparedStatement[] = [
    env.DB.prepare("DELETE FROM sns_offers WHERE case_id = ? AND date = ?").bind(caseId, date),
  ];
  for (const m of merged.values()) {
    const productId = (m.asin && byAsin.get(m.asin)) ?? (m.sku && bySku.get(m.sku)) ?? null;
    statements.push(
      env.DB
        .prepare(
          `INSERT INTO sns_offers
             (case_id, date, offer_key, asin, sku, product_id, subscriptions, eligibility, amazon_inventory,
              shipped_units, shipped_revenue, oos_not_delivered, oos_lost_revenue,
              next30_units, next60_units, next90_units, next30_revenue, period_start, period_end)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        )
        .bind(
          caseId, date, m.key, m.asin, m.sku, productId, m.subscriptions, m.eligibility, m.amazonInventory,
          m.shippedUnits, m.shippedRevenue, m.oosNotDelivered, m.oosLostRevenue,
          m.next30, m.next60, m.next90, m.next30Revenue,
          week.startDate.slice(0, 10), week.endDate.slice(0, 10)
        )
    );
  }
  await env.DB.batch(statements);

  const unmatched = [...merged.values()].filter(
    (m) => !((m.asin && byAsin.get(m.asin)) || (m.sku && bySku.get(m.sku)))
  );
  const note = unmatched.length
    ? `商品マスタと結びつかない定期便が ${unmatched.length} 件：${unmatched.slice(0, 10).map((m) => m.key).join(", ")}`
    : null;

  await env.DB.prepare(
    `INSERT INTO ingests (id, case_id, mall, kind, period_start, period_end, rows, status, error, source)
     VALUES (?, ?, 'amazon', 'sns', ?, ?, ?, 'ok', ?, 'api')`
  ).bind(crypto.randomUUID(), caseId, week.startDate.slice(0, 10), week.endDate.slice(0, 10),
         merged.size, note).run();

  return { caseId, status: "done", rows: merged.size,
    message: `${merged.size} 件の定期便を取り込みました${note ? `（${note}）` : ""}` };
}

/** 全案件ぶん */
export async function pumpSns(env: SnsEnv): Promise<SnsOutcome[]> {
  const { results: cases } = await env.DB.prepare(
    `SELECT c.id FROM cases c
       JOIN case_malls m ON m.case_id = c.id AND m.mall = 'amazon' AND m.credentials_enc IS NOT NULL
      WHERE c.status = 'active'`
  ).all<{ id: string }>();

  const out: SnsOutcome[] = [];
  for (const c of cases) {
    out.push(await ingestSns(env, c.id));
    await new Promise((r) => setTimeout(r, 3000));
  }
  return out;
}
