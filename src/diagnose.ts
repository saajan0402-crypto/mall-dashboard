/**
 * APIの疎通確認
 *
 * 目的は「どのAPIが実際に通るか」を担当者の回答を待たずに確定させること。
 * SP-API はロールが足りないと 403 を返すので、1本ずつ叩いて結果を並べる。
 * すべて参照のみ。モールのデータを書き換える呼び出しはひとつも入れていない。
 *
 * ひとつだけ例外として、レポート系は「レポートを1件依頼する」操作になる。
 * これは自分の店舗のデータを自分で集計させるだけなので、副作用はない。
 */

import { readCreds, saveLicenseExpiry, type ConnEnv, type Mall } from "./connections";
import { accessToken, spapi, adsapi, errorMessage as amzError, JP_MARKETPLACE, type LwaEnv } from "./amazon";
import { rms, licenseExpiry, searchOrders, errorMessage as rmsError } from "./rakuten";

export interface Probe {
  key: string;
  /** 画面に出す名前 */
  label: string;
  /** これが通るために必要なロール・設定 */
  need: string;
  /** この結果で何ができるようになるか */
  unlocks: string;
  ok: boolean;
  status: number;
  message: string;
}

export interface DiagnoseResult {
  caseId: string;
  caseName: string;
  mall: Mall;
  configured: boolean;
  probes: Probe[];
  /** 全体の判定 */
  summary: string;
}

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000);
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/* ───────── Amazon ───────── */

async function probeAmazon(env: ConnEnv & LwaEnv, caseId: string): Promise<Probe[]> {
  const probes: Probe[] = [];
  const creds = await readCreds(env, caseId, "amazon");
  if (!creds?.refresh_token) {
    return [
      {
        key: "token",
        label: "アクセストークンの取得",
        need: "リフレッシュトークンの登録",
        unlocks: "SP-API のすべて",
        ok: false,
        status: 0,
        message: "接続情報が未登録です",
      },
    ];
  }

  let token: string;
  try {
    token = await accessToken(env, creds.refresh_token);
    probes.push({
      key: "token",
      label: "アクセストークンの取得（LWA）",
      need: "LWAクライアント情報＋リフレッシュトークン",
      unlocks: "SP-API のすべて",
      ok: true,
      status: 200,
      message: "取得できました",
    });
  } catch (e) {
    const err = e as { message?: string; status?: number };
    return [
      {
        key: "token",
        label: "アクセストークンの取得（LWA）",
        need: "LWAクライアント情報＋リフレッシュトークン",
        unlocks: "SP-API のすべて",
        ok: false,
        status: err.status ?? 0,
        message: err.message ?? String(e),
      },
    ];
  }

  const calls: Array<{
    key: string;
    label: string;
    need: string;
    unlocks: string;
    run: () => Promise<{ status: number; ok: boolean; body: unknown }>;
  }> = [
    {
      key: "sellers",
      label: "出店情報の取得",
      need: "（ロール不要）",
      unlocks: "接続先アカウントの確認",
      run: () => spapi(token, "/sellers/v1/marketplaceParticipations"),
    },
    {
      key: "orders",
      label: "注文の取得",
      need: "在庫および注文のトラッキング",
      unlocks: "日次売上・商品別の販売数",
      run: () =>
        spapi(
          token,
          `/orders/v0/orders?MarketplaceIds=${JP_MARKETPLACE}` +
            `&CreatedAfter=${daysAgo(2).toISOString()}&MaxResultsPerPage=1`
        ),
    },
    {
      key: "fba_inventory",
      label: "FBA在庫の取得",
      need: "Amazonフルフィルメント",
      unlocks: "在庫数・欠品アラート",
      run: () =>
        spapi(
          token,
          `/fba/inventory/v1/summaries?granularityType=Marketplace` +
            `&granularityId=${JP_MARKETPLACE}&marketplaceIds=${JP_MARKETPLACE}`
        ),
    },
    {
      key: "finances",
      label: "入金明細の取得",
      need: "財務および会計",
      unlocks: "手数料の実額（月次の粗利確定）",
      run: () =>
        spapi(
          token,
          `/finances/v0/financialEvents?PostedAfter=${daysAgo(7).toISOString()}&MaxResultsPerPage=10`
        ),
    },
    {
      key: "reports_list",
      label: "レポート一覧の取得",
      need: "（レポートAPIの疎通確認）",
      unlocks: "レポート系すべての前提",
      run: () =>
        spapi(
          token,
          `/reports/2021-06-30/reports?reportTypes=GET_SALES_AND_TRAFFIC_REPORT` +
            `&marketplaceIds=${JP_MARKETPLACE}&pageSize=10`
        ),
    },
    {
      key: "report_sales_traffic",
      label: "売上・トラフィックレポートの依頼",
      need: "ブランド分析",
      unlocks: "セッション数・CVR・商品別売上",
      run: () =>
        spapi(token, "/reports/2021-06-30/reports", {
          method: "POST",
          body: {
            reportType: "GET_SALES_AND_TRAFFIC_REPORT",
            marketplaceIds: [JP_MARKETPLACE],
            dataStartTime: isoDate(daysAgo(3)),
            dataEndTime: isoDate(daysAgo(3)),
            reportOptions: { dateGranularity: "DAY", asinGranularity: "SKU" },
          },
        }),
    },
    {
      key: "report_brand_analytics",
      label: "ブランド分析（検索用語）レポートの依頼",
      need: "ブランド分析",
      unlocks: "競合データ・検索クエリパフォーマンス",
      run: () =>
        spapi(token, "/reports/2021-06-30/reports", {
          method: "POST",
          body: {
            reportType: "GET_BRAND_ANALYTICS_SEARCH_TERMS_REPORT",
            marketplaceIds: [JP_MARKETPLACE],
            dataStartTime: isoDate(daysAgo(10)),
            dataEndTime: isoDate(daysAgo(10)),
            reportOptions: { reportPeriod: "DAY" },
          },
        }),
    },
  ];

  // 定期おトク便。旧レポート（GET_FBA_SNS_FORECAST_DATA）は2025年12月に廃止されたので
  // 後継の Replenishment API を試す。本体の作りを決めるため、通った場合は応答の冒頭も出す。
  //
  // 分かったこと（2026-11-01 の実測）
  //   - sellingPartners/metrics/search は条件を本文の直下に置く形で通る
  //   - offers/* は条件を filters でくるむ必要がある（[filters is required]）
  //   - このAPIは呼び出し制限が厳しく、続けて叩くと 429 が返る。間隔をあける
  const snsInterval = {
    startDate: isoDate(daysAgo(28)) + "T00:00:00Z",
    endDate: isoDate(daysAgo(1)) + "T00:00:00Z",
  };
  const snsFuture = {
    startDate: isoDate(daysAgo(0)) + "T00:00:00Z",
    endDate: isoDate(daysAgo(-56)) + "T00:00:00Z",
  };
  const snsCommon = (interval: { startDate: string; endDate: string }, type: "PERFORMANCE" | "FORECAST") => ({
    aggregationFrequency: "WEEK",
    timeInterval: interval,
    timePeriodType: type,
    marketplaceId: JP_MARKETPLACE,
    programTypes: ["SUBSCRIBE_AND_SAVE"],
  });

  const snsCalls: Array<[string, string, string, Record<string, unknown>]> = [
    ["sns_partner_perf", "定期おトク便の実績（店舗全体）",
      "/replenishment/2022-11-07/sellingPartners/metrics/search",
      { ...snsCommon(snsInterval, "PERFORMANCE"),
        metrics: ["TOTAL_SUBSCRIPTIONS_REVENUE", "SHIPPED_SUBSCRIPTION_UNITS", "ACTIVE_SUBSCRIPTIONS"] }],
    ["sns_partner_forecast", "定期おトク便の予測（店舗全体）",
      "/replenishment/2022-11-07/sellingPartners/metrics/search",
      { ...snsCommon(snsFuture, "FORECAST"), metrics: ["SHIPPED_SUBSCRIPTION_UNITS"] }],
    ["sns_offer_perf", "定期おトク便の実績（商品別）",
      "/replenishment/2022-11-07/offers/metrics/search",
      { filters: snsCommon(snsInterval, "PERFORMANCE"),
        metrics: ["SHIPPED_SUBSCRIPTION_UNITS", "TOTAL_SUBSCRIPTIONS_REVENUE"],
        pagination: { limit: 10, offset: 0 } }],
    ["sns_offer_forecast", "定期おトク便の予測（商品別）",
      "/replenishment/2022-11-07/offers/metrics/search",
      { filters: snsCommon(snsFuture, "FORECAST"),
        metrics: ["SHIPPED_SUBSCRIPTION_UNITS"],
        pagination: { limit: 10, offset: 0 } }],
    ["sns_offers", "定期おトク便の設定（商品別）",
      "/replenishment/2022-11-07/offers/search",
      { filters: { marketplaceId: JP_MARKETPLACE, programTypes: ["SUBSCRIBE_AND_SAVE"] },
        pagination: { limit: 10, offset: 0 } }],
  ];

  for (let i = 0; i < snsCalls.length; i++) {
    const [key, label, path, body] = snsCalls[i];
    if (i > 0) await new Promise((r) => setTimeout(r, 3000));   // 呼び出し制限よけ
    try {
      let r = await spapi(token, path, { method: "POST", body });
      if (r.status === 429) {
        // 制限に当たっただけなら、少し待てば通る
        await new Promise((res) => setTimeout(res, 12000));
        r = await spapi(token, path, { method: "POST", body });
      }
      // 応答の冒頭を添える。どの項目が返るか分からないと取り込み処理を書けないため
      const preview = JSON.stringify(r.body).slice(0, 700);
      probes.push({
        key, label,
        need: "（Replenishment API）",
        unlocks: "定期便の確定需要を欠品アラートに反映",
        ok: r.ok, status: r.status,
        message: r.ok ? `通りました　${preview}` : `${amzError(r.body)}　${preview}`,
      });
    } catch (e) {
      probes.push({
        key, label, need: "（Replenishment API）",
        unlocks: "定期便の確定需要を欠品アラートに反映",
        ok: false, status: 0, message: String(e),
      });
    }
  }

  for (const c of calls) {
    try {
      const r = await c.run();
      probes.push({
        key: c.key,
        label: c.label,
        need: c.need,
        unlocks: c.unlocks,
        ok: r.ok,
        status: r.status,
        message: r.ok ? "通りました" : amzError(r.body),
      });
    } catch (e) {
      probes.push({
        key: c.key, label: c.label, need: c.need, unlocks: c.unlocks,
        ok: false, status: 0, message: String(e),
      });
    }
  }

  // 広告APIは承認後にトークンが入る。入っていなければ飛ばす
  if (creds.ads_refresh_token) {
    try {
      const adsToken = await accessToken(env, creds.ads_refresh_token);
      const r = await adsapi(env, adsToken, "/v2/profiles");
      probes.push({
        key: "ads_profiles",
        label: "広告アカウント一覧の取得（Ads API）",
        need: "Amazon Ads API の承認",
        unlocks: "広告レポートの自動取得（CSV手動保存の廃止）",
        ok: r.ok,
        status: r.status,
        message: r.ok ? "通りました" : amzError(r.body),
      });
    } catch (e) {
      const err = e as { message?: string; status?: number };
      probes.push({
        key: "ads_profiles",
        label: "広告アカウント一覧の取得（Ads API）",
        need: "Amazon Ads API の承認",
        unlocks: "広告レポートの自動取得（CSV手動保存の廃止）",
        ok: false, status: err.status ?? 0, message: err.message ?? String(e),
      });
    }
  } else {
    probes.push({
      key: "ads_profiles",
      label: "広告アカウント一覧の取得（Ads API）",
      need: "Amazon Ads API の承認",
      unlocks: "広告レポートの自動取得（CSV手動保存の廃止）",
      ok: false, status: 0, message: "広告APIのリフレッシュトークンが未登録です（審査中のため想定どおり）",
    });
  }

  return probes;
}

/* ───────── 楽天 ───────── */

/**
 * 値そのものを出さずに形だけ返す。
 * 貼り付けミス（余計な空白・改行・全角）をここで切り分けられるようにする
 */
function shape(v: string): string {
  const parts = [`${v.length}文字`, `先頭 ${v.slice(0, 2)}`];
  if (/\s/.test(v)) parts.push("⚠空白か改行が混ざっています");
  // eslint-disable-next-line no-control-regex
  if (/[^\x21-\x7e]/.test(v)) parts.push("⚠半角英数字以外が混ざっています");
  return parts.join(" / ");
}

/** 楽天の認証エラーに、確認すべき場所を添える */
function rakutenHint(status: number, body: unknown): string {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  if (status !== 401 && !/Un-Authorised/i.test(text)) return "";
  return (
    "　→ 確認する順番：①licenseKey の有効期限（90日ごとに更新が必要）" +
    " ②RMS で該当APIが「利用可能」になっているか" +
    " ③serviceSecret と licenseKey が同じアプリの組み合わせか。" +
    "RMS の 店舗様向け情報・サービス → WEB APIサービス → 利用設定 → アプリ一覧 で確認できます"
  );
}


async function probeRakuten(env: ConnEnv, caseId: string): Promise<Probe[]> {
  const creds = await readCreds(env, caseId, "rakuten");
  if (!creds?.service_secret || !creds?.license_key) {
    return [
      {
        key: "license",
        label: "ライセンスキーの有効期限",
        need: "serviceSecret とライセンスキーの登録",
        unlocks: "RMS のすべて",
        ok: false, status: 0, message: "接続情報が未登録です",
      },
    ];
  }
  const rc = { service_secret: creds.service_secret, license_key: creds.license_key };
  const probes: Probe[] = [];

  // 値そのものは出さずに、形だけ報告する。貼り付けミスをここで切り分ける
  probes.push({
    key: "credentials",
    label: "登録されている値の形",
    need: "（貼り付けミスの切り分け）",
    unlocks: "原因の切り分け",
    ok: true,
    status: 200,
    message:
      `serviceSecret: ${shape(creds.service_secret)} / ` +
      `licenseKey: ${shape(creds.license_key)}`,
  });

  // ライセンス期限。ここが通れば認証そのものは生きている
  const { date, result } = await licenseExpiry(rc);
  if (date) await saveLicenseExpiry(env, caseId, date);
  probes.push({
    key: "license",
    label: "ライセンスキーの有効期限",
    need: "（認証の確認）",
    unlocks: "期限切れの事前通知",
    ok: result.ok,
    status: result.status,
    message: date
      ? `有効期限 ${date}`
      : result.ok
        ? "通りましたが期限を読み取れませんでした"
        : `${rmsError(result.body)}${rakutenHint(result.status, result.body)}`,
  });

  const calls: Array<{
    key: string; label: string; need: string; unlocks: string;
    run: () => Promise<{ status: number; ok: boolean; body: unknown }>;
  }> = [
    {
      key: "order_search",
      label: "受注の検索（楽天ペイ受注API）",
      need: "RMS WEB SERVICE の受注API利用申請",
      unlocks: "日次売上・商品別の販売数",
      run: () => searchOrders(rc, daysAgo(2), new Date(), { perPage: 10 }),
    },
    {
      key: "item_search",
      label: "商品情報の取得（商品API 2.0）",
      need: "商品APIの利用申請",
      unlocks: "商品管理番号の照合・価格の取得",
      run: () => rms(rc, "/2.0/items/search?hits=1"),
    },
    {
      key: "inventory",
      label: "在庫数の取得（在庫API 2.0）",
      need: "在庫APIの利用申請",
      unlocks: "在庫数・欠品アラート",
      run: () => rms(rc, "/2.0/inventories/bulk-get/range?minQuantity=0"),
    },
    {
      key: "inquiry",
      label: "問い合わせ件数の取得（問い合わせ管理API）",
      need: "問い合わせ管理APIの利用申請",
      unlocks: "返信下書き（ver 2.0）",
      run: () => rms(rc, "/1.0/inquirymng-api/inquiries/count"),
    },
  ];

  for (const c of calls) {
    try {
      const r = await c.run();
      probes.push({
        key: c.key, label: c.label, need: c.need, unlocks: c.unlocks,
        ok: r.ok, status: r.status,
        message: r.ok ? "通りました" : `${rmsError(r.body)}${rakutenHint(r.status, r.body)}`,
      });
    } catch (e) {
      probes.push({
        key: c.key, label: c.label, need: c.need, unlocks: c.unlocks,
        ok: false, status: 0, message: String(e),
      });
    }
  }
  return probes;
}

/* ───────── 入口 ───────── */

/** 案件×モールを1件ずつ診断する。case_id を省略すると全案件 */
export async function diagnose(
  env: ConnEnv & LwaEnv,
  opts: { caseId?: string; mall?: Mall } = {}
): Promise<DiagnoseResult[]> {
  const { results: cases } = await env.DB.prepare(
    `SELECT id, name FROM cases WHERE status = 'active' ${opts.caseId ? "AND id = ?" : ""} ORDER BY name`
  )
    .bind(...(opts.caseId ? [opts.caseId] : []))
    .all<{ id: string; name: string }>();

  const malls: Mall[] = opts.mall ? [opts.mall] : ["amazon", "rakuten"];
  const out: DiagnoseResult[] = [];

  for (const c of cases) {
    for (const mall of malls) {
      const probes = mall === "amazon" ? await probeAmazon(env, c.id) : await probeRakuten(env, c.id);
      const configured = !probes.some((p) => p.message === "接続情報が未登録です");
      const passed = probes.filter((p) => p.ok).length;
      out.push({
        caseId: c.id,
        caseName: c.name,
        mall,
        configured,
        probes,
        summary: configured ? `${passed} / ${probes.length} 通過` : "未登録",
      });
    }
  }
  return out;
}
