/**
 * 入金明細（SP-API Finances v0）の読み取り
 *
 * Amazon が返す financialEvents は種類ごとに配列が分かれていて、
 * 同じ「手数料」でも階層の深さが違う。ここで1行ずつの形に均してから保存する。
 *
 * 符号はAmazonの返すまま（費用はマイナス）で持つ。
 * 足し算の向きを途中で変えると、どこかで必ず符号を間違えるため。
 */

export interface FeeRow {
  date: string;              // 日本時間の日付
  orderId: string | null;
  sku: string | null;
  eventType: "shipment" | "refund" | "service_fee" | "adjustment";
  kind: "charge" | "fee" | "promotion" | "tax_withheld";
  name: string;
  amount: number;            // 円。費用はマイナス
}

interface Amount {
  CurrencyCode?: string;
  CurrencyAmount?: number;
}

/** UTC の日時文字列を日本時間の日付に直す */
export function jstDateOf(iso: string | undefined, fallback: string): string {
  if (!iso) return fallback;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return fallback;
  return new Date(t + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function yen(a: Amount | undefined): number {
  return Math.round(a?.CurrencyAmount ?? 0);
}

interface ItemLike {
  SellerSKU?: string;
  ItemChargeList?: Array<{ ChargeType?: string; ChargeAmount?: Amount }>;
  ItemChargeAdjustmentList?: Array<{ ChargeType?: string; ChargeAmount?: Amount }>;
  ItemFeeList?: Array<{ FeeType?: string; FeeAmount?: Amount }>;
  ItemFeeAdjustmentList?: Array<{ FeeType?: string; FeeAmount?: Amount }>;
  PromotionList?: Array<{ PromotionType?: string; PromotionAmount?: Amount }>;
  PromotionAdjustmentList?: Array<{ PromotionType?: string; PromotionAmount?: Amount }>;
  ItemTaxWithheldList?: Array<{ TaxesWithheld?: Array<{ ChargeType?: string; ChargeAmount?: Amount }> }>;
}

/** 明細1件から、金額の付いている行をすべて拾う */
function rowsFromItem(
  item: ItemLike,
  date: string,
  orderId: string | null,
  eventType: FeeRow["eventType"]
): FeeRow[] {
  const sku = item.SellerSKU ?? null;
  const out: FeeRow[] = [];
  const push = (kind: FeeRow["kind"], name: string | undefined, a: Amount | undefined) => {
    const amount = yen(a);
    if (amount === 0) return;                       // 0円の行は残しても意味がない
    out.push({ date, orderId, sku, eventType, kind, name: name ?? "不明", amount });
  };

  for (const c of item.ItemChargeList ?? []) push("charge", c.ChargeType, c.ChargeAmount);
  for (const c of item.ItemChargeAdjustmentList ?? []) push("charge", c.ChargeType, c.ChargeAmount);
  for (const f of item.ItemFeeList ?? []) push("fee", f.FeeType, f.FeeAmount);
  for (const f of item.ItemFeeAdjustmentList ?? []) push("fee", f.FeeType, f.FeeAmount);
  for (const p of item.PromotionList ?? []) push("promotion", p.PromotionType, p.PromotionAmount);
  for (const p of item.PromotionAdjustmentList ?? []) push("promotion", p.PromotionType, p.PromotionAmount);
  for (const t of item.ItemTaxWithheldList ?? []) {
    for (const w of t.TaxesWithheld ?? []) push("tax_withheld", w.ChargeType, w.ChargeAmount);
  }
  return out;
}

interface ShipmentLike {
  AmazonOrderId?: string;
  PostedDate?: string;
  ShipmentItemList?: ItemLike[];
  ShipmentItemAdjustmentList?: ItemLike[];
  ShipmentFeeList?: Array<{ FeeType?: string; FeeAmount?: Amount }>;
  ShipmentFeeAdjustmentList?: Array<{ FeeType?: string; FeeAmount?: Amount }>;
  OrderFeeList?: Array<{ FeeType?: string; FeeAmount?: Amount }>;
  OrderFeeAdjustmentList?: Array<{ FeeType?: string; FeeAmount?: Amount }>;
}

function rowsFromShipment(e: ShipmentLike, fallbackDate: string, eventType: FeeRow["eventType"]): FeeRow[] {
  const date = jstDateOf(e.PostedDate, fallbackDate);
  const orderId = e.AmazonOrderId ?? null;
  const out: FeeRow[] = [];
  for (const it of e.ShipmentItemList ?? []) out.push(...rowsFromItem(it, date, orderId, eventType));
  for (const it of e.ShipmentItemAdjustmentList ?? []) out.push(...rowsFromItem(it, date, orderId, eventType));

  // 注文単位の手数料。SKUに割り当てられないので sku は null のまま残す
  const orderLevel = [
    ...(e.ShipmentFeeList ?? []), ...(e.ShipmentFeeAdjustmentList ?? []),
    ...(e.OrderFeeList ?? []), ...(e.OrderFeeAdjustmentList ?? []),
  ];
  for (const f of orderLevel) {
    const amount = yen(f.FeeAmount);
    if (amount !== 0) {
      out.push({ date, orderId, sku: null, eventType, kind: "fee", name: f.FeeType ?? "不明", amount });
    }
  }
  return out;
}

export interface ParsedEvents {
  rows: FeeRow[];
  /** 扱わなかった種類と件数。想定外のものが増えていないか見るため */
  ignored: Record<string, number>;
}

/** financialEvents の本体を1行ずつの形に均す */
export function parseFinancialEvents(events: Record<string, unknown>, fallbackDate: string): ParsedEvents {
  const rows: FeeRow[] = [];
  const ignored: Record<string, number> = {};

  for (const e of (events.ShipmentEventList as ShipmentLike[] | undefined) ?? []) {
    rows.push(...rowsFromShipment(e, fallbackDate, "shipment"));
  }
  for (const e of (events.RefundEventList as ShipmentLike[] | undefined) ?? []) {
    rows.push(...rowsFromShipment(e, fallbackDate, "refund"));
  }
  for (const e of (events.GuaranteeClaimEventList as ShipmentLike[] | undefined) ?? []) {
    rows.push(...rowsFromShipment(e, fallbackDate, "refund"));
  }
  for (const e of (events.ChargebackEventList as ShipmentLike[] | undefined) ?? []) {
    rows.push(...rowsFromShipment(e, fallbackDate, "refund"));
  }

  // アカウント単位の手数料（月額登録料など）。SKUが付くものもある
  type ServiceFee = { AmazonOrderId?: string; SellerSKU?: string; FeeReason?: string; PostedDate?: string;
                      FeeList?: Array<{ FeeType?: string; FeeAmount?: Amount }> };
  for (const e of (events.ServiceFeeEventList as ServiceFee[] | undefined) ?? []) {
    const date = jstDateOf(e.PostedDate, fallbackDate);
    for (const f of e.FeeList ?? []) {
      const amount = yen(f.FeeAmount);
      if (amount === 0) continue;
      rows.push({
        date, orderId: e.AmazonOrderId ?? null, sku: e.SellerSKU ?? null,
        eventType: "service_fee", kind: "fee",
        name: f.FeeType ?? e.FeeReason ?? "サービス料", amount,
      });
    }
  }

  // 調整（在庫の紛失補填など）
  type Adjustment = { AdjustmentType?: string; PostedDate?: string; AdjustmentAmount?: Amount;
                      AdjustmentItemList?: Array<{ SellerSKU?: string; TotalAmount?: Amount }> };
  for (const e of (events.AdjustmentEventList as Adjustment[] | undefined) ?? []) {
    const date = jstDateOf(e.PostedDate, fallbackDate);
    const items = e.AdjustmentItemList ?? [];
    if (items.length) {
      for (const it of items) {
        const amount = yen(it.TotalAmount);
        if (amount === 0) continue;
        rows.push({ date, orderId: null, sku: it.SellerSKU ?? null, eventType: "adjustment",
          kind: "charge", name: e.AdjustmentType ?? "調整", amount });
      }
    } else {
      const amount = yen(e.AdjustmentAmount);
      if (amount !== 0) {
        rows.push({ date, orderId: null, sku: null, eventType: "adjustment",
          kind: "charge", name: e.AdjustmentType ?? "調整", amount });
      }
    }
  }

  // 残りは件数だけ数えておく
  const handled = new Set([
    "ShipmentEventList", "RefundEventList", "GuaranteeClaimEventList", "ChargebackEventList",
    "ServiceFeeEventList", "AdjustmentEventList",
  ]);
  for (const [k, v] of Object.entries(events)) {
    if (handled.has(k)) continue;
    if (Array.isArray(v) && v.length) ignored[k] = v.length;
  }

  return { rows, ignored };
}
