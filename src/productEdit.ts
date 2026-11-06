/**
 * 商品マスタを画面から1件ずつ追加・編集・削除する／スプレッドシート用に書き出す
 *
 * 検証はスプレッドシートの取り込みと同じ関数（validateProductRow）を通す。どちらから入れても同じ決まりで弾くため。
 * 書き出しは取り込みと同じ列・同じ書き方にしてあるので、書き出したものをそのまま取り込み直せる。
 */

import { validateProductRow, importProducts, type Row, type ParsedProduct } from "./importProducts";
import { recalcFeeEst } from "./settings";

/** 取り込み用の見出し（この順番で書き出す） */
export const SHEET_COLUMNS: Array<[string, keyof Row | string]> = [
  ["案件", "caseName"], ["自社SKU", "sku"], ["商品名", "name"], ["JANコード", "jan"],
  ["Amazon SKU", "amazonSku"], ["ASIN", "asin"], ["Amazon発送方法", "amazonFulfillment"],
  ["楽天商品管理番号", "rakutenId"], ["楽天発送方法", "rakutenFulfillment"],
  ["仕入原価", "unitCost"], ["原価の適用開始日", "effectiveFrom"], ["自社発送の送料", "shippingCost"], ["梱包資材費", "packagingCost"],
  ["目標粗利率", "targetMargin"], ["広告方針", "adPolicy"], ["在庫アラート日数", "stockAlertDays"],
  ["楽天RSL物流費（暫定）", "rslFee"], ["状態", "status"],
];
const FUL_JA: Record<string, string> = { fba: "FBA", own: "自社発送", mcf: "マルチチャネル" };
const POLICY_JA: Record<string, string> = { profit: "利益重視", share: "シェア獲得", nurture: "育成中" };
const STATUS_JA: Record<string, string> = { active: "販売中", discontinued: "販売終了" };

const jst = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);

interface ProductRecord {
  id: string; caseId: string; caseName: string; sku: string; name: string; jan: string | null; adPolicy: string; status: string;
  amazonSku: string | null; asin: string | null; amazonFulfillment: string | null;
  rakutenId: string | null; rakutenFulfillment: string | null;
  cost: { effectiveFrom: string; unitCost: number | null; shippingCost: number; packagingCost: number; manual: boolean } | null;
  costHistory: Array<{ effectiveFrom: string; unitCost: number | null; shippingCost: number; packagingCost: number; manual: boolean }>;
  targetMargin: number | null; stockAlertDays: number | null; rslFee: number | null;
}

/** 商品をまとめて読む（caseId を渡すとその案件だけ） */
export async function readProducts(db: D1Database, opts: { caseId?: string | null; id?: string } = {}): Promise<ProductRecord[]> {
  const where = opts.id ? "p.id = ?" : opts.caseId ? "p.case_id = ?" : "1 = 1";
  const bind = opts.id ? [opts.id] : opts.caseId ? [opts.caseId] : [];
  const { results: ps } = await db.prepare(
    `SELECT p.*, c.name AS case_name FROM products p JOIN cases c ON c.id = p.case_id WHERE ${where} ORDER BY c.name, p.sku`
  ).bind(...bind).all<Record<string, string | null>>();
  if (!ps.length) return [];
  const ids = ps.map((p) => String(p.id));
  const marks = ids.map(() => "?").join(",");
  const { results: ls } = await db.prepare(`SELECT * FROM product_listings WHERE product_id IN (${marks})`).bind(...ids).all<Record<string, string | null>>();
  const { results: cs } = await db.prepare(
    `SELECT * FROM cost_history WHERE product_id IN (${marks}) ORDER BY effective_from DESC`
  ).bind(...ids).all<Record<string, string | number | null>>();
  const { results: ov } = await db.prepare(
    `SELECT scope_id, key, value FROM settings WHERE scope = 'listing' AND scope_id IN (${marks})`
  ).bind(...ids).all<{ scope_id: string; key: string; value: string }>();

  return ps.map((p) => {
    const id = String(p.id);
    const a = ls.find((l) => l.product_id === id && l.mall === "amazon");
    const r = ls.find((l) => l.product_id === id && l.mall === "rakuten");
    const hist = cs.filter((c) => c.product_id === id).map((c) => ({
      effectiveFrom: String(c.effective_from), unitCost: c.unit_cost == null ? null : Number(c.unit_cost),
      shippingCost: Number(c.shipping_cost ?? 0), packagingCost: Number(c.packaging_cost ?? 0), manual: Number(c.needs_manual) === 1,
    }));
    const o = (k: string) => { const x = ov.find((v) => v.scope_id === id && v.key === k); return x ? Number(JSON.parse(x.value)) : null; };
    return {
      id, caseId: String(p.case_id), caseName: String(p.case_name), sku: String(p.sku), name: String(p.name),
      jan: p.jan, adPolicy: String(p.ad_policy ?? "profit"), status: String(p.status),
      amazonSku: a?.external_id ?? null, asin: a?.asin ?? null, amazonFulfillment: a?.fulfillment ?? null,
      rakutenId: r?.external_id ?? null, rakutenFulfillment: r?.fulfillment ?? null,
      cost: hist[0] ?? null, costHistory: hist, targetMargin: o("target_margin"), stockAlertDays: o("stock_alert_days"), rslFee: o("rsl_fee"),
    };
  });
}

/** スプレッドシートに貼れるタブ区切り（見出しつき） */
export async function exportSheet(db: D1Database, caseId: string | null): Promise<{ text: string; rows: number }> {
  const list = await readProducts(db, { caseId });
  const cell = (v: unknown) => String(v ?? "").replace(/[\t\r\n]+/g, " ");
  const lines = [SHEET_COLUMNS.map(([h]) => h).join("\t")];
  for (const p of list) {
    const v: Record<string, unknown> = {
      caseName: p.caseName, sku: p.sku, name: p.name, jan: p.jan,
      amazonSku: p.amazonSku, asin: p.asin, amazonFulfillment: p.amazonFulfillment ? FUL_JA[p.amazonFulfillment] : "",
      rakutenId: p.rakutenId, rakutenFulfillment: p.rakutenFulfillment ? FUL_JA[p.rakutenFulfillment] : "",
      // 要手計算は取り込みと同じ「?」で書き出す（0 にすると粗利の計算に入ってしまう）
      unitCost: p.cost ? (p.cost.manual ? "?" : p.cost.unitCost) : "",
      effectiveFrom: p.cost?.effectiveFrom ?? "", shippingCost: p.cost?.shippingCost || "", packagingCost: p.cost?.packagingCost || "",
      targetMargin: p.targetMargin, adPolicy: POLICY_JA[p.adPolicy] ?? "", stockAlertDays: p.stockAlertDays, rslFee: p.rslFee, status: STATUS_JA[p.status] ?? "",
    };
    lines.push(SHEET_COLUMNS.map(([, k]) => cell(v[k as string])).join("\t"));
  }
  return { text: lines.join("\n"), rows: list.length };
}

/**
 * 1件を保存する（追加／編集）。
 * 編集で自社SKUを変えたときは同じ商品のまま SKU を付け替える（売上の履歴を引き継ぐため）。
 * 原価は値が変わったときだけ、適用開始日つきで履歴に積む。
 */
export async function saveProduct(
  db: D1Database, input: Record<string, string> & { id?: string; caseId?: string }, actor: string | null,
): Promise<{ id: string; errors?: string[] }> {
  if (!input.caseId) return { id: "", errors: ["案件を選んでください"] };
  const c = await db.prepare("SELECT name FROM cases WHERE id = ?").bind(input.caseId).first<{ name: string }>();
  if (!c) return { id: "", errors: ["案件が見つかりません"] };

  const row: Row = { ...input, caseName: c.name };
  delete row.id; delete row.caseId;
  const v = validateProductRow(row, 1, jst());
  if ("messages" in v) return { id: "", errors: v.messages };

  // 同じ案件で同じ SKU の別商品がないか
  const dup = await db.prepare("SELECT id FROM products WHERE case_id = ? AND sku = ?").bind(input.caseId, v.sku).first<{ id: string }>();
  if (dup && dup.id !== input.id) return { id: "", errors: [`自社SKU「${v.sku}」はこの案件にすでにあります`] };
  // 出品番号が他の商品に使われていないか（取り込みのほうは付け替えるが、画面からは気づけるよう止める）
  for (const [mall, ext] of [["amazon", v.amazonSku], ["rakuten", v.rakutenId]] as const) {
    if (!ext) continue;
    const used = await db.prepare(
      `SELECT p.sku, c.name AS case_name FROM product_listings l JOIN products p ON p.id = l.product_id JOIN cases c ON c.id = p.case_id
        WHERE l.mall = ? AND l.external_id = ? AND l.product_id <> ?`
    ).bind(mall, ext, input.id ?? "").first<{ sku: string; case_name: string }>();
    if (used) return { id: "", errors: [`${mall === "amazon" ? "Amazon SKU" : "楽天商品管理番号"}「${ext}」は ${used.case_name} の ${used.sku} で使われています`] };
  }

  let before: ProductRecord | undefined;
  if (input.id) {
    before = (await readProducts(db, { id: input.id }))[0];
    if (!before) return { id: "", errors: ["商品が見つかりません"] };
    if (before.sku !== v.sku) await db.prepare("UPDATE products SET sku = ? WHERE id = ?").bind(v.sku, input.id).run();
  }

  // 原価が変わっていなければ履歴を積まない（毎回同じ値の行が増えないように）
  const cur = before?.cost;
  const costChanged = !cur || cur.manual !== v.costManual || cur.unitCost !== v.unitCost
    || cur.shippingCost !== v.shippingCost || cur.packagingCost !== v.packagingCost || (input.effectiveFrom && cur.effectiveFrom !== v.effectiveFrom);
  const p: ParsedProduct = costChanged ? v : { ...v, unitCost: null, costManual: false };
  await importProducts(db, [p], actor);

  const id = input.id ?? (await db.prepare("SELECT id FROM products WHERE case_id = ? AND sku = ?").bind(input.caseId, v.sku).first<{ id: string }>())!.id;

  // 出品番号を消した・変えたときは古い紐づけを外す
  for (const [mall, ext] of [["amazon", v.amazonSku], ["rakuten", v.rakutenId]] as const) {
    await db.prepare("DELETE FROM product_listings WHERE product_id = ? AND mall = ? AND external_id IS NOT ?").bind(id, mall, ext).run();
  }
  // 空欄にした上書き設定は消す（上の階層を継承に戻す）
  if (v.targetMargin === null) await db.prepare("DELETE FROM settings WHERE scope = 'listing' AND scope_id = ? AND key = 'target_margin'").bind(id).run();
  if (v.stockAlertDays === null) await db.prepare("DELETE FROM settings WHERE scope = 'listing' AND scope_id = ? AND key = 'stock_alert_days'").bind(id).run();
  if (v.rslFee === null) {
    await db.prepare("DELETE FROM settings WHERE scope = 'listing' AND scope_id = ? AND key = 'rsl_fee'").bind(id).run();
    await recalcFeeEst(db, input.caseId, "rakuten");
  }
  return { id };
}

/**
 * 削除。売上・広告・在庫のデータがある商品は消さずに断る（過去の数字が説明できなくなるため）。
 * その場合は「販売終了」にすれば一覧や判定から外れる
 */
export async function deleteProduct(db: D1Database, id: string): Promise<void> {
  const used = await db.prepare(
    `SELECT (SELECT COUNT(*) FROM daily_sales WHERE product_id = ?1) + (SELECT COUNT(*) FROM daily_ads WHERE product_id = ?1)
          + (SELECT COUNT(*) FROM daily_inventory WHERE product_id = ?1) AS n`
  ).bind(id).first<{ n: number }>();
  if (Number(used?.n ?? 0) > 0) {
    throw new Error("この商品には売上・広告・在庫のデータがあるため削除できません。「販売終了」にすると一覧や在庫の判定から外れます");
  }
  await db.batch([
    db.prepare("DELETE FROM product_listings WHERE product_id = ?").bind(id),
    db.prepare("DELETE FROM cost_history WHERE product_id = ?").bind(id),
    db.prepare("DELETE FROM settings WHERE scope = 'listing' AND scope_id = ?").bind(id),
    db.prepare("DELETE FROM products WHERE id = ?").bind(id),
  ]);
}

export const PRODUCT_LABELS = { FUL_JA, POLICY_JA, STATUS_JA };
