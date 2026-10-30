/**
 * SP-API のレポート取得
 *
 * レポートは「依頼 → 生成待ち → ダウンロード」の3段階で、生成に数分かかる。
 * 日次バッチの中で待ち続けるわけにはいかないので、
 *   1回目の実行で依頼して report_jobs に記録し、
 *   次の実行で取りに行く
 * という形にしている。画面から手で動かすときだけ、その場で少し待つ。
 */

import { spapi, errorMessage, JP_MARKETPLACE } from "./amazon";

/** 売上・トラフィックレポート。日次・SKU単位で、売上とセッション数が同時に取れる */
export const SALES_TRAFFIC = "GET_SALES_AND_TRAFFIC_REPORT";

export interface RequestResult {
  ok: boolean;
  reportId?: string;
  message: string;
}

/** 1日分のレポートを依頼する。SKU単位にするため1日1レポートで投げる */
export async function requestDailyReport(
  token: string,
  reportType: string,
  date: string
): Promise<RequestResult> {
  const r = await spapi(token, "/reports/2021-06-30/reports", {
    method: "POST",
    body: {
      reportType,
      marketplaceIds: [JP_MARKETPLACE],
      dataStartTime: date,
      dataEndTime: date,
      reportOptions: { dateGranularity: "DAY", asinGranularity: "SKU" },
    },
  });
  if (!r.ok) return { ok: false, message: `依頼に失敗：${errorMessage(r.body)}` };
  const reportId = (r.body as { reportId?: string }).reportId;
  if (!reportId) return { ok: false, message: "レポートIDが返りませんでした" };
  return { ok: true, reportId, message: "依頼しました" };
}

export type ReportState = "waiting" | "ready" | "empty" | "failed";

export interface ReportStatus {
  state: ReportState;
  documentId?: string;
  message: string;
}

/** 依頼したレポートの状態を見る */
export async function checkReport(token: string, reportId: string): Promise<ReportStatus> {
  const r = await spapi(token, `/reports/2021-06-30/reports/${reportId}`);
  if (!r.ok) return { state: "failed", message: errorMessage(r.body) };
  const b = r.body as { processingStatus?: string; reportDocumentId?: string };
  switch (b.processingStatus) {
    case "DONE":
      return { state: "ready", documentId: b.reportDocumentId, message: "生成できました" };
    case "IN_QUEUE":
    case "IN_PROGRESS":
      return { state: "waiting", message: "Amazon が生成中です" };
    case "CANCELLED":
      // 対象データがない日はキャンセル扱いで返ってくる
      return { state: "empty", message: "対象データがありませんでした" };
    default:
      return { state: "failed", message: `生成に失敗しました（${b.processingStatus ?? "不明"}）` };
  }
}

/** レポート本体を取ってくる。gzip で返ることがあるので展開する */
export async function downloadReport(token: string, documentId: string): Promise<{ ok: boolean; text?: string; message: string }> {
  const meta = await spapi(token, `/reports/2021-06-30/documents/${documentId}`);
  if (!meta.ok) return { ok: false, message: errorMessage(meta.body) };
  const m = meta.body as { url?: string; compressionAlgorithm?: string };
  if (!m.url) return { ok: false, message: "ダウンロードURLが返りませんでした" };

  const res = await fetch(m.url);
  if (!res.ok) return { ok: false, message: `ダウンロードに失敗：HTTP ${res.status}` };

  if (m.compressionAlgorithm === "GZIP" && res.body) {
    const stream = res.body.pipeThrough(new DecompressionStream("gzip"));
    return { ok: true, text: await new Response(stream).text(), message: "取得しました" };
  }
  return { ok: true, text: await res.text(), message: "取得しました" };
}

/* ───────── レポートの中身 ───────── */

interface Money {
  amount?: number;
  currencyCode?: string;
}

export interface SalesTrafficRow {
  sku: string;
  asin: string | null;
  units: number;
  revenue: number;
  sessions: number | null;
  pageViews: number | null;
}

/**
 * 売上・トラフィックレポート（JSON）を行に直す。
 * 金額は必ずここで整数の円に丸める。小数のまま持ち回らない
 */
export function parseSalesTraffic(text: string): { rows: SalesTrafficRow[]; note: string } {
  const data = JSON.parse(text) as {
    salesAndTrafficByAsin?: Array<{
      parentAsin?: string;
      childAsin?: string;
      sku?: string;
      salesByAsin?: { unitsOrdered?: number; orderedProductSales?: Money };
      trafficByAsin?: { sessions?: number; pageViews?: number };
    }>;
  };
  const list = data.salesAndTrafficByAsin ?? [];
  const rows: SalesTrafficRow[] = [];
  for (const e of list) {
    const sku = (e.sku ?? "").trim();
    if (!sku) continue;                              // SKUが無い行は照合できないので捨てる
    rows.push({
      sku,
      asin: e.childAsin ?? e.parentAsin ?? null,
      units: Math.round(e.salesByAsin?.unitsOrdered ?? 0),
      revenue: Math.round(e.salesByAsin?.orderedProductSales?.amount ?? 0),
      sessions: e.trafficByAsin?.sessions ?? null,
      pageViews: e.trafficByAsin?.pageViews ?? null,
    });
  }
  return { rows, note: `${list.length} 行のうち ${rows.length} 行にSKUがありました` };
}
