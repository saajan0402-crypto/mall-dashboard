/**
 * Amazon の入金明細（fee_events）から、期間の費用を「計上日」で数える
 *
 * 以前は入金明細の手数料・返品を「同じ日・同じ商品の売上の行（daily_sales）」に書き込み、
 * そこから粗利を出していた。この作りには穴が2つあった（2026-11 Anomasala 10月の明細と照合して判明）。
 *   1. その商品の売上が無い日に計上された手数料・返品は、書き込む行が無くて捨てられる
 *   2. 売上レポートを取り直すと日次の行が作り直され、書き込んだ実額が消えて概算に戻る
 * そこで、入金明細を取り込めている日（covered）は daily_sales の手数料・返品・値引きを使わず、
 * 期間内に計上された fee_events の合計で数える。取り込めていない日（直近の数日など）だけ概算を使う。
 *
 * 売上は今まで通り注文日（売上・トラフィックレポート）。費用は計上日。
 * 月の合計はセラーセントラルの日付範囲レポートと同じ数字になる。
 */

export interface FinAmounts {
  /** 販売手数料・FBA手数料など（返金で戻った手数料は差し引き済み） */
  fees: number;
  /** プロモーション割引（クーポン・タイムセールの値引き） */
  promotions: number;
  /** Amazonポイントの費用（返却分は差し引き済み） */
  points: number;
  /** 返金した商品代金・税・配送料 */
  refunds: number;
  /** 購入者から受け取った配送料（収入） */
  shipping: number;
}

const zero = (): FinAmounts => ({ fees: 0, promotions: 0, points: 0, refunds: 0, shipping: 0 });
const n = (v: unknown) => Number(v ?? 0) || 0;

/** daily_sales の行（別名 s）が「入金明細を取り込めている日」かどうか。SQL に埋め込んで使う */
export const COVERED_SQL = `(s.mall = 'amazon' AND EXISTS (SELECT 1 FROM ingests i
  WHERE i.case_id = s.case_id AND i.mall = 'amazon' AND i.kind = 'settlement' AND i.status = 'ok' AND i.period_start = s.date))`;

/** 期間内に計上された入金明細を商品ごとに集計する（商品に紐づくものだけ） */
export async function amazonFinance(db: D1Database, caseId: string, from: string, to: string): Promise<{
  byProduct: Map<string, FinAmounts>;
  total: FinAmounts;
}> {
  const { results } = await db.prepare(
    `SELECT product_id,
       -SUM(CASE WHEN kind IN ('fee', 'tax_withheld') THEN amount ELSE 0 END) AS fees,
       -SUM(CASE WHEN kind = 'promotion' THEN amount ELSE 0 END) AS promotions,
       -SUM(CASE WHEN kind = 'points' THEN amount ELSE 0 END) AS points,
       -SUM(CASE WHEN event_type = 'refund' AND kind = 'charge' THEN amount ELSE 0 END) AS refunds,
        SUM(CASE WHEN event_type = 'shipment' AND kind = 'charge' AND name IN ('ShippingCharge', 'ShippingTax') THEN amount ELSE 0 END) AS shipping
       FROM fee_events
      WHERE case_id = ? AND mall = 'amazon' AND date BETWEEN ? AND ? AND product_id IS NOT NULL
      GROUP BY product_id`
  ).bind(caseId, from, to).all<Record<string, string | number | null>>();
  const byProduct = new Map<string, FinAmounts>();
  const total = zero();
  for (const r of results) {
    const a: FinAmounts = { fees: n(r.fees), promotions: n(r.promotions), points: n(r.points), refunds: n(r.refunds), shipping: n(r.shipping) };
    byProduct.set(String(r.product_id), a);
    for (const k of Object.keys(total) as Array<keyof FinAmounts>) total[k] += a[k];
  }
  return { byProduct, total };
}

/** 粗利から引く額（手数料＋値引き＋ポイント＋返金 − 受け取った配送料） */
export const finCost = (a: FinAmounts | undefined) =>
  a ? a.fees + a.promotions + a.points + a.refunds - a.shipping : 0;

/* ───────── 月次確定（明細ベース） ───────── */

export interface MonthlyStatement {
  month: string;
  /** その月で入金明細を取り込めた日数／月の日数 */
  coveredDays: number;
  days: number;
  lines: Array<{ group: string; label: string; name: string; amount: number }>;
  totals: {
    sales: number;        // 商品売上（税込）
    shipping: number;     // 配送料（税込）
    refunds: number;      // 返金（マイナス）
    promotions: number;   // プロモーション割引（マイナス）
    points: number;       // ポイントの費用（マイナス）
    orderFees: number;    // 注文ごとの手数料（マイナス）
    accountFees: number;  // 月額登録料・保管料など（マイナス）
    adjustments: number;  // 補填・調整
    net: number;          // 合計（振込みの元になる額）
  };
}

/**
 * セラーセントラルの日付範囲レポートと同じ並びで、その月の入金明細をまとめる。
 * 符号は明細と同じ（収入はプラス、費用はマイナス）
 */
export async function monthlyStatement(db: D1Database, caseId: string, month: string): Promise<MonthlyStatement> {
  const from = `${month}-01`;
  const last = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
  const to = `${month}-${String(last).padStart(2, "0")}`;

  const cov = await db.prepare(
    `SELECT COUNT(DISTINCT period_start) AS d FROM ingests
      WHERE case_id = ? AND mall = 'amazon' AND kind = 'settlement' AND status = 'ok' AND period_start BETWEEN ? AND ?`
  ).bind(caseId, from, to).first<{ d: number }>();

  const { results } = await db.prepare(
    `SELECT event_type, kind, name, (product_id IS NOT NULL OR sku IS NOT NULL OR order_id IS NOT NULL) AS per_order,
            SUM(amount) AS amount
       FROM fee_events WHERE case_id = ? AND mall = 'amazon' AND date BETWEEN ? AND ?
      GROUP BY event_type, kind, name, per_order`
  ).bind(caseId, from, to).all<{ event_type: string; kind: string; name: string; per_order: number; amount: number }>();

  const t = { sales: 0, shipping: 0, refunds: 0, promotions: 0, points: 0, orderFees: 0, accountFees: 0, adjustments: 0, net: 0 };
  const lines: MonthlyStatement["lines"] = [];
  for (const r of results) {
    const a = n(r.amount);
    let group: string;
    if (r.event_type === "adjustment") { group = "補填・調整"; t.adjustments += a; }
    else if (r.event_type === "refund" && r.kind === "charge") { group = "返金"; t.refunds += a; }
    else if (r.kind === "charge" && /^Shipping/.test(r.name)) { group = "配送料"; t.shipping += a; }
    else if (r.kind === "charge") { group = "商品売上"; t.sales += a; }
    else if (r.kind === "promotion") { group = "プロモーション割引"; t.promotions += a; }
    else if (r.kind === "points") { group = "ポイントの費用"; t.points += a; }
    else if (r.event_type === "service_fee" || !r.per_order) { group = "月額登録料・保管料など"; t.accountFees += a; }
    else { group = "注文ごとの手数料"; t.orderFees += a; }
    lines.push({ group, label: group, name: r.name, amount: a });
  }
  t.net = t.sales + t.shipping + t.refunds + t.promotions + t.points + t.orderFees + t.accountFees + t.adjustments;
  const order = ["商品売上", "配送料", "返金", "プロモーション割引", "ポイントの費用", "注文ごとの手数料", "月額登録料・保管料など", "補填・調整"];
  lines.sort((x, y) => order.indexOf(x.group) - order.indexOf(y.group) || Math.abs(y.amount) - Math.abs(x.amount));
  return { month, coveredDays: n(cov?.d), days: last, lines, totals: t };
}
