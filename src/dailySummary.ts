/**
 * 毎朝の日次サマリ（Slack）
 *
 * 前日の数字と、今月の累計、まだ手をつけていない「今週中」の要対応を案件ごとに送る。
 * 要対応は1日分だと判断材料が少ないので、直近14日の実績から出したものを使う。
 * 「対応済み」「今はしない」にしたものは送らない。
 */

import { buildCaseSummary, periodSummary, adTotals, jst } from "./caseSummary";
import { postSlack, summaryCases, type SlackEnv } from "./slack";

const yen = (v: number | null | undefined) => (v == null ? "—" : "¥" + Math.round(v).toLocaleString("ja-JP"));
const WD = ["日", "月", "火", "水", "木", "金", "土"];

export async function dailySummaryText(env: SlackEnv, caseId: string): Promise<string | null> {
  const y = await buildCaseSummary(env.DB, caseId, { preset: "yesterday" }, { trackTodos: false });
  if (!y) return null;
  const recent = await buildCaseSummary(env.DB, caseId, { preset: "last14" }, { trackTodos: false });
  const day = y.period.to;
  const monthStart = `${day.slice(0, 7)}-01`;
  const mtd = await periodSummary(env.DB, caseId, monthStart, day);
  const mtdAds = (await adTotals(env.DB, caseId, monthStart, day)).reduce((t, a) => t + a.cost, 0);
  const adCost = y.ads.totals.reduce((t, a) => t + a.cost, 0);
  const adSales = y.ads.totals.reduce((t, a) => t + a.sales, 0);
  const d = new Date(day + "T00:00:00Z");

  const L: string[] = [];
  L.push(`*${y.caseName}｜${d.getUTCMonth() + 1}/${d.getUTCDate()}（${WD[d.getUTCDay()]}）の日次サマリ*`);
  if (!y.sales.trend.length) {
    // 取り込みが遅れているときに「売上0円」と送ると誤解されるので、無いことをはっきり書く
    L.push(`売上：この日のデータがまだ取り込まれていません（取り込みの遅れ。連携ステータスで確認してください）`);
  } else {
    const chg = y.sales.changeRate == null ? "" : `　前日比 ${y.sales.changeRate >= 0 ? "+" : ""}${y.sales.changeRate}%`;
    L.push(`売上 *${yen(y.sales.total.revenue)}*（${y.sales.total.units}個）${chg}`);
    L.push(`粗利（広告費前・概算）${yen(y.pl.gross)}${y.pl.grossRate != null ? `（${y.pl.grossRate}%）` : ""}`);
  }
  // 楽天RPPは前日分が昼ごろに届くので、朝の時点では入っていないことが多い。Amazonだけの数字だと分かるようにする
  const rppPending = !y.ads.totals.some((a) => a.mall === "rakuten") && (await usesRppPush(env, caseId));
  if (y.ads.totals.length)
    L.push(`広告費 ${yen(adCost)}／ROAS ${adCost ? Math.round((adSales / adCost) * 100) / 100 : "—"}（損益分岐 ${recent?.pl.breakEvenRoas ?? "—"}）／TACoS ${y.ads.tacos ?? "—"}%` +
      (rppPending ? "（Amazonのみ）" : ""));
  if (rppPending) L.push("楽天RPPの前日分は昼ごろ届くため、この時点では入っていません");
  L.push(`今月累計：売上 ${yen(mtd.revenue)}／粗利 ${yen(mtd.gross)}／広告費 ${yen(mtdAds)}`);

  const inv = y.inventory;
  const outN = inv.filter((r) => r.level === "out").length, riskN = inv.filter((r) => r.level === "risk").length;
  if (outN || riskN) L.push(`在庫：在庫切れ ${outN}件・欠品間近 ${riskN}件`);

  const open = (recent?.todo ?? []).filter((t) => t.priority === "high" && (t.status ?? "open") === "open");
  if (open.length) {
    L.push("");
    L.push(`*今週中にやること（未対応 ${open.length}件）*`);
    for (const t of open.slice(0, 6)) L.push(`• ${t.text}`);
    if (open.length > 6) L.push(`…ほか ${open.length - 6}件はダッシュボードで`);
  }
  const stale = y.freshness.filter((f) => f.latest == null || (f.daysAgo ?? 0) > 3);
  if (stale.length) {
    L.push("");
    L.push(`:warning: データが止まっています：${stale.map((f) => `${f.label}（${f.latest ?? "未取り込み"}）`).join("、")}`);
  }
  return L.join("\n");
}

/** 直近14日に楽天RPPの自動送信が届いている案件か */
async function usesRppPush(env: SlackEnv, caseId: string): Promise<boolean> {
  const r = await env.DB.prepare(
    `SELECT 1 AS x FROM ingests WHERE case_id = ? AND kind = 'ads_push' AND created_at >= datetime('now', '-14 days') LIMIT 1`
  ).bind(caseId).first<{ x: number }>();
  return !!r;
}

/** 対象の案件すべてに送る */
export async function sendDailySummaries(env: SlackEnv, caseId?: string) {
  const ids = caseId ? [caseId] : await summaryCases(env);
  const out: Array<{ caseId: string; ok: boolean; message: string }> = [];
  for (const id of ids) {
    try {
      const text = await dailySummaryText(env, id);
      if (!text) { out.push({ caseId: id, ok: false, message: "案件が見つかりません" }); continue; }
      const r = await postSlack(env, id, text);
      out.push({ caseId: id, ok: r.ok, message: r.where === "company" ? `${r.message}（案件のチャンネルが未登録のため全体のチャンネルへ）` : r.message });
    } catch (e) {
      out.push({ caseId: id, ok: false, message: String(e instanceof Error ? e.message : e) });
    }
  }
  return out;
}

export { jst as summaryJst };
