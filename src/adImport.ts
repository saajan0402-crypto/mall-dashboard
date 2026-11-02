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

export type AdLevel = "campaign" | "product" | "keyword";

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
}

export interface ParsedAdFile {
  ok: boolean;
  mall: "rakuten" | "amazon";
  level: AdLevel;
  periodStart: string;
  periodEnd: string;
  rows: AdRow[];
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
    return { ok: false, mall: "rakuten", level: "campaign", periodStart: "", periodEnd: "", rows: [],
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
    });
  }

  if (!rows.length) {
    return { ok: false, mall: "rakuten", level, periodStart: period?.start ?? "", periodEnd: period?.end ?? "",
      rows: [], message: undated
        ? `日付を1日に定められませんでした（${undated}行）。月ごと集計のファイルは取り込めません。日ごと、または1日ぶんで出し直してください`
        : "データ行がありませんでした" };
  }

  const dates = [...new Set(rows.map((r) => r.date))].sort();
  return {
    ok: true, mall: "rakuten", level,
    periodStart: dates[0], periodEnd: dates[dates.length - 1], rows,
    message: `${rows.length}行（${dates.length}日分）`,
  };
}

/* ───────── 入口 ───────── */

const LEVEL_JA: Record<AdLevel, string> = {
  campaign: "キャンペーン別", product: "商品別", keyword: "キーワード別",
};
export const levelLabel = (l: AdLevel) => LEVEL_JA[l] ?? l;

/** 中身を見てモールと種類を判定する */
export function parseAdFile(text: string): ParsedAdFile {
  if (text.includes("集計単位") || text.includes("コントロールカラム")) return parseRakutenRpp(text);
  return {
    ok: false, mall: "amazon", level: "campaign", periodStart: "", periodEnd: "", rows: [],
    message: "まだ楽天RPPのレポートにのみ対応しています（Amazonの広告レポートは次に対応します）",
  };
}
