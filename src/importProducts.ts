/**
 * 商品マスタの取り込み
 *
 * Google スプレッドシートからコピーした範囲（タブ区切り）を受け取り、
 * 検証してからデータベースへ入れる。
 *
 * 方針
 *   - 列の位置ではなく見出しの名前で対応づける（列が増減しても壊れないように）
 *   - 1行でも不正があれば、その行だけ取り込まずに理由を返す
 *   - 原価は上書きせず、適用開始日つきの履歴として積む
 */

export type Row = Record<string, string>;

export interface RowError {
  line: number;
  sku: string;
  messages: string[];
}

export interface ParsedProduct {
  line: number;
  caseName: string;
  sku: string;
  name: string;
  jan: string | null;
  amazonSku: string | null;
  asin: string | null;
  amazonFulfillment: string | null;
  rakutenId: string | null;
  rakutenFulfillment: string | null;
  unitCost: number | null;
  effectiveFrom: string;
  shippingCost: number;
  packagingCost: number;
  targetMargin: number | null;
  adPolicy: string;
  stockAlertDays: number | null;
  status: string;
}

/** 見出しのゆらぎを吸収する（全角空白・単位つき・大文字小文字） */
function normalizeHeader(h: string): string {
  return h
    .replace(/[（(][^）)]*[）)]/g, "")
    .replace(/[\s　]/g, "")
    .toLowerCase();
}

const HEADER_MAP: Record<string, string> = {
  案件: "caseName",
  自社sku: "sku",
  商品名: "name",
  janコード: "jan",
  jan: "jan",
  "amazonsku": "amazonSku",
  asin: "asin",
  "amazon発送方法": "amazonFulfillment",
  楽天商品管理番号: "rakutenId",
  "楽天発送方法": "rakutenFulfillment",
  仕入原価: "unitCost",
  原価の適用開始日: "effectiveFrom",
  自社発送の送料: "shippingCost",
  梱包資材費: "packagingCost",
  目標粗利率: "targetMargin",
  広告方針: "adPolicy",
  在庫アラート日数: "stockAlertDays",
  状態: "status",
  備考: "note",
};

const FULFILLMENT: Record<string, string> = {
  fba: "fba",
  自社発送: "own",
  マルチチャネル: "mcf",
  mcf: "mcf",
};

const AD_POLICY: Record<string, string> = {
  利益重視: "profit",
  シェア獲得: "share",
  育成中: "nurture",
};

const STATUS: Record<string, string> = {
  販売中: "active",
  販売終了: "discontinued",
};

function toInt(v: string): number | null {
  const s = v.replace(/[,¥\s　円%]/g, "");
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n) : NaN;
}

function toDate(v: string): string | null {
  const s = v.trim().replace(/[/.]/g, "-");
  const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!m) return null;
  const [, y, mo, d] = m;
  const iso = `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
  // 実在する日付か確かめる（2026-13-45 のような値をはじく）
  const dt = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(dt.getTime()) || dt.toISOString().slice(0, 10) !== iso) return null;
  return iso;
}

export function parseProductSheet(
  text: string,
  today: string
): { rows: ParsedProduct[]; errors: RowError[]; skipped: number } {
  const lines = text.replace(/\r\n?/g, "\n").split("\n").filter((l) => l.trim() !== "");
  if (lines.length === 0) return { rows: [], errors: [], skipped: 0 };

  // 1行目が見出しかどうかを判定する
  const first = lines[0].split("\t").map(normalizeHeader);
  const hasHeader = first.includes("案件") && first.includes("自社sku");
  if (!hasHeader) {
    return {
      rows: [],
      errors: [{ line: 1, sku: "", messages: ["1行目に見出し行が見つかりません。見出しごとコピーしてください。"] }],
      skipped: 0,
    };
  }

  const keys = first.map((h) => HEADER_MAP[h] ?? null);
  const rows: ParsedProduct[] = [];
  const errors: RowError[] = [];
  let skipped = 0;

  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split("\t");
    const r: Row = {};
    keys.forEach((k, idx) => {
      if (k) r[k] = (cells[idx] ?? "").trim();
    });

    if (!r.caseName && !r.sku && !r.name) { skipped++; continue; }
    if (r.caseName.startsWith("（記入例）") || r.caseName.startsWith("(記入例)")) { skipped++; continue; }

    const msgs: string[] = [];
    if (!r.caseName) msgs.push("案件が空です");
    if (!r.sku) msgs.push("自社SKUが空です");
    if (!r.name) msgs.push("商品名が空です");
    if (!r.amazonSku && !r.rakutenId) msgs.push("Amazon SKU と 楽天 商品管理番号 の両方が空です（どちらか一方は必要）");

    const unitCost = toInt(r.unitCost ?? "");
    if (Number.isNaN(unitCost)) msgs.push("仕入原価が数値ではありません");
    const shippingCost = toInt(r.shippingCost ?? "") ?? 0;
    if (Number.isNaN(shippingCost)) msgs.push("自社発送の送料が数値ではありません");
    const packagingCost = toInt(r.packagingCost ?? "") ?? 0;
    if (Number.isNaN(packagingCost)) msgs.push("梱包資材費が数値ではありません");
    const targetMargin = toInt(r.targetMargin ?? "");
    if (Number.isNaN(targetMargin)) msgs.push("目標粗利率が数値ではありません");
    const stockAlertDays = toInt(r.stockAlertDays ?? "");
    if (Number.isNaN(stockAlertDays)) msgs.push("在庫アラート日数が数値ではありません");

    let effectiveFrom = today;
    if (r.effectiveFrom) {
      const d = toDate(r.effectiveFrom);
      if (!d) msgs.push("原価の適用開始日は YYYY-MM-DD の形式で入れてください");
      else effectiveFrom = d;
    }

    const amazonFulfillment = r.amazonFulfillment ? FULFILLMENT[r.amazonFulfillment.toLowerCase()] : null;
    if (r.amazonFulfillment && !amazonFulfillment) msgs.push(`Amazon 発送方法「${r.amazonFulfillment}」は選べません`);
    const rakutenFulfillment = r.rakutenFulfillment ? FULFILLMENT[r.rakutenFulfillment.toLowerCase()] : null;
    if (r.rakutenFulfillment && !rakutenFulfillment) msgs.push(`楽天 発送方法「${r.rakutenFulfillment}」は選べません`);

    const adPolicy = r.adPolicy ? AD_POLICY[r.adPolicy] : "profit";
    if (r.adPolicy && !adPolicy) msgs.push(`広告方針「${r.adPolicy}」は選べません`);
    const status = r.status ? STATUS[r.status] : "active";
    if (r.status && !status) msgs.push(`状態「${r.status}」は選べません`);

    if (r.jan && !/^\d{8}$|^\d{13}$/.test(r.jan)) msgs.push("JANコードは8桁か13桁の数字です");

    if (msgs.length) {
      errors.push({ line: i + 1, sku: r.sku || "(SKU未入力)", messages: msgs });
      continue;
    }

    rows.push({
      line: i + 1,
      caseName: r.caseName,
      sku: r.sku,
      name: r.name,
      jan: r.jan || null,
      amazonSku: r.amazonSku || null,
      asin: r.asin || null,
      amazonFulfillment,
      rakutenId: r.rakutenId || null,
      rakutenFulfillment,
      unitCost,
      effectiveFrom,
      shippingCost,
      packagingCost,
      targetMargin,
      adPolicy: adPolicy || "profit",
      stockAlertDays,
      status: status || "active",
    });
  }

  // 同じ案件のなかで自社SKUが重複していないか
  const seen = new Map<string, number>();
  for (const row of rows) {
    const key = `${row.caseName}\u0000${row.sku}`;
    const prev = seen.get(key);
    if (prev !== undefined) {
      errors.push({
        line: row.line,
        sku: row.sku,
        messages: [`自社SKUが ${prev} 行目と重複しています`],
      });
    } else {
      seen.set(key, row.line);
    }
  }
  const dupLines = new Set(errors.map((e) => e.line));
  const clean = rows.filter((r) => !dupLines.has(r.line));

  return { rows: clean, errors, skipped };
}

export async function importProducts(
  db: D1Database,
  rows: ParsedProduct[],
  actor: string | null
): Promise<{ cases: number; products: number; listings: number; costs: number }> {
  const counts = { cases: 0, products: 0, listings: 0, costs: 0 };

  // 案件（無ければ作る）
  const caseIds = new Map<string, string>();
  for (const name of new Set(rows.map((r) => r.caseName))) {
    const found = await db.prepare("SELECT id FROM cases WHERE name = ?").bind(name).first<{ id: string }>();
    if (found) {
      caseIds.set(name, found.id);
    } else {
      const id = crypto.randomUUID();
      await db.prepare("INSERT INTO cases (id, name) VALUES (?, ?)").bind(id, name).run();
      caseIds.set(name, id);
      counts.cases++;
    }
  }

  for (const r of rows) {
    const caseId = caseIds.get(r.caseName)!;

    const existing = await db
      .prepare("SELECT id FROM products WHERE case_id = ? AND sku = ?")
      .bind(caseId, r.sku)
      .first<{ id: string }>();

    const productId = existing?.id ?? crypto.randomUUID();
    if (existing) {
      await db
        .prepare("UPDATE products SET name = ?, jan = ?, ad_policy = ?, status = ? WHERE id = ?")
        .bind(r.name, r.jan, r.adPolicy, r.status, productId)
        .run();
    } else {
      await db
        .prepare("INSERT INTO products (id, case_id, sku, name, jan, ad_policy, status) VALUES (?,?,?,?,?,?,?)")
        .bind(productId, caseId, r.sku, r.name, r.jan, r.adPolicy, r.status)
        .run();
      counts.products++;
    }

    const listings: Array<[string, string | null, string | null, string | null]> = [
      ["amazon", r.amazonSku, r.asin, r.amazonFulfillment],
      ["rakuten", r.rakutenId, null, r.rakutenFulfillment],
    ];
    for (const [mall, externalId, asin, fulfillment] of listings) {
      if (!externalId) continue;
      await db
        .prepare(
          `INSERT INTO product_listings (id, product_id, mall, external_id, asin, fulfillment)
           VALUES (?,?,?,?,?,?)
           ON CONFLICT(mall, external_id)
           DO UPDATE SET product_id = excluded.product_id, asin = excluded.asin, fulfillment = excluded.fulfillment`
        )
        .bind(crypto.randomUUID(), productId, mall, externalId, asin, fulfillment)
        .run();
      counts.listings++;
    }

    if (r.unitCost !== null) {
      await db
        .prepare(
          `INSERT INTO cost_history (id, product_id, effective_from, unit_cost, shipping_cost, packaging_cost)
           VALUES (?,?,?,?,?,?)
           ON CONFLICT(product_id, effective_from)
           DO UPDATE SET unit_cost = excluded.unit_cost, shipping_cost = excluded.shipping_cost, packaging_cost = excluded.packaging_cost`
        )
        .bind(crypto.randomUUID(), productId, r.effectiveFrom, r.unitCost, r.shippingCost, r.packagingCost)
        .run();
      counts.costs++;
    }

    // 商品ごとの上書き設定（空欄なら上位の階層を継承するので、行を作らない）
    const overrides: Array<[string, unknown]> = [];
    if (r.targetMargin !== null) overrides.push(["target_margin", r.targetMargin]);
    if (r.stockAlertDays !== null) overrides.push(["stock_alert_days", r.stockAlertDays]);
    for (const [key, value] of overrides) {
      await db
        .prepare(
          `INSERT INTO settings (scope, scope_id, key, value, updated_by)
           VALUES ('listing', ?, ?, ?, ?)
           ON CONFLICT(scope, scope_id, key)
           DO UPDATE SET value = excluded.value, updated_at = datetime('now'), updated_by = excluded.updated_by`
        )
        .bind(productId, key, JSON.stringify(value), actor)
        .run();
    }
  }

  return counts;
}
