/**
 * 案件の状況を文章にする（AIに読ませる用）
 *
 * 数字は caseSummary が確定させたものをそのまま書く。ここでは計算しない。
 * 「指示」ではなく「このデータの読み方」として前提を書く。
 * AIはウェブページに書かれた命令には従わない作りになっているので、
 * 依頼そのものはチャットに貼る依頼文（画面の「依頼文をコピー」）のほうに入れる。
 */

import type { CaseSummary, PeriodSummary, AdTotal } from "./caseSummary";

const yen = (v: number | null | undefined) => (v == null ? "—" : "¥" + Math.round(v).toLocaleString("ja-JP"));
const num = (v: number | null | undefined) => (v == null ? "—" : Math.round(v).toLocaleString("ja-JP"));
const pct = (v: number | null | undefined) => (v == null ? "—" : `${v}%`);
const MALL: Record<string, string> = { amazon: "Amazon", rakuten: "楽天" };
const TYPE: Record<string, string> = { sp: "スポンサープロダクト", sb: "スポンサーブランド", sd: "スポンサーディスプレイ", rpp: "RPP" };
const LEVEL: Record<string, string> = { campaign: "キャンペーン別", product: "商品別", keyword: "キーワード別" };
const PRI: Record<string, string> = { high: "今週中", mid: "余裕があれば", info: "把握" };

/** 表の中に | や改行が入ると崩れるので逃がす */
const cell = (v: unknown) => String(v ?? "—").replace(/\|/g, "／").replace(/\s+/g, " ").trim() || "—";
const table = (head: string[], rows: unknown[][]) =>
  rows.length
    ? [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.map(cell).join(" | ")} |`)].join("\n")
    : "（該当なし）";

function plTable(p: PeriodSummary): string {
  const rows = p.byMall.map((m) => [
    MALL[m.mall] ?? m.mall, num(m.units), yen(m.revenue), yen(m.cost), yen(m.fees),
    m.feesEst > 0 ? "概算を含む" : m.feesAllocated > 0 ? "請求明細から按分" : "実額",
    yen(m.returns + m.discounts), yen(m.gross),
    m.revenue - m.revenueWithoutCost > 0 ? `${Math.round((m.gross / (m.revenue - m.revenueWithoutCost)) * 1000) / 10}%` : "—",
    yen(m.revenueWithoutCost),
  ]);
  return table(["モール", "販売数", "売上", "原価", "手数料", "手数料の確度", "返品・値引き", "粗利（広告費前）", "粗利率", "うち原価不明の売上"], rows);
}

function adTable(list: AdTotal[]): string {
  return table(["モール", "集計した粒度", "広告費", "広告経由売上", "ROAS", "クリック", "注文", "帰属期間"],
    list.map((a) => [MALL[a.mall] ?? a.mall, LEVEL[a.level] ?? a.level, yen(a.cost), yen(a.sales), a.roas ?? "—",
      num(a.clicks), num(a.orders), a.attribution || "—"]));
}

export function renderCaseMarkdown(s: CaseSummary, opts: { url?: string } = {}): string {
  const be = s.last30.breakEvenRoas;
  const L: string[] = [];

  L.push(`# ${s.caseName}｜EC運用の状況レポート`);
  L.push("");
  L.push(`- 対象：${s.malls.map((m) => MALL[m] ?? m).join("・") || "（モール未接続）"}`);
  L.push(`- データの最終日：${s.asOf}（作成 ${s.generatedAt} JST）`);
  if (opts.url) L.push(`- このレポートのURL：${opts.url}（開くたびに最新のデータで作り直されます）`);
  L.push("");

  L.push("## このデータの読み方");
  L.push("");
  L.push("- 金額はすべて税込・円。社内の管理ツールがモールのAPIとCSVから集計した確定値で、ここで計算し直す必要はありません。");
  L.push("- **粗利（広告費前）＝ 売上 − 原価 − モール手数料 − 返品 − 値引き**。広告費はまだ引いていません。");
  L.push(`- **損益分岐ROAS ＝ 売上 ÷ 粗利（広告費前）**。直近30日では **${be ?? "—"}**。広告のROASがこれを下回ると、その広告は売れるほど赤字です。`);
  L.push(`- 目標の粗利率は ${s.settings.targetMargin}%、在庫アラートは残り ${s.settings.stockAlertDays} 日を基準にしています。`);
  L.push("- 広告の成果は帰属期間がモールごとに違います（楽天RPP 30日／Amazon スポンサープロダクト 7日／スポンサーブランド 14日）。**モールをまたいでROASをそのまま比べないでください。**楽天は直近の数字があとから伸びます。");
  if (s.malls.includes("rakuten"))
    L.push(`- 楽天の手数料は、請求明細を入れるまでは料率（${s.settings.rakutenFeeRate ?? "—"}%）からの概算です。${s.settings.rakutenFeeFromDefault ? "料率はまだ既定値のままで、実態とずれている可能性があります。" : ""}`);
  L.push("- 原価が分からない商品（「要手計算」＝買い方で原価が変わるもの、原価未登録）の売上は、**粗利・粗利率・損益分岐ROASの計算から除いています**。表の「うち原価不明の売上」がその金額です。");
  L.push("- 入札・予算の変更は担当者が手作業で行います。このツールはモールに書き込みません。打ち手は「どのキャンペーン／キーワードを、いくらからいくらへ」の形にすると、そのまま作業に移せます。");
  L.push("- 「—」はデータが無いことを表し、0とは区別しています。");
  L.push("");

  L.push("## 要点");
  L.push("");
  const sl = s.sales;
  L.push(`- 昨日（${sl.yesterday.date}）の売上：${yen(sl.yesterday.revenue)}（${num(sl.yesterday.units)}個）`);
  L.push(`- 直近7日：${yen(sl.last7.revenue)}（${num(sl.last7.units)}個）／前の7日 ${yen(sl.prev7.revenue)}／前週比 ${pct(sl.changeRate)}`);
  L.push(`- 今月（${s.monthToDate.from}〜${s.monthToDate.to}）：売上 ${yen(s.monthToDate.revenue)}／粗利（広告費前）${yen(s.monthToDate.gross)}／粗利率 ${pct(s.monthToDate.grossRate)}`);
  const ad30 = s.ads.last30.reduce((t, a) => t + a.cost, 0);
  L.push(`- 直近30日：売上 ${yen(s.last30.revenue)}／広告費 ${yen(ad30)}／広告費を引いた利益 ${yen(s.ads.profitAfterAds30)}`);
  L.push(`- TACoS（直近7日の広告費 ÷ 総売上）：${pct(s.ads.tacos7)}`);
  L.push("");

  L.push("## ツールが検出した要対応");
  L.push("");
  L.push("決まった基準（在庫日数・損益分岐ROAS・売上ゼロの広告など）で機械的に拾ったものです。優先順位の付け直しや、ここに無い論点の指摘は歓迎です。");
  L.push("");
  L.push(table(["優先度", "分野", "内容", "根拠"], s.todo.map((t) => [PRI[t.priority], t.area, t.text, t.basis ?? ""])));
  L.push("");

  L.push("## 損益（モール別）");
  L.push("");
  L.push(`### 今月（${s.monthToDate.from}〜${s.monthToDate.to}）`);
  L.push("");
  L.push(plTable(s.monthToDate));
  if (s.monthToDate.otherFees) L.push(`\n商品に紐づかない費用（月額登録料など）：${yen(s.monthToDate.otherFees)}（合計の粗利には反映済み）`);
  L.push("");
  L.push(`### 直近30日（${s.last30.from}〜${s.last30.to}）`);
  L.push("");
  L.push(plTable(s.last30));
  L.push("");

  L.push("## 日別の売上（直近30日）");
  L.push("");
  L.push(table(["日付", "売上", "販売数"], s.sales.trend.map((t) => [t.date, yen(t.revenue), num(t.units)])));
  L.push("");

  L.push("## 広告");
  L.push("");
  L.push("### 直近7日");
  L.push("");
  L.push(adTable(s.ads.last7));
  L.push("");
  L.push("### 直近30日");
  L.push("");
  L.push(adTable(s.ads.last30));
  L.push("");
  L.push("### キャンペーン別（直近30日・広告費の多い順）");
  L.push("");
  L.push(table(["モール", "種類", "キャンペーン", "広告費", "広告経由売上", "ROAS", "損益分岐を下回る", "予算内の時間"],
    s.ads.campaigns.map((c) => [MALL[c.mall] ?? c.mall, c.adType ? TYPE[c.adType] ?? c.adType : "—", c.name, yen(c.cost), yen(c.sales),
      c.roas ?? "—", c.belowBreakEven ? "はい" : "", c.budgetCoverage == null ? "—" : `${c.budgetCoverage}%`])));
  L.push("");
  L.push("### 売上ゼロの検索語（直近30日・広告費の多い順）");
  L.push("");
  L.push(table(["モール", "種類", "検索語", "広告費", "クリック", "インプレッションシェア"],
    s.ads.wastedTerms.map((w) => [MALL[w.mall] ?? w.mall, TYPE[w.adType] ?? w.adType, w.term, yen(w.cost), num(w.clicks), w.impShare == null ? "—" : `${w.impShare}%`])));
  L.push("");
  L.push("### 成果の出ている検索語（直近30日・注文2件以上・ROASの高い順）");
  L.push("");
  L.push(table(["モール", "種類", "検索語", "広告費", "広告経由売上", "ROAS", "注文"],
    s.ads.winningTerms.map((w) => [MALL[w.mall] ?? w.mall, TYPE[w.adType] ?? w.adType, w.term, yen(w.cost), yen(w.sales), w.roas, num(w.orders)])));
  L.push("");
  if (s.malls.includes("rakuten")) {
    L.push("### 楽天RPP 売上ゼロのキーワード（直近30日）");
    L.push("");
    L.push(table(["キーワード", "商品", "広告費", "クリック"], s.ads.wastedKeywords.map((w) => [w.term, w.product, yen(w.cost), num(w.clicks)])));
    L.push("");
  }

  L.push("## 商品別（直近30日・売上の多い順）");
  L.push("");
  L.push(table(["SKU", "商品名", "販売数", "売上", "粗利（広告費前）", "粗利率", "広告費"],
    s.products.map((p) => [p.sku, p.name, num(p.units), yen(p.revenue), p.costManual ? "要手計算" : yen(p.gross),
      p.costManual ? "—" : pct(p.grossRate), yen(p.adCost)])));
  L.push("");

  L.push("## 在庫");
  L.push("");
  const LV: Record<string, string> = { out: "在庫切れ", risk: "欠品間近", watch: "注意", ok: "問題なし", unknown: "判定不可" };
  const inv = [...s.inventory].sort((a, b) => ["out", "risk", "watch", "unknown", "ok"].indexOf(a.level) - ["out", "risk", "watch", "unknown", "ok"].indexOf(b.level));
  L.push(table(["状態", "モール", "SKU", "商品名", "販売可能", "納品中", "1日あたり販売", "残り日数", "定期便30日見込み", "判定理由"],
    inv.slice(0, 40).map((r) => [LV[r.level], MALL[r.mall] ?? r.mall, r.sku, r.name, num(r.qty), num(r.inbound),
      r.velocity == null ? "—" : r.velocity, r.daysOfSupply == null ? "—" : r.daysOfSupply, r.snsNext30 == null ? "—" : r.snsNext30, r.reason])));
  if (inv.length > 40) L.push(`\nほか ${inv.length - 40} 件は「問題なし」などのため省略`);
  L.push("");

  L.push("## データの鮮度");
  L.push("");
  L.push(table(["データ", "最新日", "何日前"], s.freshness.map((f) => [f.label, f.latest ?? "未取り込み", f.daysAgo ?? "—"])));
  L.push("");
  return L.join("\n");
}

/** チャットに貼る依頼文。指示はページではなくこちらに書く */
export function requestPrompt(caseName: string, url: string, malls: string[] = []): string {
  const where = malls.length ? `（${malls.map((m) => MALL[m] ?? m).join("・")}）` : "";
  return [
    `以下のURLは、私たちが運用しているEC案件「${caseName}」${where}の最新の運用データです。読み込んで分析してください。`,
    url,
    "",
    "お願いしたいこと：",
    "1. 状況の要約（3行以内）",
    "2. 今週やるべきこと（優先度の高い順に最大7件。それぞれ「何を・どれくらい・なぜ（根拠の数字）・期待できる効果」）",
    "3. 判断に足りないデータや、確認したほうがいいこと",
    "",
    "前提：金額はツールが確定させた値なので計算し直さなくて大丈夫です。損益分岐ROASを下回る広告は赤字です。",
    ...(malls.length > 1 ? ["帰属期間がモールで違うので、楽天とAmazonのROASは直接比べないでください。"] : []),
    "入札や予算の変更は担当者が手で行います。",
  ].join("\n");
}
