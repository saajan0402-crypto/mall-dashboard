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
const PRESET_JA: Record<string, string> = { yesterday: "昨日", last7: "直近7日", last14: "直近14日", last30: "直近30日",
  last90: "直近90日", this_month: "今月", last_month: "先月", all: "全期間" };

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
  const be = s.pl.breakEvenRoas;
  const P = `${s.period.from}〜${s.period.to}（${s.period.days}日間）`;
  const L: string[] = [];

  L.push(`# ${s.caseName}｜EC運用の状況レポート`);
  L.push("");
  L.push(`- 対象：${s.malls.map((m) => MALL[m] ?? m).join("・") || "（モール未接続）"}`);
  L.push(`- **集計期間：${P}**${s.period.preset && s.period.preset !== "custom" ? `（${PRESET_JA[s.period.preset] ?? s.period.preset}）` : ""}。比較は直前の同じ長さの期間（${s.prev.from}〜${s.prev.to}）`);
  L.push(`- データがある範囲：${s.dataRange.from ?? "—"}〜${s.dataRange.to ?? "—"}／作成 ${s.generatedAt} JST`);
  if (opts.url) L.push(`- このレポートのURL：${opts.url}（開くたびに最新のデータで作り直されます）`);
  L.push("");

  L.push("## このデータの読み方");
  L.push("");
  L.push("- 金額はすべて税込・円。社内の管理ツールがモールのAPIとCSVから集計した確定値で、ここで計算し直す必要はありません。");
  L.push("- **粗利（広告費前）＝ 売上 − 原価 − モール手数料 − 返品 − 値引き**。広告費はまだ引いていません。");
  L.push(`- **損益分岐ROAS ＝ 売上 ÷ 粗利（広告費前）**。この期間では **${be ?? "—"}**。広告のROASがこれを下回ると、その広告は売れるほど赤字です。`);
  L.push(`- 目標粗利率（広告費を引く前）は ${s.settings.targetMargin}%、広告費を引いた後の目標利益率は ${s.settings.adMargin}%、在庫アラートは残り ${s.settings.stockAlertDays} 日を基準にしています。`);
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
  const adCost = s.ads.totals.reduce((t, a) => t + a.cost, 0);
  L.push(`- 売上：${yen(sl.total.revenue)}（${num(sl.total.units)}個・1日平均 ${yen(sl.perDay)}）／直前の期間 ${yen(sl.prev.revenue)}／前期間比 ${pct(sl.changeRate)}`);
  L.push(`- 粗利（広告費前）：${yen(s.pl.gross)}／粗利率 ${pct(s.pl.grossRate)}`);
  L.push(`- 広告費：${yen(adCost)}／広告費を引いた利益 ${yen(s.ads.profitAfterAds)}／TACoS（広告費 ÷ 総売上）${pct(s.ads.tacos)}`);
  L.push("");

  L.push("## ツールが検出した要対応");
  L.push("");
  L.push("決まった基準（在庫日数・損益分岐ROAS・売上ゼロの広告など）で機械的に拾ったものです。優先順位の付け直しや、ここに無い論点の指摘は歓迎です。");
  L.push("");
  const ST: Record<string, string> = { open: "未対応", done: "対応済み", skip: "今はしない" };
  L.push(table(["優先度", "分野", "内容", "根拠", "状態"], s.todo.map((t) => [PRI[t.priority], t.area, t.text, t.basis ?? "",
    `${ST[t.status ?? "open"]}${t.note ? `（${t.note}）` : ""}`])));
  L.push("");
  L.push("「対応済み」「今はしない」は担当者が判断済みのものです。提案は「未対応」を中心にしてください。");
  if (s.doneThisMonth.length) {
    L.push("");
    L.push("### 今月すでに対応したこと");
    L.push("");
    L.push(table(["日付", "分野", "内容", "メモ"], s.doneThisMonth.map((d) => [d.day, d.area ?? "", d.title, d.note ?? ""])));
  }
  L.push("");

  L.push("## 損益（モール別）");
  L.push("");
  L.push(plTable(s.pl));
  if (s.pl.otherFees) L.push(`\n商品に紐づかない費用（月額登録料など）：${yen(s.pl.otherFees)}（合計の粗利には反映済み）`);
  L.push("");

  // 長い期間は週ごと・月ごとにまとめる（表が長くなりすぎるとAIが読み落とすため）
  const unit = s.period.days > 400 ? "month" : s.period.days > 92 ? "week" : "day";
  const buckets = new Map<string, { revenue: number; units: number }>();
  for (const t of s.sales.trend) {
    let k = t.date;
    if (unit === "month") k = t.date.slice(0, 7);
    if (unit === "week") { const d = new Date(t.date + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); k = d.toISOString().slice(0, 10) + "週"; }
    const b = buckets.get(k) ?? { revenue: 0, units: 0 };
    b.revenue += t.revenue; b.units += t.units; buckets.set(k, b);
  }
  L.push(`## ${unit === "day" ? "日別" : unit === "week" ? "週別（月曜始まり）" : "月別"}の売上`);
  L.push("");
  L.push(table([unit === "day" ? "日付" : unit === "week" ? "週" : "月", "売上", "販売数"], [...buckets].map(([k, b]) => [k, yen(b.revenue), num(b.units)])));
  L.push("");

  L.push("## 広告");
  L.push("");
  L.push(adTable(s.ads.totals));
  L.push("");
  L.push("### キャンペーン別（広告費の多い順）");
  L.push("");
  L.push(table(["モール", "種類", "キャンペーン", "広告費", "広告経由売上", "ROAS", "損益分岐を下回る", "予算内の時間"],
    s.ads.campaigns.map((c) => [MALL[c.mall] ?? c.mall, c.adType ? TYPE[c.adType] ?? c.adType : "—", c.name, yen(c.cost), yen(c.sales),
      c.roas ?? "—", c.belowBreakEven ? "はい" : "", c.budgetCoverage == null ? "—" : `${c.budgetCoverage}%`])));
  L.push("");
  L.push("### 売上ゼロの検索語（広告費の多い順）");
  L.push("");
  L.push(table(["モール", "種類", "検索語", "広告費", "クリック", "インプレッションシェア"],
    s.ads.wastedTerms.map((w) => [MALL[w.mall] ?? w.mall, TYPE[w.adType] ?? w.adType, w.term, yen(w.cost), num(w.clicks), w.impShare == null ? "—" : `${w.impShare}%`])));
  L.push("");
  L.push("### 成果の出ている検索語（注文2件以上・ROASの高い順）");
  L.push("");
  L.push(table(["モール", "種類", "検索語", "広告費", "広告経由売上", "ROAS", "注文"],
    s.ads.winningTerms.map((w) => [MALL[w.mall] ?? w.mall, TYPE[w.adType] ?? w.adType, w.term, yen(w.cost), yen(w.sales), w.roas, num(w.orders)])));
  L.push("");
  if (s.malls.includes("rakuten")) {
    L.push("### 楽天RPP 売上ゼロのキーワード");
    L.push("");
    L.push(table(["キーワード", "商品", "広告費", "クリック"], s.ads.wastedKeywords.map((w) => [w.term, w.product, yen(w.cost), num(w.clicks)])));
    L.push("");
  }

  L.push("## 広告の改善提案（ツール算出）");
  L.push("");
  L.push(`目標ACoS ＝ 広告費前の粗利率 − 広告費を引いた後の目標利益率（${s.settings.adMargin}%）を、商品マスタの広告方針（利益重視／シェア獲得／育成中）で調整して計算しています。1回の変更は −40%〜＋30% まで。`);
  L.push(`件数：停止を検討 ${s.advice.counts.pause}／下げる ${s.advice.counts.down}／上げる ${s.advice.counts.up}／除外候補 ${s.advice.counts.negatives}／追加候補 ${s.advice.counts.harvest}／予算 ${s.advice.counts.budgets}（上位10件ずつ掲載）`);
  L.push("");
  L.push("### 入札の見直し");
  L.push("");
  const ACT: Record<string, string> = { up: "上げる", down: "下げる", pause: "停止を検討" };
  L.push(table(["操作", "モール", "キャンペーン", "キーワード／ターゲット", "マッチ", "クリック", "広告費", "注文", "ROAS", "目標ROAS", "今", "提案", "理由"],
    s.advice.topBids.map((b) => [ACT[b.action], MALL[b.mall] ?? b.mall, b.campaign, b.keyword, b.matchType || "—", num(b.clicks), yen(b.cost), num(b.orders),
      b.roas ?? "—", b.target.roas, `${yen(b.currentBid ?? b.cpc)}${b.basis === "入札" ? "" : "（平均CPC）"}`, yen(b.suggestedBid), b.reason])));
  L.push("");
  L.push("### 除外キーワードの候補");
  L.push("");
  L.push(table(["検索語", "種類", "キャンペーン", "クリック", "広告費", "注文", "理由"],
    s.advice.topNegatives.map((x) => [x.searchTerm, x.kind === "product" ? "商品（ASIN）" : "キーワード", x.campaign, num(x.clicks), yen(x.cost), num(x.orders), x.reason])));
  L.push("");
  L.push("### 完全一致で追加する候補");
  L.push("");
  L.push(table(["検索語", "キャンペーン", "注文", "広告費", "ROAS", "目標ROAS", "提案入札", "理由"],
    s.advice.topHarvest.map((x) => [x.searchTerm, x.campaign, num(x.orders), yen(x.cost), x.roas, x.target.roas, yen(x.suggestedBid), x.reason])));
  L.push("");

  L.push("## 商品別（売上の多い順）");
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
