/**
 * Amazon Ads API からの広告レポート自動取り込み
 *
 * 流れ：依頼（queued → requested）→ 出来上がりを待つ → 取得して保存（imported）
 * レポートは出来上がるまで数分〜数十分かかるので、5分ごとのバッチで少しずつ進める。
 *
 * 毎朝、直近14日ぶんを取り直す。広告経由の売上はクリックから 7日（SP）／14日（SB）の間
 * あとから増えていくため、昨日だけ取ると直近の数字が小さいまま固まってしまう。
 *
 * 保存は CSV 取り込みと同じ関数（saveParsedAds）を通すので、画面や集計は区別なく使える。
 * 同じ日・同じ種類のデータは API の値で置き換わる。
 */

import { adsAccessToken, adsapi, errorMessage, type LwaEnv } from "./amazon";
import { readCreds, type ConnEnv } from "./connections";
import { saveParsedAds } from "./ingestAds";
import type { AdLevel, AdRow, SearchTermRow } from "./adImport";

export interface AdsApiEnv extends ConnEnv, LwaEnv {
  FILES: R2Bucket;
}

interface ReportDef {
  label: string;
  adProduct: "SPONSORED_PRODUCTS" | "SPONSORED_BRANDS";
  reportTypeId: string;
  groupBy: string[];
  /** 無いと保存できない列 */
  required: string[];
  /** あればうれしい列。列名で拒否されたら外して依頼し直す */
  optional: string[];
  kind: "ads" | "search_terms";
  level: AdLevel;
  adType: "sp" | "sb";
  attributionDays: number;
  /** Amazon が保持している日数。これより古い日は依頼できない */
  retentionDays: number;
}

const SP = { adProduct: "SPONSORED_PRODUCTS" as const, adType: "sp" as const, attributionDays: 7, retentionDays: 95 };
const SB = { adProduct: "SPONSORED_BRANDS" as const, adType: "sb" as const, attributionDays: 14, retentionDays: 60 };
const SP_METRICS = ["impressions", "clicks", "cost", "purchases7d", "sales7d"];
const SB_METRICS = ["impressions", "clicks", "cost", "purchases", "sales"];

export const REPORTS: Record<string, ReportDef> = {
  sp_campaign: {
    ...SP, label: "SP キャンペーン別", reportTypeId: "spCampaigns", groupBy: ["campaign"],
    required: ["date", "campaignName", ...SP_METRICS], optional: ["campaignId", "campaignBudgetAmount"],
    kind: "ads", level: "campaign",
  },
  sp_product: {
    ...SP, label: "SP 商品別", reportTypeId: "spAdvertisedProduct", groupBy: ["advertiser"],
    required: ["date", "campaignName", "adGroupName", "advertisedSku", ...SP_METRICS], optional: ["advertisedAsin"],
    kind: "ads", level: "product",
  },
  sp_keyword: {
    ...SP, label: "SP キーワード別", reportTypeId: "spTargeting", groupBy: ["targeting"],
    required: ["date", "campaignName", "adGroupName", "targeting", ...SP_METRICS], optional: ["matchType", "keywordBid"],
    kind: "ads", level: "keyword",
  },
  sp_search_term: {
    ...SP, label: "SP 検索用語", reportTypeId: "spSearchTerm", groupBy: ["searchTerm"],
    required: ["date", "campaignName", "adGroupName", "searchTerm", ...SP_METRICS], optional: ["targeting", "matchType"],
    kind: "search_terms", level: "keyword",
  },
  sb_campaign: {
    ...SB, label: "SB キャンペーン別", reportTypeId: "sbCampaigns", groupBy: ["campaign"],
    required: ["date", "campaignName", ...SB_METRICS], optional: ["campaignId", "campaignBudgetAmount"],
    kind: "ads", level: "campaign",
  },
  sb_search_term: {
    ...SB, label: "SB 検索用語", reportTypeId: "sbSearchTerm", groupBy: ["searchTerm"],
    required: ["date", "campaignName", "adGroupName", "searchTerm", ...SB_METRICS], optional: ["keywordText", "matchType"],
    kind: "search_terms", level: "keyword",
  },
};

const jst = (n = 0) => new Date(Date.now() + 9 * 3600 * 1000 - n * 86400000).toISOString().slice(0, 10);
const addDays = (d: string, n: number) => new Date(Date.parse(d) + n * 86400000).toISOString().slice(0, 10);
const num = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const int = (v: unknown) => Math.round(num(v));
const str = (v: unknown) => (v == null ? "" : String(v));

/* ───────── 依頼を積む ───────── */

/** 広告APIを使える案件（プロフィールIDが入っている案件） */
async function adsCases(env: AdsApiEnv, caseId?: string): Promise<Array<{ caseId: string; profileId: string; token?: string }>> {
  const { results } = await env.DB.prepare(
    `SELECT m.case_id FROM case_malls m JOIN cases c ON c.id = m.case_id
      WHERE m.mall = 'amazon' AND m.credentials_enc IS NOT NULL AND (c.status = 'active' ${caseId ? "OR 1 = 1" : ""})
        ${caseId ? "AND m.case_id = ?" : ""}`
  ).bind(...(caseId ? [caseId] : [])).all<{ case_id: string }>();
  const out = [];
  for (const r of results) {
    const creds = await readCreds(env, r.case_id, "amazon").catch(() => null);
    const profileId = creds?.ads_profile_id?.replace(/\s/g, "");
    if (profileId && (creds?.ads_refresh_token || env.AMAZON_ADS_REFRESH_TOKEN)) {
      out.push({ caseId: r.case_id, profileId, token: creds?.ads_refresh_token || undefined });
    }
  }
  return out;
}

/**
 * 期間を種類ごと・31日ごとに区切って依頼を積む。
 * 同じ案件・種類・期間でまだ終わっていない依頼があれば積まない
 */
export async function queueAdsReports(
  env: AdsApiEnv, opts: { caseId?: string; from: string; to: string; purpose: "daily" | "backfill" | "manual" },
): Promise<{ queued: number; cases: number; skipped: string[] }> {
  const cases = await adsCases(env, opts.caseId);
  let queued = 0;
  const skipped: string[] = [];
  for (const c of cases) {
    for (const [key, def] of Object.entries(REPORTS)) {
      const oldest = jst(def.retentionDays - 1);
      let start = opts.from < oldest ? oldest : opts.from;
      if (opts.from < oldest) skipped.push(`${def.adType.toUpperCase()}はAmazon側に${def.retentionDays}日ぶんしか残っていないため、それより前は取れません`);
      while (start <= opts.to) {
        const end = [addDays(start, 30), opts.to].sort()[0];
        const dup = await env.DB.prepare(
          `SELECT 1 FROM ads_report_jobs WHERE case_id = ? AND report_key = ? AND start_date = ? AND end_date = ?
             AND status IN ('queued', 'requested')`
        ).bind(c.caseId, key, start, end).first();
        if (!dup) {
          await env.DB.prepare(
            `INSERT INTO ads_report_jobs (id, case_id, profile_id, report_key, start_date, end_date, purpose)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
          ).bind(crypto.randomUUID(), c.caseId, c.profileId, key, start, end, opts.purpose).run();
          queued++;
        }
        start = addDays(end, 1);
      }
    }
  }
  return { queued, cases: cases.length, skipped: [...new Set(skipped)] };
}

/** 毎朝の分。直近14日（昨日まで） */
export function queueDailyAds(env: AdsApiEnv) {
  return queueAdsReports(env, { from: jst(14), to: jst(1), purpose: "daily" });
}

/* ───────── 進める ───────── */

interface Job {
  id: string; case_id: string; profile_id: string; report_key: string;
  start_date: string; end_date: string; status: string; report_id: string | null; attempts: number;
  created_at: string;
}

/** 1つの依頼を Amazon に出す。列名で拒否されたら、あればうれしい列を外してもう一度 */
async function requestReport(env: AdsApiEnv, token: string, job: Job): Promise<{ reportId?: string; error?: string }> {
  const def = REPORTS[job.report_key];
  for (const columns of [[...def.required, ...def.optional], def.required]) {
    const r = await adsapi(env, token, "/reporting/reports", {
      method: "POST",
      profileId: job.profile_id,
      contentType: "application/vnd.createasyncreportrequest.v3+json",
      body: {
        name: `mall-dashboard ${job.report_key} ${job.start_date}~${job.end_date}`,
        startDate: job.start_date, endDate: job.end_date,
        configuration: {
          adProduct: def.adProduct, groupBy: def.groupBy, columns,
          reportTypeId: def.reportTypeId, timeUnit: "DAILY", format: "GZIP_JSON",
        },
      },
    });
    const body = r.body as { reportId?: string; detail?: string; message?: string };
    if (r.ok && body.reportId) return { reportId: body.reportId };
    // 同じ内容の依頼が既にあるときは、その番号が返ってくるので使い回す
    const dup = /duplicate of\s*:?\s*([0-9a-f-]{36})/i.exec(String(body.detail ?? body.message ?? ""));
    if (r.status === 425 && dup) return { reportId: dup[1] };
    const msg = `HTTP ${r.status} ${errorMessage(r.body)}`;
    if (r.status === 400 && /column/i.test(msg) && columns.length > def.required.length) continue;
    return { error: msg };
  }
  return { error: "列の指定が受け付けられませんでした" };
}

/** 出来上がったレポートを読み、保存できる形にする */
export function toParsed(job: Job, records: Array<Record<string, unknown>>) {
  const def = REPORTS[job.report_key];
  const orders = (o: Record<string, unknown>) => int(def.adType === "sp" ? o.purchases7d : o.purchases);
  const sales = (o: Record<string, unknown>) => int(def.adType === "sp" ? o.sales7d : o.sales);
  const rows: AdRow[] = [];
  const terms: SearchTermRow[] = [];
  for (const o of records) {
    const date = str(o.date).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    if (def.kind === "search_terms") {
      terms.push({
        date, adType: def.adType,
        campaign: str(o.campaignName), adGroup: str(o.adGroupName),
        targeting: str(o.targeting ?? o.keywordText), matchType: str(o.matchType),
        searchTerm: str(o.searchTerm), portfolio: null,
        impressions: o.impressions == null ? null : int(o.impressions),
        clicks: int(o.clicks), cost: int(o.cost), orders: orders(o), sales: sales(o),
        impRank: null, impShare: null, attributionDays: def.attributionDays,
      });
    } else {
      rows.push({
        date, level: def.level,
        campaign: str(o.campaignName),
        adGroup: def.level === "campaign" ? "" : str(o.adGroupName),
        keyword: def.level === "keyword" ? str(o.targeting) : "",
        matchType: def.level === "keyword" ? str(o.matchType) : "",
        externalId: def.level === "product" ? str(o.advertisedSku) : "",
        impressions: o.impressions == null ? null : int(o.impressions),
        clicks: int(o.clicks), cost: int(o.cost), orders: orders(o), sales: sales(o),
        bid: o.keywordBid == null ? null : num(o.keywordBid),
        suggestedCpc: null, newClicks: null, newSales: null,
        adType: def.adType, portfolio: null,
        budget: o.campaignBudgetAmount == null ? null : num(o.campaignBudgetAmount),
        budgetCoverage: null, attributionDays: def.attributionDays,
      });
    }
  }
  return {
    mall: "amazon" as const, kind: def.kind, level: def.level,
    periodStart: job.start_date, periodEnd: job.end_date, rows, terms,
  };
}

async function setJob(db: D1Database, id: string, fields: Record<string, string | number | null>) {
  const keys = Object.keys(fields);
  await db.prepare(`UPDATE ads_report_jobs SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = datetime('now') WHERE id = ?`)
    .bind(...keys.map((k) => fields[k]), id).run();
}

/**
 * 積んである依頼を進める。時間の上限まで、依頼・確認・取得をくり返す。
 * 1つの案件で同時に出す依頼は8件まで（Amazon 側の混雑を避けるため）
 */
export async function pumpAdsReports(env: AdsApiEnv, opts: { budgetMs?: number; caseId?: string } = {}):
  Promise<{ requested: number; imported: number; errors: number; pending: number }> {
  const deadline = Date.now() + (opts.budgetMs ?? 50000);
  const stat = { requested: 0, imported: 0, errors: 0, pending: 0 };
  const tokens = new Map<string, string>();
  const cases = await adsCases(env, opts.caseId);
  const tokenOf = async (caseId: string) => {
    if (!tokens.has(caseId)) {
      const c = cases.find((x) => x.caseId === caseId);
      tokens.set(caseId, await adsAccessToken(env, c?.token));
    }
    return tokens.get(caseId)!;
  };

  // 6時間たっても出来上がらないものは打ち切る（Amazon 側で失われていることがある）
  await env.DB.prepare(
    `UPDATE ads_report_jobs SET status = 'error', error = '6時間待っても出来上がりませんでした', updated_at = datetime('now')
      WHERE status = 'requested' AND created_at < datetime('now', '-6 hours')`
  ).run();

  const { results: jobs } = await env.DB.prepare(
    `SELECT * FROM ads_report_jobs WHERE status IN ('requested', 'queued') ${opts.caseId ? "AND case_id = ?" : ""}
      ORDER BY CASE status WHEN 'requested' THEN 0 ELSE 1 END, created_at LIMIT 60`
  ).bind(...(opts.caseId ? [opts.caseId] : [])).all<Job>();

  const inFlight = new Map<string, number>();
  for (const j of jobs) if (j.status === "requested") inFlight.set(j.case_id, (inFlight.get(j.case_id) ?? 0) + 1);

  for (const job of jobs) {
    if (Date.now() > deadline) { stat.pending++; continue; }
    let token: string;
    try {
      token = await tokenOf(job.case_id);
    } catch (e) {
      await setJob(env.DB, job.id, { status: "error", error: `トークン：${String(e instanceof Error ? e.message : e)}` });
      stat.errors++;
      continue;
    }

    if (job.status === "queued") {
      if ((inFlight.get(job.case_id) ?? 0) >= 8) { stat.pending++; continue; }
      const r = await requestReport(env, token, job);
      if (r.reportId) {
        await setJob(env.DB, job.id, { status: "requested", report_id: r.reportId, attempts: job.attempts + 1 });
        inFlight.set(job.case_id, (inFlight.get(job.case_id) ?? 0) + 1);
        stat.requested++;
      } else {
        await setJob(env.DB, job.id, { status: "error", error: r.error ?? "不明なエラー", attempts: job.attempts + 1 });
        stat.errors++;
      }
      continue;
    }

    // requested：出来上がったか確認する
    const s = await adsapi(env, token, `/reporting/reports/${job.report_id}`, { profileId: job.profile_id });
    const b = s.body as { status?: string; url?: string; failureReason?: string };
    if (!s.ok) {
      if (s.status === 429 || s.status >= 500) { stat.pending++; continue; }   // 次の回にもう一度
      await setJob(env.DB, job.id, { status: "error", error: `確認：HTTP ${s.status} ${errorMessage(s.body)}` });
      stat.errors++;
      continue;
    }
    if (b.status === "FAILED") {
      await setJob(env.DB, job.id, { status: "error", error: `Amazon 側で失敗：${b.failureReason ?? "理由不明"}` });
      stat.errors++;
      continue;
    }
    if (b.status !== "COMPLETED" || !b.url) { stat.pending++; continue; }

    try {
      // ダウンロード先は署名つきURL。認証ヘッダを付けると逆に拒否される
      const dl = await fetch(b.url);
      if (!dl.ok || !dl.body) throw new Error(`ダウンロード HTTP ${dl.status}`);
      const gz = await dl.arrayBuffer();
      const r2Key = `raw/amazon/ads-api/${job.case_id}/${job.report_key}/${job.start_date}_${job.end_date}_${Date.now()}.json.gz`;
      await env.FILES.put(r2Key, gz, { httpMetadata: { contentType: "application/gzip" } });
      const text = await new Response(new Blob([gz]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
      const records = JSON.parse(text) as Array<Record<string, unknown>>;
      const parsed = toParsed(job, Array.isArray(records) ? records : []);
      const def = REPORTS[job.report_key];
      const saved = await saveParsedAds(env, job.case_id, parsed, {
        fileName: `API ${def.label} ${job.start_date}〜${job.end_date}`, r2Key, source: "api",
        clearRange: { from: job.start_date, to: job.end_date, adType: def.adType },
      });
      await setJob(env.DB, job.id, { status: "imported", rows: saved.rows, error: saved.unknown.length ? `商品マスタに無いSKU：${saved.unknown.slice(0, 5).join(", ")}` : null });
      stat.imported++;
    } catch (e) {
      await setJob(env.DB, job.id, { status: "error", error: `取り込み：${String(e instanceof Error ? e.message : e)}` });
      stat.errors++;
    }
  }

  if (stat.imported || stat.errors) {
    await env.DB.prepare(
      `INSERT INTO ingests (id, kind, rows, status, error, source) VALUES (?, 'ads_api', ?, ?, ?, 'api')`
    ).bind(crypto.randomUUID(), stat.imported, stat.errors ? "error" : "ok",
      stat.errors ? `${stat.errors}件の依頼が失敗（広告タブで確認）` : null).run();
  }
  return stat;
}

/** 画面用：案件の依頼の状況 */
export async function adsJobStatus(db: D1Database, caseId: string) {
  const { results } = await db.prepare(
    `SELECT id, report_key, start_date, end_date, purpose, status, rows, error, created_at, updated_at
       FROM ads_report_jobs WHERE case_id = ? ORDER BY created_at DESC LIMIT 40`
  ).bind(caseId).all<Record<string, string | number | null>>();
  const counts = await db.prepare(
    `SELECT status, COUNT(*) AS n FROM ads_report_jobs WHERE case_id = ? GROUP BY status`
  ).bind(caseId).all<{ status: string; n: number }>();
  return {
    jobs: results.map((r) => ({ ...r, label: REPORTS[String(r.report_key)]?.label ?? r.report_key })),
    counts: Object.fromEntries(counts.results.map((c) => [c.status, c.n])),
  };
}
