/**
 * 広告レポートCSVの取り込み
 *
 * モールごとに書式がばらばらなので、ここで吸収する。
 *   - 文字コード：楽天は Shift-JIS、Amazon は UTF-8（BOMつき）
 *   - 楽天は見出しの前に説明文が6〜8行入る
 *   - 列は位置ではなく見出し名で対応づける（版によって並びが変わるため）
 *   - 日付の書き方が3種類ある
 *
 * 楽天は「12時間」と「720時間」の2通りの売上が入るので 720時間（約30日）を、
 * 「合計／新規／既存」のうち合計を採用する。新規は比率を見るために別に持つ。
 */

export type AdLevel = "campaign" | "product" | "keyword" | "placement";

export interface AdRow {
  date: string;
  level: AdLevel;
  campaign: string;
  adGroup: string;
  keyword: string;
  matchType: string;
  externalId: string;        // 商品管理番号 / SKU
  /** 楽天はインプレッションを返さないので、クリック数とCTRから逆算する。求まらなければ null */
  impressions: number | null;
  clicks: number;
  cost: number;
  orders: number;
  sales: number;
  bid: number | null;
  suggestedCpc: number | null;
  newClicks: number | null;
  newSales: number | null;
  adType?: string | null;          // sp | sb | sd | rpp
  portfolio?: string | null;
  budget?: number | null;
  budgetCoverage?: number | null;  // 予算内に収まっていた時間の割合（%）
  attributionDays?: number | null;
}

/** 検索用語レポートの1行。顧客が実際に打った検索語ごとの実績 */
export interface SearchTermRow {
  date: string;
  adType: string;                  // sp | sb
  campaign: string;
  adGroup: string;
  targeting: string;
  matchType: string;
  searchTerm: string;
  portfolio: string | null;
  impressions: number | null;
  clicks: number;
  cost: number;
  orders: number;
  sales: number;
  impRank: number | null;
  impShare: number | null;
  attributionDays: number;
}

export interface ParsedAdFile {
  ok: boolean;
  mall: "rakuten" | "amazon";
  /** ads = daily_ads に入るもの／search_terms = 検索用語 */
  kind: "ads" | "search_terms";
  level: AdLevel;
  /** 画面に出す種類名 */
  label: string;
  periodStart: string;
  periodEnd: string;
  rows: AdRow[];
  terms: SearchTermRow[];
  message: string;
}

/* ───────── 文字コードと CSV ───────── */

/** UTF-8 として読めなければ Shift-JIS として読み直す */
export function decodeCsv(bytes: ArrayBuffer): string {
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
    return text.replace(/^﻿/, "");
  } catch {
    return new TextDecoder("shift_jis").decode(bytes);
  }
}

/** 引用符つきCSVを行の配列にする */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (c === ",") { row.push(field); field = ""; continue; }
    if (c === "\r") continue;
    // 楽天のファイルには改行として NEL(U+0085) が混ざることがある
    if (c === "\n" || c === "\u0085") {
      row.push(field); field = "";
      rows.push(row); row = [];
      continue;
    }
    field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((v) => v.trim() !== ""));
}

/* ───────── 値の正規化 ───────── */

const toInt = (v: string | undefined): number => {
  if (!v) return 0;
  const n = Number(String(v).replace(/[,¥円\s%]/g, ""));
  return Number.isFinite(n) ? Math.round(n) : 0;
};
const toNum = (v: string | undefined): number | null => {
  if (!v || !v.trim()) return null;
  const n = Number(String(v).replace(/[,¥円\s%]/g, ""));
  return Number.isFinite(n) ? n : null;
};

/**
 * 日付を1日に定める。
 * 2026年09月01日 ／ 2026年11月01日～2026年11月01日 は取れる。
 * 2026年09月（月まとめ）や、始まりと終わりが違う範囲は取れない
 */
export function singleDate(raw: string | undefined): string | null {
  if (!raw) return null;
  const parts = raw.split(/[～~]/).map((p) => p.trim()).filter(Boolean);
  const one = (s: string): string | null => {
    const m = s.match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})\D*$/);
    if (!m) return null;
    return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  };
  if (parts.length === 1) return one(parts[0]);
  const a = one(parts[0]), b = one(parts[1]);
  return a && b && a === b ? a : null;
}

/** 「集計期間: 全期間で集計 2026-11-01 - 2026-11-01」から期間を取り出す */
function periodOf(lines: string[]): { start: string; end: string } | null {
  for (const l of lines.slice(0, 10)) {
    const m = l.match(/集計期間[^0-9]*(\d{4}-\d{2}-\d{2})\s*-\s*(\d{4}-\d{2}-\d{2})/);
    if (m) return { start: m[1], end: m[2] };
    const mm = l.match(/集計期間[^0-9]*(\d{4}-\d{2})\s*-\s*(\d{4}-\d{2})/);
    if (mm) return { start: `${mm[1]}-01`, end: `${mm[2]}-31` };
  }
  return null;
}

function levelOf(lines: string[]): AdLevel | null {
  for (const l of lines.slice(0, 10)) {
    if (l.includes("集計単位")) {
      if (l.includes("キャンペーン")) return "campaign";
      if (l.includes("商品")) return "product";
      if (l.includes("キーワード")) return "keyword";
    }
  }
  return null;
}

/* ───────── 楽天 RPP ───────── */

/**
 * 見出し名でひく。空欄は「無い」とみなして次の候補へ進む。
 * 楽天のレポートは、設定していない項目を空文字で返してくるため
 */
function pick(row: Record<string, string>, ...names: string[]): string | undefined {
  for (const n of names) {
    const v = row[n];
    if (v !== undefined && v.trim() !== "") return v;
  }
  return undefined;
}

export function parseRakutenRpp(text: string): ParsedAdFile {
  const lines = text.split(/\r?\n|\u0085/);
  const level = levelOf(lines);
  const period = periodOf(lines);
  const headerIdx = lines.findIndex((l) => l.includes("コントロールカラム") || /^"?日付"?,/.test(l));

  if (!level || headerIdx < 0) {
    return { ok: false, mall: "rakuten", kind: "ads", level: "campaign", label: "楽天RPP",
      periodStart: "", periodEnd: "", rows: [], terms: [],
      message: "楽天RPPのレポートとして読めませんでした（集計単位または見出し行が見つかりません）" };
  }

  const table = parseCsv(lines.slice(headerIdx).join("\n"));
  const header = table[0].map((h) => h.trim());
  const rows: AdRow[] = [];
  let undated = 0;

  for (const r of table.slice(1)) {
    const o: Record<string, string> = {};
    header.forEach((h, i) => { o[h] = (r[i] ?? "").trim(); });

    // 日付は行の値を優先し、無理なら期間が1日のときだけそれを使う
    const date = singleDate(o["日付"]) ?? (period && period.start === period.end ? period.start : null);
    if (!date) { undated++; continue; }

    const clicks = toInt(pick(o, "クリック数(合計)", "クリック数(累計)"));
    const ctr = toNum(pick(o, "CTR(%)"));
    // 楽天はインプレッションを返さないので、クリック数とCTRから逆算する。
    // CTRは小数2桁までしかないので、0.00 と出る低CTRの行は求められない（0ではなく不明）
    const impressions = ctr && ctr > 0 ? Math.round((clicks / ctr) * 100) : null;

    const externalId = pick(o, "商品管理番号") ?? "";
    const keyword = (pick(o, "キーワード") ?? "").trim();
    const campaign = (pick(o, "キャンペーン名") ?? "").trim();

    rows.push({
      date, level,
      campaign: level === "campaign" ? campaign : "",
      adGroup: "",
      keyword: level === "keyword" ? keyword : "",
      matchType: "",
      externalId,
      impressions,
      clicks,
      cost: toInt(pick(o, "実績額(合計)", "実績額(累計)")),
      orders: toInt(pick(o, "売上件数(合計720時間)")),
      sales: toInt(pick(o, "売上金額(合計720時間)")),
      bid: toNum(pick(o, "キーワードCPC", "商品CPC", "入札単価")),
      suggestedCpc: toNum(pick(o, "目安CPC")),
      newClicks: toNum(pick(o, "クリック数(新規)")),
      newSales: toNum(pick(o, "売上金額(新規720時間)")),
      adType: "rpp",
      attributionDays: 30,           // 720時間
    });
  }

  if (!rows.length) {
    return { ok: false, mall: "rakuten", kind: "ads", level, label: `楽天RPP ${levelLabel(level)}`,
      periodStart: period?.start ?? "", periodEnd: period?.end ?? "",
      rows: [], terms: [], message: undated
        ? `日付を1日に定められませんでした（${undated}行）。月ごと集計のファイルは取り込めません。日ごと、または1日ぶんで出し直してください`
        : "データ行がありませんでした" };
  }

  const dates = [...new Set(rows.map((r) => r.date))].sort();
  return {
    ok: true, mall: "rakuten", kind: "ads", level, label: `楽天RPP ${levelLabel(level)}`,
    periodStart: dates[0], periodEnd: dates[dates.length - 1], rows, terms: [],
    message: `${rows.length}行（${dates.length}日分）`,
  };
}

/* ───────── 入口 ───────── */

const LEVEL_JA: Record<AdLevel, string> = {
  campaign: "キャンペーン別", product: "商品別", keyword: "キーワード別", placement: "掲載枠別",
};
export const levelLabel = (l: AdLevel) => LEVEL_JA[l] ?? l;

/* ───────── Amazon ───────── */

const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

/**
 * Amazon の日付。レポートの種類で書き方が違う
 *   Sep 01, 2026 ／ 1-Sep-26 ／ 2026-09-01 ／ 2026/09/01
 */
export function amazonDate(raw: string | undefined): string | null {
  const s = (raw ?? "").trim();
  let m = s.match(/^([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s*(\d{4})$/);
  if (m && MONTHS[m[1].toLowerCase()]) {
    return `${m[3]}-${MONTHS[m[1].toLowerCase()]}-${m[2].padStart(2, "0")}`;
  }
  m = s.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/);
  if (m && MONTHS[m[2].toLowerCase()]) {
    const y = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${y}-${MONTHS[m[2].toLowerCase()]}-${m[1].padStart(2, "0")}`;
  }
  m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  return null;
}

/** 「スポンサープロダクト広告」→ sp など */
function adTypeOf(v: string | undefined, fallback: string): string {
  const s = v ?? "";
  if (s.includes("プロダクト") || /products?/i.test(s)) return "sp";
  if (s.includes("ブランド") || /brands?/i.test(s)) return "sb";
  if (s.includes("ディスプレイ") || /display/i.test(s)) return "sd";
  return fallback;
}

/** 見出しから帰属期間（日）を読む。「7日間」「14日間」 */
function attributionOf(header: string[]): number {
  const h = header.join(" ");
  const m = h.match(/(\d+)日間/);
  return m ? Number(m[1]) : 7;
}

function emptyResult(label: string, message: string): ParsedAdFile {
  return {
    ok: false, mall: "amazon", kind: "ads", level: "campaign", label,
    periodStart: "", periodEnd: "", rows: [], terms: [], message,
  };
}

export function parseAmazonAds(text: string): ParsedAdFile {
  const table = parseCsv(text);
  if (table.length < 2) return emptyResult("Amazon広告", "データ行がありませんでした");

  const header = table[0].map((h) => h.trim());
  const has = (name: string) => header.some((h) => h.includes(name));
  const attribution = attributionOf(header);

  const records = table.slice(1).map((r) => {
    const o: Record<string, string> = {};
    header.forEach((h, i) => { o[h] = (r[i] ?? "").trim(); });
    return o;
  });

  // 7日間／14日間で列名が変わるので、「日間の…注文」「日間の…売上」で探す
  const findCol = (re: RegExp) => header.find((h) => re.test(h));
  const ordersCol = findCol(/日間の.*注文/);
  const salesCol = findCol(/日間の(総売上|.*売上高)/) ?? findCol(/日間の総売上/);
  const clicksOf = (o: Record<string, string>) => toInt(pick(o, "クリック数", "クリック"));
  const costOf = (o: Record<string, string>) => toInt(pick(o, "広告費", "費用"));
  const impOf = (o: Record<string, string>) => {
    const v = pick(o, "インプレッション");
    return v === undefined ? null : toInt(v);
  };

  /* 検索用語レポート */
  if (has("カスタマーの検索キーワード")) {
    const adType = attribution === 14 ? "sb" : "sp";
    const label = `Amazon ${adType.toUpperCase()} 検索用語`;
    const terms: SearchTermRow[] = [];
    let undated = 0;
    for (const o of records) {
      const date = amazonDate(o["日付"]);
      if (!date) { undated++; continue; }
      const term = pick(o, "カスタマーの検索キーワード");
      if (!term) continue;
      terms.push({
        date, adType,
        campaign: pick(o, "キャンペーン名") ?? "",
        adGroup: pick(o, "広告グループ名") ?? "",
        targeting: pick(o, "ターゲティング") ?? "",
        matchType: pick(o, "マッチタイプ") ?? "",
        searchTerm: term,
        portfolio: pick(o, "ポートフォリオ名") ?? null,
        impressions: impOf(o),
        clicks: clicksOf(o),
        cost: costOf(o),
        orders: ordersCol ? toInt(o[ordersCol]) : 0,
        sales: salesCol ? toInt(o[salesCol]) : 0,
        impRank: toNum(pick(o, "検索用語のインプレッションランク")),
        impShare: toNum(pick(o, "検索用語のインプレッションシェア")),
        attributionDays: attribution,
      });
    }
    if (!terms.length) {
      return emptyResult(label, undated ? `日付を読み取れませんでした（${undated}行）` : "データ行がありませんでした");
    }
    const dates = [...new Set(terms.map((t) => t.date))].sort();
    return {
      ok: true, mall: "amazon", kind: "search_terms", level: "keyword", label,
      periodStart: dates[0], periodEnd: dates[dates.length - 1], rows: [], terms,
      message: `${terms.length}行（${dates.length}日分）`,
    };
  }

  /* 購入商品レポート（ハロー効果）。今は扱わない */
  if (has("購入されたASIN")) {
    return emptyResult("Amazon 購入商品", "購入商品レポートはまだ取り込みに対応していません（優先度が低いため後回しにしています）");
  }

  /* 掲載枠レポート */
  if (has("広告枠")) {
    return buildAds(records, "placement", "Amazon 掲載枠別", attribution, (o) => ({
      campaign: pick(o, "キャンペーン名") ?? "",
      adGroup: pick(o, "広告枠（掲載位置）", "広告枠") ?? "",
      externalId: "",
    }));
  }

  /* 広告された商品レポート（SKU別の広告費。商品別の粗利に必要） */
  if (has("広告されたSKU") || has("広告SKU") || (has("SKU") && !has("購入された"))) {
    return buildAds(records, "product", "Amazon 商品別", attribution, (o) => ({
      campaign: pick(o, "キャンペーン名") ?? "",
      adGroup: pick(o, "広告グループ名") ?? "",
      externalId: pick(o, "広告されたSKU", "広告SKU", "宣伝SKU", "SKU") ?? "",
    }));
  }

  /* キャンペーンレポート */
  if (has("キャンペーン名") && (has("キャンペーンの種類") || has("予算"))) {
    return buildAds(records, "campaign", "Amazon キャンペーン別", attribution, (o) => ({
      campaign: pick(o, "キャンペーン名") ?? "",
      adGroup: "",
      externalId: "",
    }));
  }

  return emptyResult("Amazon広告", "どの種類のレポートか判定できませんでした（キャンペーン・検索用語・掲載枠・広告された商品に対応しています）");

  function buildAds(
    recs: Record<string, string>[],
    level: AdLevel,
    label: string,
    attr: number,
    keyOf: (o: Record<string, string>) => { campaign: string; adGroup: string; externalId: string }
  ): ParsedAdFile {
    const rows: AdRow[] = [];
    let undated = 0;
    for (const o of recs) {
      const date = amazonDate(o["日付"]);
      if (!date) { undated++; continue; }
      const k = keyOf(o);
      rows.push({
        date, level,
        campaign: k.campaign, adGroup: k.adGroup, keyword: "", matchType: "",
        externalId: k.externalId,
        impressions: impOf(o),
        clicks: clicksOf(o),
        cost: costOf(o),
        orders: ordersCol ? toInt(o[ordersCol]) : 0,
        sales: salesCol ? toInt(o[salesCol]) : 0,
        bid: null, suggestedCpc: null, newClicks: null, newSales: null,
        adType: adTypeOf(pick(o, "キャンペーンの種類"), "sp"),
        portfolio: pick(o, "ポートフォリオ名") ?? null,
        budget: toNum(pick(o, "予算")),
        budgetCoverage: toNum(pick(o, "予算内に収まっていた平均時間")),
        attributionDays: attr,
      });
    }
    if (!rows.length) {
      return emptyResult(label, undated ? `日付を読み取れませんでした（${undated}行）` : "データ行がありませんでした");
    }
    const dates = [...new Set(rows.map((r) => r.date))].sort();
    return {
      ok: true, mall: "amazon", kind: "ads", level, label,
      periodStart: dates[0], periodEnd: dates[dates.length - 1], rows, terms: [],
      message: `${rows.length}行（${dates.length}日分）`,
    };
  }
}

/* ───────── 入口 ───────── */

/** 中身を見てモールと種類を判定する */
export function parseAdFile(text: string): ParsedAdFile {
  if (text.includes("集計単位") || text.includes("コントロールカラム")) return parseRakutenRpp(text);
  // Excel のまま渡されたとき（中身が ZIP）
  if (text.startsWith("PK")) {
    return emptyResult("Amazon広告", "Excel形式（.xlsx）は読めません。Amazon広告の画面で CSV を選んで出し直してください");
  }
  return parseAmazonAds(text);
}
