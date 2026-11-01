/**
 * FBA在庫の取り込みと欠品アラート
 *
 * 在庫数そのものより「あと何日もつか」が知りたいので、
 * 直近の販売ペースと突き合わせて日数に直してから判断する。
 *
 * 販売ペースは、売上データが入っている日だけで平均を取る。
 * 取り込めていない日を0として割ると、ペースを低く見積もって
 * 欠品を見逃すため。
 */

import { readCreds, type ConnEnv } from "./connections";
import { accessToken, spapi, errorMessage, JP_MARKETPLACE, type LwaEnv } from "./amazon";

export interface InventoryEnv extends ConnEnv, LwaEnv {
  SLACK_WEBHOOK_URL?: string;
}

export interface InventoryOutcome {
  caseId: string;
  status: "done" | "error";
  message: string;
  rows?: number;
  unknownSkus?: string[];
}

interface Summary {
  sellerSku?: string;
  asin?: string;
  productName?: string;
  totalQuantity?: number;
  inventoryDetails?: {
    fulfillableQuantity?: number;
    inboundWorkingQuantity?: number;
    inboundShippedQuantity?: number;
    inboundReceivingQuantity?: number;
    reservedQuantity?: { totalReservedQuantity?: number };
    unfulfillableQuantity?: { totalUnfulfillableQuantity?: number };
  };
}

const MAX_PAGES = 20;

/** FBA在庫を全ページ取る */
async function fetchSummaries(token: string): Promise<{ ok: boolean; items: Summary[]; message: string }> {
  const items: Summary[] = [];
  let nextToken: string | undefined;

  for (let page = 0; page < MAX_PAGES; page++) {
    const qs =
      `details=true&granularityType=Marketplace&granularityId=${JP_MARKETPLACE}` +
      `&marketplaceIds=${JP_MARKETPLACE}` +
      (nextToken ? `&nextToken=${encodeURIComponent(nextToken)}` : "");

    const r = await spapi(token, `/fba/inventory/v1/summaries?${qs}`);
    if (!r.ok) return { ok: false, items, message: errorMessage(r.body) };

    // 返ってくる形が payload で包まれる場合と包まれない場合があるので両方見る
    const b = r.body as {
      payload?: { inventorySummaries?: Summary[] };
      inventorySummaries?: Summary[];
      pagination?: { nextToken?: string };
    };
    items.push(...(b.payload?.inventorySummaries ?? b.inventorySummaries ?? []));

    nextToken = b.pagination?.nextToken;
    if (!nextToken) break;
    await new Promise((r2) => setTimeout(r2, 600));   // 2リクエスト/秒まで
  }
  return { ok: true, items, message: "取得しました" };
}

/** 日本時間の今日 */
function todayJst(): string {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/**
 * 商品ごとの1日あたり販売数。
 * データが入っている日数で割る（取り込めていない日を0として数えない）
 */
async function velocities(db: D1Database, caseId: string, days = 28): Promise<Map<string, number>> {
  const from = new Date(Date.now() + 9 * 3600 * 1000 - days * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const { results } = await db
    .prepare(
      `SELECT product_id, SUM(units) AS units, COUNT(DISTINCT date) AS days
         FROM daily_sales
        WHERE case_id = ? AND mall = 'amazon' AND date >= ? AND product_id IS NOT NULL
        GROUP BY product_id`
    )
    .bind(caseId, from)
    .all<{ product_id: string; units: number; days: number }>();

  const m = new Map<string, number>();
  for (const r of results) {
    if (r.days > 0) m.set(r.product_id, r.units / r.days);
  }
  return m;
}

/** 1案件ぶんの在庫を取り込む */
export async function ingestInventory(env: InventoryEnv, caseId: string): Promise<InventoryOutcome> {
  const creds = await readCreds(env, caseId, "amazon");
  if (!creds?.refresh_token) return { caseId, status: "error", message: "Amazon の接続情報が未登録です" };

  let token: string;
  try {
    token = await accessToken(env, creds.refresh_token);
  } catch (e) {
    return { caseId, status: "error", message: `アクセストークンを取れません：${String(e)}` };
  }

  const got = await fetchSummaries(token);
  if (!got.ok) {
    await env.DB.prepare(
      `INSERT INTO ingests (id, case_id, mall, kind, rows, status, error, source)
       VALUES (?, ?, 'amazon', 'inventory', 0, 'error', ?, 'api')`
    ).bind(crypto.randomUUID(), caseId, got.message).run();
    return { caseId, status: "error", message: got.message };
  }

  const { results: listings } = await env.DB
    .prepare(
      `SELECT l.external_id AS sku, l.product_id
         FROM product_listings l JOIN products p ON p.id = l.product_id
        WHERE l.mall = 'amazon' AND p.case_id = ?`
    )
    .bind(caseId)
    .all<{ sku: string; product_id: string }>();
  const map = new Map(listings.map((r) => [r.sku, r.product_id]));

  const vel = await velocities(env.DB, caseId);
  const date = todayJst();

  const statements: D1PreparedStatement[] = [
    env.DB.prepare("DELETE FROM daily_inventory WHERE case_id = ? AND mall = 'amazon' AND date = ?").bind(caseId, date),
  ];
  const unknown: string[] = [];
  let saved = 0;

  for (const s of got.items) {
    const sku = (s.sellerSku ?? "").trim();
    if (!sku) continue;
    const productId = map.get(sku);
    if (!productId) {
      if ((s.totalQuantity ?? 0) > 0) unknown.push(sku);
      continue;
    }
    const d = s.inventoryDetails ?? {};
    const fulfillable = d.fulfillableQuantity ?? 0;
    const inbound =
      (d.inboundWorkingQuantity ?? 0) + (d.inboundShippedQuantity ?? 0) + (d.inboundReceivingQuantity ?? 0);
    const reserved = d.reservedQuantity?.totalReservedQuantity ?? 0;
    const unfulfillable = d.unfulfillableQuantity?.totalUnfulfillableQuantity ?? 0;
    const v = vel.get(productId) ?? null;
    const dos = v && v > 0 ? Math.round((fulfillable / v) * 10) / 10 : null;

    statements.push(
      env.DB
        .prepare(
          `INSERT INTO daily_inventory
             (case_id, mall, product_id, date, qty, days_of_supply, inbound, reserved, unfulfillable, total, velocity)
           VALUES (?, 'amazon', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(caseId, productId, date, fulfillable, dos, inbound, reserved, unfulfillable,
              s.totalQuantity ?? fulfillable, v)
    );
    saved++;
  }

  await env.DB.batch(statements);

  const note = unknown.length
    ? `商品マスタに無いSKUが ${unknown.length} 件：${unknown.slice(0, 10).join(", ")}`
    : null;
  await env.DB.prepare(
    `INSERT INTO ingests (id, case_id, mall, kind, rows, status, error, source)
     VALUES (?, ?, 'amazon', 'inventory', ?, 'ok', ?, 'api')`
  ).bind(crypto.randomUUID(), caseId, saved, note).run();

  return { caseId, status: "done", rows: saved, unknownSkus: unknown,
    message: `${saved} 商品ぶんの在庫を取り込みました${note ? `（${note}）` : ""}` };
}

/* ───────── アラート ───────── */

export interface InventoryRow {
  caseId: string;
  caseName: string;
  productId: string;
  sku: string;
  name: string;
  date: string;
  qty: number;
  inbound: number;
  reserved: number;
  unfulfillable: number;
  velocity: number | null;
  daysOfSupply: number | null;
  threshold: number;
  /** 定期おトク便。確定した将来需要なので在庫判断に効く */
  subscriptions: number | null;
  snsNext30: number | null;
  snsNotDelivered: number | null;
  level: "out" | "risk" | "watch" | "ok" | "unknown";
  /** なぜその判定になったか */
  reason: string;
}

/** 設定の継承：商品 → 案件 → 会社共通 */
async function alertDays(db: D1Database): Promise<{ company: number; byCase: Map<string, number>; byProduct: Map<string, number> }> {
  const { results } = await db
    .prepare("SELECT scope, scope_id, value FROM settings WHERE key = 'stock_alert_days'")
    .all<{ scope: string; scope_id: string; value: string }>();
  let company = 14;
  const byCase = new Map<string, number>();
  const byProduct = new Map<string, number>();
  for (const r of results) {
    const n = Number(JSON.parse(r.value));
    if (!Number.isFinite(n)) continue;
    if (r.scope === "company") company = n;
    else if (r.scope === "case") byCase.set(r.scope_id, n);
    else if (r.scope === "listing") byProduct.set(r.scope_id, n);
  }
  return { company, byCase, byProduct };
}

/** いちばん新しい日の在庫を、あと何日もつかで並べて返す */
export async function inventoryStatus(db: D1Database, caseId?: string): Promise<InventoryRow[]> {
  const { results } = await db
    .prepare(
      `SELECT i.case_id, c.name AS case_name, i.product_id, p.sku, p.name, i.date,
              i.qty, i.inbound, i.reserved, i.unfulfillable, i.velocity, i.days_of_supply,
              s.subscriptions, s.next30_units, s.oos_not_delivered
         FROM daily_inventory i
         JOIN products p ON p.id = i.product_id
         JOIN cases c ON c.id = i.case_id
         LEFT JOIN sns_offers s
                ON s.product_id = i.product_id
               AND s.date = (SELECT MAX(date) FROM sns_offers x WHERE x.product_id = i.product_id)
        WHERE i.mall = 'amazon'
          AND i.date = (SELECT MAX(date) FROM daily_inventory d
                         WHERE d.case_id = i.case_id AND d.mall = 'amazon')
          ${caseId ? "AND i.case_id = ?" : ""}
        ORDER BY i.days_of_supply IS NULL, i.days_of_supply`
    )
    .bind(...(caseId ? [caseId] : []))
    .all<Record<string, string | number | null>>();

  const t = await alertDays(db);
  return results.map((r) => {
    const productId = String(r.product_id);
    const cid = String(r.case_id);
    const threshold = t.byProduct.get(productId) ?? t.byCase.get(cid) ?? t.company;
    const dos = r.days_of_supply == null ? null : Number(r.days_of_supply);
    const qty = Number(r.qty ?? 0);

    const subscriptions = r.subscriptions == null ? null : Number(r.subscriptions);
    const snsNext30 = r.next30_units == null ? null : Number(r.next30_units);
    const snsNotDelivered = r.oos_not_delivered == null ? null : Number(r.oos_not_delivered);

    // 定期おトク便は確定した将来需要なので、販売ペースより優先して見る
    let level: InventoryRow["level"];
    let reason: string;
    if (qty <= 0) {
      level = "out";
      reason = "販売可能な在庫がありません";
    } else if (snsNotDelivered && snsNotDelivered > 0) {
      level = "out";
      reason = `在庫切れで定期便を ${snsNotDelivered} 個届けられませんでした`;
    } else if (snsNext30 != null && snsNext30 > 0 && qty < snsNext30) {
      level = "risk";
      reason = `今後30日の定期便 ${snsNext30} 個に対して在庫が ${qty} 個しかありません`;
    } else if (dos == null) {
      level = "unknown";
      reason = "販売実績がないため日数を出せません";
    } else if (dos < threshold) {
      level = "risk";
      reason = `残り約${dos}日（しきい値 ${threshold}日）`;
    } else if (dos < threshold * 2) {
      level = "watch";
      reason = `残り約${dos}日`;
    } else {
      level = "ok";
      reason = `残り約${dos}日`;
    }

    return {
      caseId: cid, caseName: String(r.case_name), productId,
      sku: String(r.sku), name: String(r.name), date: String(r.date),
      qty, inbound: Number(r.inbound ?? 0), reserved: Number(r.reserved ?? 0),
      unfulfillable: Number(r.unfulfillable ?? 0),
      velocity: r.velocity == null ? null : Math.round(Number(r.velocity) * 100) / 100,
      daysOfSupply: dos, threshold, subscriptions, snsNext30, snsNotDelivered, level, reason,
    };
  });
}

/** 欠品・欠品間近だけを Slack に流す。Webhook が未設定なら何もしない */
export async function notifyInventory(env: InventoryEnv): Promise<{ sent: boolean; count: number }> {
  const rows = await inventoryStatus(env.DB);
  const urgent = rows.filter((r) => r.level === "out" || r.level === "risk");
  if (!urgent.length || !env.SLACK_WEBHOOK_URL) return { sent: false, count: urgent.length };

  const lines = urgent.map((r) => {
    const head = r.level === "out" ? ":red_circle: 在庫切れ" : ":warning: 欠品間近";
    const inbound = r.inbound ? `／納品中 ${r.inbound}個` : "";
    const sns = r.subscriptions ? `／定期便 ${r.subscriptions}件` : "";
    return `${head}　*${r.caseName}* ${r.sku}（${r.name}）　在庫 ${r.qty}個${inbound}${sns}\n　　${r.reason}`;
  });

  await fetch(env.SLACK_WEBHOOK_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: ["*FBA在庫のアラート*", ...lines].join("\n") }),
  });
  return { sent: true, count: urgent.length };
}

/** 全案件ぶんを取り込む */
export async function pumpInventory(env: InventoryEnv): Promise<InventoryOutcome[]> {
  const { results: cases } = await env.DB.prepare(
    `SELECT c.id FROM cases c
       JOIN case_malls m ON m.case_id = c.id AND m.mall = 'amazon' AND m.credentials_enc IS NOT NULL
      WHERE c.status = 'active'`
  ).all<{ id: string }>();

  const out: InventoryOutcome[] = [];
  for (const c of cases) out.push(await ingestInventory(env, c.id));
  return out;
}
