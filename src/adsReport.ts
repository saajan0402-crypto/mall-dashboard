/**
 * 広告タブの「AIに相談する」用のデータ（Markdown）
 *
 * ダッシュボードの AI 用コピーは「今週なにをするか」の全体像。こちらは広告だけに絞り、
 *   - 入札の上げ下げ（利益ベース）だけでは売上が先細るので、新しいキーワード・ターゲットを見つける
 *   - 競合（同じ検索語で出てくる商品）を踏まえて、ツールの提案を実行してよいか判断する
 * ための材料を、AI チャット（Web 検索ができるもの）に渡す。
 * 商品の ASIN と Amazon の商品ページの URL を入れておくので、AI 側で競合を調べられる。
 */

import { periodSummary, adTotals } from "./caseSummary";
import { buildAdAdvice, ACTION_JA } from "./adAdvice";
import { productAdTotals } from "./adProducts";

const n = (v: unknown) => Number(v ?? 0) || 0;
const yen = (v: number) => "¥" + Math.round(v).toLocaleString("ja-JP");
const r2 = (v: number) => Math.round(v * 100) / 100;
const roasOf = (sales: number, cost: number) => (cost > 0 ? String(r2(sales / cost)) : "—");
const cell = (s: unknown) => String(s ?? "").replace(/\|/g, "／").replace(/\n/g, " ");
const MALL = (m: string) => (m === "amazon" ? "Amazon" : m === "rakuten" ? "楽天" : m);

function table(head: string[], rows: Array<Array<unknown>>): string {
  if (!rows.length) return "（データなし）\n";
  return [`| ${head.join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`, ...rows.map((r) => `| ${r.map(cell).join(" | ")} |`)].join("\n") + "\n";
}

export async function renderAdsMarkdown(db: D1Database, caseId: string, caseName: string, from: string, to: string, adMarginPct: number): Promise<string> {
  const [pl, totals, adv, prodAds] = await Promise.all([
    periodSummary(db, caseId, from, to), adTotals(db, caseId, from, to),
    buildAdAdvice(db, caseId, from, to, adMarginPct), productAdTotals(db, caseId, from, to),
  ]);

  // 商品（ASIN・楽天の番号・粗利率・損益分岐ROAS）
  const { results: prods } = await db.prepare(
    `SELECT p.id, p.sku, p.name, COALESCE(p.ad_policy, 'profit') AS policy,
            (SELECT external_id FROM product_listings l WHERE l.product_id = p.id AND l.mall = 'amazon' LIMIT 1) AS amazon_sku,
            (SELECT asin FROM product_listings l WHERE l.product_id = p.id AND l.mall = 'amazon' LIMIT 1) AS asin,
            (SELECT external_id FROM product_listings l WHERE l.product_id = p.id AND l.mall = 'rakuten' LIMIT 1) AS rakuten_id,
            (SELECT SUM(revenue) FROM daily_sales s WHERE s.product_id = p.id AND s.date BETWEEN ? AND ?) AS revenue,
            (SELECT SUM(units) FROM daily_sales s WHERE s.product_id = p.id AND s.date BETWEEN ? AND ?) AS units
       FROM products p WHERE p.case_id = ? AND COALESCE(p.status, 'active') <> 'discontinued'
      ORDER BY revenue DESC`
  ).bind(from, to, from, to, caseId).all<Record<string, string | number | null>>().catch(async () =>
    // asin 列が無い古いスキーマのとき
    db.prepare(
      `SELECT p.id, p.sku, p.name, COALESCE(p.ad_policy, 'profit') AS policy,
              (SELECT external_id FROM product_listings l WHERE l.product_id = p.id AND l.mall = 'amazon' LIMIT 1) AS amazon_sku,
              NULL AS asin,
              (SELECT external_id FROM product_listings l WHERE l.product_id = p.id AND l.mall = 'rakuten' LIMIT 1) AS rakuten_id,
              (SELECT SUM(revenue) FROM daily_sales s WHERE s.product_id = p.id AND s.date BETWEEN ? AND ?) AS revenue,
              (SELECT SUM(units) FROM daily_sales s WHERE s.product_id = p.id AND s.date BETWEEN ? AND ?) AS units
         FROM products p WHERE p.case_id = ? ORDER BY revenue DESC`
    ).bind(from, to, from, to, caseId).all<Record<string, string | number | null>>());
  const POLICY: Record<string, string> = { profit: "利益重視", share: "シェア獲得", nurture: "育成中" };

  // キーワード（入札しているもの）の実績
  const { results: kws } = await db.prepare(
    `SELECT mall, COALESCE(ad_type, '') AS ad_type, campaign, keyword, match_type,
            SUM(COALESCE(impressions, 0)) AS imp, SUM(clicks) AS clicks, SUM(cost) AS cost, SUM(orders) AS orders, SUM(sales) AS sales
       FROM daily_ads WHERE case_id = ? AND level = 'keyword' AND date BETWEEN ? AND ? AND keyword <> ''
      GROUP BY mall, ad_type, campaign, keyword, match_type ORDER BY cost DESC LIMIT 80`
  ).bind(caseId, from, to).all<Record<string, string | number>>();

  // 検索語（顧客が実際に打った語）の実績。入札しているキーワードかどうかも付ける
  const { results: terms } = await db.prepare(
    `SELECT t.mall, t.search_term, SUM(COALESCE(t.impressions, 0)) AS imp, SUM(t.clicks) AS clicks, SUM(t.cost) AS cost,
            SUM(t.orders) AS orders, SUM(t.sales) AS sales, MIN(t.imp_rank) AS best_rank, MAX(t.imp_share) AS best_share,
            GROUP_CONCAT(DISTINCT t.targeting) AS targets,
            EXISTS (SELECT 1 FROM daily_ads a WHERE a.case_id = t.case_id AND a.level = 'keyword' AND LOWER(a.keyword) = LOWER(t.search_term)) AS targeted
       FROM daily_search_terms t WHERE t.case_id = ? AND t.date BETWEEN ? AND ?
      GROUP BY t.mall, t.search_term ORDER BY SUM(t.sales) DESC, SUM(t.cost) DESC LIMIT 120`
  ).bind(caseId, from, to).all<Record<string, string | number>>();

  // 週ごとの広告の推移（伸びているか、先細っているか）
  const { results: weeks } = await db.prepare(
    `SELECT mall, strftime('%Y-%W', date) AS wk, MIN(date) AS d, SUM(cost) AS cost, SUM(sales) AS sales, SUM(clicks) AS clicks,
            SUM(COALESCE(impressions, 0)) AS imp
       FROM daily_ads WHERE case_id = ? AND level = 'campaign' AND date BETWEEN date(?, '-56 day') AND ?
      GROUP BY mall, wk ORDER BY wk`
  ).bind(caseId, to, to).all<Record<string, string | number>>();

  const L: string[] = [];
  L.push(`# ${caseName}：広告の相談用データ（${from}〜${to}）`, "");
  L.push("## 前提", "");
  L.push("- 金額は税込（広告費はモールのレポートどおり）。広告経由の売上の帰属期間は Amazon SP 7日・SB 14日、楽天RPP 30日。");
  L.push(`- 目標：広告費を引いたあとに ${adMarginPct}% の利益を残す。目標ACoS ＝ 広告費前の粗利率 − ${adMarginPct}%（商品の広告方針で調整）。損益分岐ROAS ＝ 1 ÷ 粗利率。`);
  L.push("- ツールの入札提案は、過去の実績から利益ベースで上げ下げするもの。新しいキーワードの発見や競合の動きは考慮していない。");
  L.push("- 入札・予算の変更は担当者が管理画面で手で行う。");
  L.push("");

  L.push("## モール別の広告", "");
  L.push(table(["モール", "広告費", "広告経由の売上", "ROAS", "クリック", "注文", "帰属"],
    totals.map((t) => [MALL(t.mall), yen(t.cost), yen(t.sales), roasOf(t.sales, t.cost), n(t.clicks).toLocaleString("ja-JP"), n(t.orders), t.attribution])));
  L.push(`期間の総売上 ${yen(pl.revenue)}／粗利（広告費前）${yen(pl.gross)}`, "");

  L.push("## 直近8週の推移（伸び・先細りの確認用）", "");
  L.push(table(["週（開始日）", "モール", "表示回数", "クリック", "広告費", "広告経由の売上", "ROAS"],
    weeks.map((w) => [w.d, MALL(String(w.mall)), n(w.imp).toLocaleString("ja-JP"), n(w.clicks), yen(n(w.cost)), yen(n(w.sales)), roasOf(n(w.sales), n(w.cost))])));

  L.push("## 商品（競合を調べるときに使ってください）", "");
  L.push(table(["自社SKU", "商品名", "ASIN（Amazon の商品ページ）", "楽天の商品管理番号", "期間の売上", "販売数", "広告費", "広告ROAS", "広告方針"],
    prods.slice(0, 30).map((p) => {
      const ad = prodAds.get(String(p.id));
      const asin = p.asin ? `${p.asin} https://www.amazon.co.jp/dp/${p.asin}` : (p.amazon_sku ? `（SKU ${p.amazon_sku}）` : "—");
      return [p.sku, p.name, asin, p.rakuten_id ?? "—", yen(n(p.revenue)), n(p.units), ad ? yen(ad.cost) : "—",
        ad ? roasOf(ad.sales, ad.cost) : "—", POLICY[String(p.policy)] ?? p.policy];
    })));
  if (adv.targets.length) {
    L.push("目標（商品・モールごと）：", "");
    L.push(table(["対象", "粗利率（広告費前）", "目標ACoS", "目標ROAS"],
      adv.targets.slice(0, 30).map((t) => [t.label, t.gm == null ? "—" : `${Math.round(t.gm * 1000) / 10}%`,
        t.acos == null ? "—" : `${Math.round(t.acos * 1000) / 10}%`, t.roas ?? "—"])));
  }

  L.push("## 入札しているキーワードの実績（広告費の多い順・上位80）", "");
  L.push(table(["モール", "種類", "キャンペーン", "キーワード", "マッチ", "表示", "クリック", "広告費", "注文", "売上", "ROAS"],
    kws.map((k) => [MALL(String(k.mall)), String(k.ad_type).toUpperCase(), k.campaign, k.keyword, k.match_type || "—", n(k.imp).toLocaleString("ja-JP"),
      n(k.clicks), yen(n(k.cost)), n(k.orders), yen(n(k.sales)), roasOf(n(k.sales), n(k.cost))])));

  L.push("## 顧客が実際に検索した語（Amazon の検索語レポート・売上の多い順・上位120）", "");
  L.push("「入札」が「なし」の語は、自動ターゲティングや部分一致で拾っただけで、まだキーワードとして入札していない語。", "");
  L.push(table(["検索語", "入札", "表示", "クリック", "広告費", "注文", "売上", "ROAS", "表示順位（最高）", "表示シェア（最高）"],
    terms.map((t) => [t.search_term, n(t.targeted) ? "あり" : "なし", n(t.imp).toLocaleString("ja-JP"), n(t.clicks), yen(n(t.cost)), n(t.orders), yen(n(t.sales)),
      roasOf(n(t.sales), n(t.cost)), t.best_rank ?? "—", t.best_share == null ? "—" : `${t.best_share}%`])));

  L.push("## ツールの提案（利益ベース）", "");
  L.push(`### 入札の見直し（${adv.bids.length}件中 上位30）`, "");
  L.push(table(["モール", "キーワード／ターゲット", "キャンペーン", "クリック", "広告費", "ROAS", "目標ROAS", "提案", "今の入札→提案"],
    adv.bids.slice(0, 30).map((b) => [MALL(b.mall), b.keyword, b.campaign, b.clicks, yen(b.cost), b.roas ?? "—", b.target.roas,
      ACTION_JA[b.action], `${b.currentBid ?? "—"}→${b.suggestedBid}`])));
  L.push(`### 除外キーワードの候補（${adv.negatives.length}件中 上位20）`, "");
  L.push(table(["検索語", "キャンペーン", "クリック", "広告費", "注文"], adv.negatives.slice(0, 20).map((x) => [x.searchTerm, x.campaign, x.clicks, yen(x.cost), x.orders])));
  L.push(`### 追加キーワードの候補（${adv.harvest.length}件中 上位20）`, "");
  L.push(table(["検索語", "キャンペーン", "注文", "売上", "ROAS", "提案の入札"], adv.harvest.slice(0, 20).map((x) => [x.searchTerm, x.campaign, x.orders, yen(x.sales), x.roas, x.suggestedBid])));
  if (adv.budgets.length) {
    L.push("### 予算", "");
    L.push(table(["キャンペーン", "広告費", "ROAS", "予算内の時間", "提案"], adv.budgets.slice(0, 15).map((x) => [x.campaign, yen(x.cost), x.roas, `${x.coverage}%`, x.reason])));
  }
  return L.join("\n");
}

/** AI への依頼文（データの前に付ける） */
export function adsPrompt(caseName: string, from: string, to: string): string {
  return [
    `以下は、EC案件「${caseName}」の Amazon・楽天の広告データ（${from}〜${to}）です。`,
    "利益ベースで入札を上げ下げするだけだと売上が先細るので、新しいキーワードや切り口を見つけて、広告を伸ばす方針を一緒に考えてください。",
    "",
    "お願いしたいこと：",
    "1. 状況の要約（3行以内）。直近8週で伸びているか・先細っているか",
    "2. 新しく入札するべきキーワード（最大20個）。検索語の実績、商品の特徴、季節・用途・悩み・比較の切り口から考え、それぞれ「キーワード／モール／マッチタイプ／最初の入札の目安／なぜ」",
    "3. 競合の分析：商品表の ASIN の商品ページや、主要な検索語で Amazon・楽天を Web 検索し、上位に出る競合（価格・レビュー数・訴求）と比べた自社の強み・弱み。商品ターゲティング（競合 ASIN）に向く商品があれば挙げる",
    "4. ツールの提案（入札・除外・追加）のうち、競合や伸びしろを考えると「今は実行しないほうがいい」「もっと強くやるべき」ものがあれば、その理由",
    "5. 広告以外で効きそうなこと（商品ページのタイトル・画像・クーポン・セール参加など）があれば短く",
    "",
    "前提：数字はツールが集計した確定値なので計算し直さなくて大丈夫です。Web 検索ができる場合は使ってください。できない場合は、その旨を書いたうえで手元のデータだけで答えてください。",
    "",
    "────────",
    "",
  ].join("\n");
}
