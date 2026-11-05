/**
 * モール横断パフォーマンス管理ツール
 *
 * 構成の原則（要件定義 §14 より）
 *   - 数える・計算する処理はこのコードが行う。金額は必ずここで確定させる
 *   - 読む・書く・判断する処理だけを Claude API に渡す
 *   - モールへ書き込む経路は作らない。データは取り込み方向の一方向のみ
 */

import { parseProductSheet, importProducts } from "./importProducts";
import { ensureAdmin, addAdmin, removeAdmin, setAdminAll, listConnections, saveConnection, testConnection, FIELDS, type Mall } from "./connections";
import { diagnose } from "./diagnose";
import { advance, pump, jstDate } from "./ingestSales";
import { ingestFinances, pumpFinances } from "./ingestFinances";
import { ingestInventory, pumpInventory, inventoryStatus, notifyInventory } from "./ingestInventory";
import { ingestSns, pumpSns } from "./ingestSns";
import { startBackfill, runBackfill, backfillStatus } from "./backfill";
import { notifyLicenseExpiry, expiringLicenses } from "./licenseAlert";
import { ingestRakutenSales, ingestRakutenInventory, pumpRakuten } from "./ingestRakuten";
import { syncRakutenItems, pumpRakutenItems } from "./rakutenItems";
import { importAdFile, adCoverage, adSummary, type ImportResult, type SummaryLevel } from "./ingestAds";
import { SETTINGS, resolveSettings, saveSettings, feeRate, recalcFeeEst, recalcAllFeeEst, type Scope } from "./settings";
import { parseChargeCsv, saveCharges, listCharges, type ChargeRow } from "./mallCharges";
import { buildCaseSummary, periodSummary, dataRange, resolvePeriod } from "./caseSummary";
import { buildAdAdvice } from "./adAdvice";
import { renderCaseMarkdown, requestPrompt } from "./caseReport";
import { queueAdsReports, queueDailyAds, pumpAdsReports, adsJobStatus } from "./adsApi";
import { createShareLink, listShareLinks, revokeShareLink, resolveShareToken } from "./shareLinks";

/**
 * 画面とサーバーの版。画面（public/index.html の UI_VERSION）と食い違っていたら、
 * どちらかが古いままデプロイされている。変更のたびに両方を同じ値に上げる
 */
const APP_VERSION = "0.10.0";

export interface Env {
  DB: D1Database;
  FILES: R2Bucket;
  ASSETS: Fetcher;
  /** 案件ごとの接続情報を暗号化するための親鍵（Workers のシークレット） */
  SECRET_KEY?: string;
  CLAUDE_API_KEY?: string;
  SLACK_WEBHOOK_URL?: string;
  /** Amazon LWA のクライアント情報。全案件で共通なのでアプリ側に置く */
  AMAZON_LWA_CLIENT_ID?: string;
  AMAZON_LWA_CLIENT_SECRET?: string;
  /** Ads API 用（任意）。SP-API と別のクライアントで承認されたときだけ入れる */
  AMAZON_ADS_CLIENT_ID?: string;
  AMAZON_ADS_CLIENT_SECRET?: string;
  /** 全案件共通の広告APIリフレッシュトークン。案件はプロフィールIDで見分ける */
  AMAZON_ADS_REFRESH_TOKEN?: string;
  /** Cloudflare が付けるデプロイの識別子（wrangler.jsonc の version_metadata） */
  CF_VERSION_METADATA?: { id: string; tag?: string; timestamp?: string };
}

/** Cloudflare Access が付けるヘッダから、ログイン中の社員のメールを取り出す */
function viewer(req: Request): string | null {
  return req.headers.get("Cf-Access-Authenticated-User-Email");
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** 日本時間の今日（YYYY-MM-DD） */
function todayJst(): string {
  const d = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

async function api(req: Request, env: Env, path: string): Promise<Response> {
  // 稼働確認。デプロイ直後にここだけ見れば、DB と R2 が繋がっているか分かる
  if (path === "/api/health") {
    const out: Record<string, unknown> = { ok: true, time: new Date().toISOString() };
    try {
      const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM cases").first<{ n: number }>();
      out.db = { ok: true, cases: r?.n ?? 0 };
    } catch (e) {
      out.db = { ok: false, error: String(e) };
    }
    try {
      await env.FILES.head("__healthcheck__");
      out.r2 = { ok: true };
    } catch (e) {
      out.r2 = { ok: false, error: String(e) };
    }
    out.secrets = {
      claude: Boolean(env.CLAUDE_API_KEY),
      slack: Boolean(env.SLACK_WEBHOOK_URL),
      encryption: Boolean(env.SECRET_KEY),
    };
    return json(out);
  }

  if (path === "/api/me") {
    return json({
      email: viewer(req), version: APP_VERSION,
      deployment: env.CF_VERSION_METADATA
        ? { id: env.CF_VERSION_METADATA.id.slice(0, 8), at: env.CF_VERSION_METADATA.timestamp ?? null } : null,
    });
  }

  if (path === "/api/cases") {
    const { results } = await env.DB.prepare(
      `SELECT c.id, c.name, c.status, c.slack_channel,
              (SELECT COUNT(*) FROM products p WHERE p.case_id = c.id AND p.status = 'active') AS products
         FROM cases c
        WHERE c.status = 'active'
        ORDER BY c.name`
    ).all();
    return json({ cases: results });
  }

  // 商品一覧。取り込んだ結果をそのまま確認するための画面で使う
  if (path === "/api/products") {
    const caseId = new URL(req.url).searchParams.get("case_id");
    const sql = `
      SELECT p.id, p.sku, p.name, p.jan, p.ad_policy, p.status, c.name AS case_name,
             MAX(CASE WHEN l.mall = 'amazon' THEN l.external_id END) AS amazon_sku,
             MAX(CASE WHEN l.mall = 'amazon' THEN l.asin END)        AS asin,
             MAX(CASE WHEN l.mall = 'amazon' THEN l.fulfillment END) AS amazon_fulfillment,
             MAX(CASE WHEN l.mall = 'rakuten' THEN l.external_id END) AS rakuten_id,
             MAX(CASE WHEN l.mall = 'rakuten' THEN l.fulfillment END) AS rakuten_fulfillment,
             MAX(CASE WHEN l.mall = 'rakuten' THEN l.price END)        AS rakuten_price,
             MAX(CASE WHEN l.mall = 'rakuten' THEN l.check_status END) AS rakuten_check,
             (SELECT unit_cost FROM cost_history h WHERE h.product_id = p.id
               ORDER BY h.effective_from DESC LIMIT 1) AS unit_cost,
             (SELECT needs_manual FROM cost_history h WHERE h.product_id = p.id
               ORDER BY h.effective_from DESC LIMIT 1) AS cost_manual
        FROM products p
        JOIN cases c ON c.id = p.case_id
        LEFT JOIN product_listings l ON l.product_id = p.id
       ${caseId ? "WHERE p.case_id = ?" : ""}
       GROUP BY p.id
       ORDER BY c.name, p.sku`;
    const stmt = caseId ? env.DB.prepare(sql).bind(caseId) : env.DB.prepare(sql);
    const { results } = await stmt.all();
    return json({ products: results });
  }

  // 商品マスタの取り込み。貼り付けられたタブ区切りを検証して入れる
  if (path === "/api/import/products" && req.method === "POST") {
    const body = (await req.json()) as { text?: string; dryRun?: boolean };
    const text = body.text ?? "";
    const { rows, errors, skipped } = parseProductSheet(text, todayJst());

    if (body.dryRun) {
      return json({ dryRun: true, ready: rows.length, errors, skipped });
    }
    if (rows.length === 0) {
      return json({ imported: 0, errors, skipped, message: "取り込める行がありませんでした。" }, 400);
    }

    const actor = viewer(req);
    const counts = await importProducts(env.DB, rows, actor);

    const id = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO ingests (id, kind, rows, status, source, error)
       VALUES (?, 'products', ?, ?, 'manual', ?)`
    )
      .bind(id, rows.length, errors.length ? "ok" : "ok", errors.length ? `${errors.length}行を除外` : null)
      .run();

    // 取り込んだ元データは残しておく（あとから作り直せるようにするため）
    await env.FILES.put(`master/products/${new Date().toISOString()}.tsv`, text, {
      httpMetadata: { contentType: "text/tab-separated-values; charset=utf-8" },
    });

    return json({ imported: rows.length, counts, errors, skipped });
  }

  /* ───────── 売上 ───────── */

  // 日次売上。商品ごと・日ごとに並べて返す
  if (path === "/api/sales") {
    const u = new URL(req.url);
    const caseId = u.searchParams.get("case_id");
    const from = u.searchParams.get("from") ?? jstDate(14);
    const to = u.searchParams.get("to") ?? jstDate(1);
    const { results } = await env.DB.prepare(
      `SELECT s.date, s.mall, s.units, s.revenue, s.sessions, s.page_views,
              s.fee_actual, s.fee_est, s.returns,
              p.sku, p.name, c.name AS case_name,
              COALESCE(
                (SELECT unit_cost FROM cost_history h
                  WHERE h.product_id = p.id AND h.effective_from <= s.date
                  ORDER BY h.effective_from DESC LIMIT 1),
                (SELECT unit_cost FROM cost_history h
                  WHERE h.product_id = p.id
                  ORDER BY h.effective_from ASC LIMIT 1)
              ) AS unit_cost,
              CASE WHEN NOT EXISTS (SELECT 1 FROM cost_history h
                      WHERE h.product_id = p.id AND h.effective_from <= s.date)
                    AND EXISTS (SELECT 1 FROM cost_history h WHERE h.product_id = p.id)
                   THEN 1 ELSE 0 END AS cost_before_record
         FROM daily_sales s
         LEFT JOIN products p ON p.id = s.product_id
         JOIN cases c ON c.id = s.case_id
        WHERE s.date BETWEEN ? AND ? ${caseId ? "AND s.case_id = ?" : ""}
        ORDER BY s.date DESC, p.sku
        LIMIT 2001`
    )
      .bind(...(caseId ? [from, to, caseId] : [from, to]))
      .all();
    // 明細は長い期間だと数万行になるので2000行で打ち切る。日ごとの合計は別に集計して必ず全部返す
    const truncated = results.length > 2000;
    if (truncated) results.length = 2000;

    // 日ごとの合計もここで出す。画面側で足し算させない
    const { results: dailyRows } = await env.DB.prepare(
      `SELECT date, COALESCE(SUM(units), 0) AS units, COALESCE(SUM(revenue), 0) AS revenue, COALESCE(SUM(sessions), 0) AS sessions
         FROM daily_sales WHERE date BETWEEN ? AND ? ${caseId ? "AND case_id = ?" : ""}
        GROUP BY date ORDER BY date DESC`
    ).bind(...(caseId ? [from, to, caseId] : [from, to])).all<{ date: string; units: number; revenue: number; sessions: number }>();
    const { results: bySku } = await env.DB.prepare(
      `SELECT COALESCE(p.sku, '（未登録）') AS sku, COALESCE(SUM(s.units), 0) AS units, COALESCE(SUM(s.revenue), 0) AS revenue
         FROM daily_sales s LEFT JOIN products p ON p.id = s.product_id
        WHERE s.date BETWEEN ? AND ? ${caseId ? "AND s.case_id = ?" : ""}
        GROUP BY COALESCE(p.sku, '（未登録）') ORDER BY revenue DESC`
    ).bind(...(caseId ? [from, to, caseId] : [from, to])).all<{ sku: string; units: number; revenue: number }>();
    return json({ from, to, rows: results, truncated, daily: dailyRows, bySku });
  }

  /* ───────── 過去データの取り込み ───────── */

  // 進み具合。画面を開き直しても続きが見えるように、状態はDBに持っている
  if (path === "/api/backfill" && req.method === "GET") {
    const caseId = new URL(req.url).searchParams.get("case_id") ?? undefined;
    return json({ progress: await backfillStatus(env, caseId) });
  }

  // start：期間を決めて始める／run：画面を開いている間、少しずつ進める
  if (path === "/api/backfill" && req.method === "POST") {
    const b = (await req.json().catch(() => ({}))) as { action?: "start" | "run"; caseId?: string; days?: number; traffic?: boolean };
    if (b.action === "start") {
      if (!b.caseId) return json({ error: "案件を選んでください" }, 400);
      try {
        return json({ progress: await startBackfill(env, b.caseId, Number(b.days ?? 365), { traffic: b.traffic !== false }) });
      } catch (e) {
        return json({ error: String(e instanceof Error ? e.message : e) }, 400);
      }
    }
    const r = await runBackfill(env, { caseId: b.caseId, budgetMs: 25000 });
    return json(r);
  }

  /* ───────── 請求明細（実額） ───────── */

  if (path === "/api/charges" && req.method === "GET") {
    const u = new URL(req.url);
    const caseId = u.searchParams.get("case_id");
    const month = u.searchParams.get("month") ?? jstDate(1).slice(0, 7);
    if (!caseId) return json({ charges: [] });
    return json({ month, charges: await listCharges(env.DB, caseId, month) });
  }

  // CSVで入れる。書式が読めなかったときは見出しをそのまま返す
  if (path === "/api/charges/import" && req.method === "POST") {
    const form = await req.formData();
    const caseId = String(form.get("caseId") ?? "");
    const mall = String(form.get("mall") ?? "rakuten");
    const month = String(form.get("month") ?? jstDate(1).slice(0, 7));
    const file = form.get("file");
    if (!caseId || !(file instanceof File)) return json({ error: "案件とファイルを選んでください" }, 400);

    const bytes = await file.arrayBuffer();
    const parsed = parseChargeCsv(bytes, file.name);
    if (!parsed.ok) return json({ ...parsed, saved: false });

    const r2Key = `raw/${mall}/charges/${caseId}/${month}.csv`;
    await env.FILES.put(r2Key, bytes, { httpMetadata: { contentType: "text/csv" } });
    const saved = await saveCharges(env, caseId, mall, month, parsed.rows, {
      fileName: file.name, r2Key, source: "csv",
    });
    return json({ ...parsed, saved: true, ...saved });
  }

  // 手で入れる。CSVの書式に合わない月の逃げ道
  if (path === "/api/charges" && req.method === "POST") {
    const b = (await req.json()) as {
      caseId: string; mall: string; month: string; rows: ChargeRow[];
    };
    if (!b.caseId || !b.month) return json({ error: "案件と月を指定してください" }, 400);
    const saved = await saveCharges(env, b.caseId, b.mall ?? "rakuten", b.month,
      (b.rows ?? []).filter((r) => r.name && Number.isFinite(Number(r.amount))), { source: "manual" });
    return json({ ok: true, ...saved });
  }

  /* ───────── 設定 ───────── */

  if (path === "/api/settings" && req.method === "GET") {
    const u = new URL(req.url);
    const caseId = u.searchParams.get("case_id") ?? undefined;
    const mall = (u.searchParams.get("mall") ?? undefined) as "amazon" | "rakuten" | undefined;
    const resolved = await resolveSettings(env.DB, { caseId, mall });
    return json({
      ...resolved,
      defs: SETTINGS,
      feeRate: caseId && mall ? await feeRate(env.DB, caseId, mall) : null,
    });
  }

  if (path === "/api/settings" && req.method === "POST") {
    const b = (await req.json()) as {
      scope: Scope; scopeId?: string; values: Record<string, number | null>;
      caseId?: string; mall?: "amazon" | "rakuten";
    };
    await saveSettings(env.DB, b.scope, b.scopeId ?? "", b.values ?? {}, viewer(req));

    // 料率は構成の設定なので、過去にさかのぼって概算を計算し直す
    const touchedFeeRate = Object.keys(b.values ?? {}).some(
      (k) => SETTINGS.find((d) => d.key === k)?.isFeeRate
    );
    let recalculated = 0;
    if (touchedFeeRate) {
      recalculated = b.caseId && b.mall
        ? await recalcFeeEst(env.DB, b.caseId, b.mall)
        : await recalcAllFeeEst(env.DB);
    }
    return json({ ok: true, recalculated });
  }

  // 月次のまとめ。計算はダッシュボードと共通（caseSummary.periodSummary）
  if (path === "/api/summary") {
    const u = new URL(req.url);
    const caseId = u.searchParams.get("case_id");
    const month = u.searchParams.get("month") ?? jstDate(1).slice(0, 7);
    if (!caseId) return json({ error: "案件を指定してください" }, 400);
    const from = u.searchParams.get("from") ?? `${month}-01`;
    const to = u.searchParams.get("to") ?? `${month}-31`;
    const p = await periodSummary(env.DB, caseId, from, to);
    return json({ month, caseId, ...p });
  }

  /* ───────── ダッシュボード・AI用レポート ───────── */

  // 案件のデータがある範囲（「全期間」用）
  if (path === "/api/range") {
    const caseId = new URL(req.url).searchParams.get("case_id");
    if (!caseId) return json({ from: null, to: null });
    return json(await dataRange(env.DB, caseId));
  }

  // 広告の改善提案
  if (path === "/api/ads/advice") {
    const u = new URL(req.url);
    const caseId = u.searchParams.get("case_id");
    if (!caseId) return json({ error: "案件を指定してください" }, 400);
    const per = await resolvePeriod(env.DB, caseId, periodQuery(u));
    const st = await resolveSettings(env.DB, { caseId, mall: "amazon" });
    const tm = st.case.find((x) => x.key === "target_margin")?.effective ?? 30;
    return json({ ...(await buildAdAdvice(env.DB, caseId, per.from, per.to, tm)), targetMargin: tm });
  }

  if (path === "/api/dashboard") {
    const u = new URL(req.url);
    const caseId = u.searchParams.get("case_id");
    if (!caseId) return json({ error: "案件を指定してください" }, 400);
    const s = await buildCaseSummary(env.DB, caseId, periodQuery(u));
    if (!s) return json({ error: "案件が見つかりません" }, 404);
    return json(s);
  }

  // 画面の「データを直接コピー」用。共有URLを使わずにAIへ渡せる
  if (path === "/api/dashboard/markdown") {
    const u = new URL(req.url);
    const caseId = u.searchParams.get("case_id");
    if (!caseId) return json({ error: "案件を指定してください" }, 400);
    const s = await buildCaseSummary(env.DB, caseId, periodQuery(u));
    if (!s) return json({ error: "案件が見つかりません" }, 404);
    return new Response(renderCaseMarkdown(s), { headers: { "content-type": "text/markdown; charset=utf-8" } });
  }

  // 共有URLの発行・一覧・無効化（管理者のみ）
  if (path.startsWith("/api/share")) {
    const mallsOf = async (caseId: string) => (await env.DB
      .prepare("SELECT mall FROM case_malls WHERE case_id = ? AND credentials_enc IS NOT NULL ORDER BY mall")
      .bind(caseId).all<{ mall: string }>()).results.map((r) => r.mall);
    const email = viewer(req);
    const { isAdmin } = await ensureAdmin(env.DB, email);
    if (!isAdmin) return json({ error: "共有URLの発行は管理者のみです" }, 403);
    const origin = new URL(req.url).origin;

    if (path === "/api/share" && req.method === "GET") {
      const caseId = new URL(req.url).searchParams.get("case_id");
      if (!caseId) return json({ links: [] });
      return json({ links: await listShareLinks(env, origin, caseId) });
    }
    if (path === "/api/share" && req.method === "POST") {
      const b = (await req.json()) as { caseId?: string; days?: number; label?: string; preset?: string; from?: string; to?: string };
      if (!b.caseId) return json({ error: "案件を指定してください" }, 400);
      try {
        const link = await createShareLink(env, origin, b.caseId, Number(b.days ?? 7), b.label?.trim() || null, email,
          { preset: b.preset, from: b.from, to: b.to });
        const c = await env.DB.prepare("SELECT name FROM cases WHERE id = ?").bind(b.caseId).first<{ name: string }>();
        return json({ ...link, prompt: requestPrompt(c?.name ?? "", link.url, await mallsOf(b.caseId)) });
      } catch (e) {
        return json({ error: String(e instanceof Error ? e.message : e) }, 400);
      }
    }
    if (path === "/api/share/revoke" && req.method === "POST") {
      const b = (await req.json()) as { id?: string };
      return json({ ok: b.id ? await revokeShareLink(env.DB, b.id) : false });
    }
    if (path === "/api/share/prompt") {
      const u = new URL(req.url);
      const caseId = u.searchParams.get("case_id") ?? "";
      const c = await env.DB.prepare("SELECT name FROM cases WHERE id = ?").bind(caseId).first<{ name: string }>();
      return json({ prompt: requestPrompt(c?.name ?? "", u.searchParams.get("url") ?? "", await mallsOf(caseId)) });
    }
  }

  // 入金明細の取り込み
  if (path === "/api/ingest/finances" && req.method === "POST") {
    const b = (await req.json()) as { caseId?: string; date?: string; days?: number };
    if (b.caseId) {
      return json({ results: [await ingestFinances(env, b.caseId, b.date ?? jstDate(2))] });
    }
    return json({ results: await pumpFinances(env, { days: b.days ?? 10 }) });
  }

  // 取り込みの実行。画面から押されたときはその場で少し待つ
  if (path === "/api/ingest/sales" && req.method === "POST") {
    const b = (await req.json()) as { caseId?: string; date?: string; days?: number };
    const date = b.date ?? jstDate(1);
    if (b.caseId) {
      const r = await advance(env, b.caseId, date, { wait: true, maxWaitMs: 55000, force: true });
      await recalcFeeEst(env.DB, b.caseId, "amazon");
      return json({ results: [r] });
    }
    return json({ results: await pump(env, { days: b.days ?? 7 }) });
  }

  /* ───────── 在庫 ───────── */

  if (path === "/api/inventory") {
    const caseId = new URL(req.url).searchParams.get("case_id") ?? undefined;
    const rows = await inventoryStatus(env.DB, caseId);
    const count = (lv: string) => rows.filter((r) => r.level === lv).length;
    return json({
      rows,
      summary: { out: count("out"), risk: count("risk"), watch: count("watch"), ok: count("ok"), unknown: count("unknown") },
      asOf: rows[0]?.date ?? null,
    });
  }

  // 定期おトク便。在庫の取り込みとセットで動かす
  if (path === "/api/ingest/sns" && req.method === "POST") {
    const b = (await req.json().catch(() => ({}))) as { caseId?: string };
    const results = b.caseId ? [await ingestSns(env, b.caseId)] : await pumpSns(env);
    return json({ results });
  }

  /* ───────── 広告レポート ───────── */

  // 複数ファイルをまとめて受け取る。楽天の商品別・キーワード別は
  // 1回の操作で1日分しか落とせないので、まとめて投げられることが大事
  if (path === "/api/import/ads" && req.method === "POST") {
    const form = await req.formData();
    const caseId = String(form.get("caseId") ?? "");
    if (!caseId) return json({ error: "案件を選んでください" }, 400);

    const results: ImportResult[] = [];
    for (const entry of form.getAll("files")) {
      if (!(entry instanceof File)) continue;
      try {
        results.push(await importAdFile(env, caseId, entry.name, await entry.arrayBuffer()));
      } catch (e) {
        results.push({
          fileName: entry.name, ok: false, mall: "", level: "",
          periodStart: "", periodEnd: "", rows: 0, unknown: [],
          message: `読み込みに失敗：${String(e instanceof Error ? e.message : e)}`,
        });
      }
    }
    return json({ results, coverage: await adCoverage(env.DB, caseId) });
  }

  /* Amazon Ads API の自動取り込み */
  if (path === "/api/ads/api-status") {
    const caseId = new URL(req.url).searchParams.get("case_id");
    if (!caseId) return json({ jobs: [], counts: {} });
    return json(await adsJobStatus(env.DB, caseId));
  }

  // recent＝直近14日／backfill＝取れるだけ過去（SP 95日・SB 60日）。積んだらその場で少し進める
  if (path === "/api/ads/api-pull" && req.method === "POST") {
    const b = (await req.json().catch(() => ({}))) as { caseId?: string; mode?: "recent" | "backfill" | "pump" };
    if (!b.caseId) return json({ error: "案件を選んでください" }, 400);
    let queued = { queued: 0, cases: 0, skipped: [] as string[] };
    if (b.mode === "recent") queued = await queueAdsReports(env, { caseId: b.caseId, from: jstDate(14), to: jstDate(1), purpose: "manual" });
    if (b.mode === "backfill") queued = await queueAdsReports(env, { caseId: b.caseId, from: jstDate(94), to: jstDate(15), purpose: "backfill" });
    if (b.mode !== "pump" && queued.cases === 0) {
      return json({ error: "この案件は広告APIの設定がありません（接続タブでプロフィールIDを入れてください）" }, 400);
    }
    const stat = await pumpAdsReports(env, { caseId: b.caseId, budgetMs: 25000 });
    return json({ ...queued, ...stat, ...(await adsJobStatus(env.DB, b.caseId)) });
  }

  if (path === "/api/ads/coverage") {
    const u = new URL(req.url);
    const caseId = u.searchParams.get("case_id");
    if (!caseId) return json({ coverage: [] });
    return json({ coverage: await adCoverage(env.DB, caseId, Number(u.searchParams.get("days") ?? 30)) });
  }

  if (path === "/api/ads") {
    const u = new URL(req.url);
    const caseId = u.searchParams.get("case_id");
    if (!caseId) return json({ rows: [] });
    const level = (u.searchParams.get("level") ?? "product") as SummaryLevel;
    const from = u.searchParams.get("from") ?? jstDate(14);
    const to = u.searchParams.get("to") ?? jstDate(1);
    return json({ level, from, to, rows: await adSummary(env.DB, caseId, level, from, to) });
  }

  // 楽天の商品情報との照合（商品管理番号の確認と価格の取得）
  if (path === "/api/ingest/rakuten-items" && req.method === "POST") {
    const b = (await req.json().catch(() => ({}))) as { caseId?: string };
    const results = b.caseId ? [await syncRakutenItems(env, b.caseId)] : await pumpRakutenItems(env);
    return json({ results });
  }

  // 楽天の売上・在庫
  if (path === "/api/ingest/rakuten" && req.method === "POST") {
    const b = (await req.json().catch(() => ({}))) as { caseId?: string; days?: number; kind?: "sales" | "inventory" };
    if (!b.caseId) return json({ results: await pumpRakuten(env, { days: b.days ?? 7 }) });

    const results = [];
    if (b.kind !== "inventory") {
      results.push(await ingestRakutenSales(env, b.caseId, jstDate(b.days ?? 7), jstDate(0)));
      // 楽天は手数料のAPIが無いので、料率からの概算をここで入れる
      await recalcFeeEst(env.DB, b.caseId, "rakuten");
    }
    if (b.kind !== "sales") results.push(await ingestRakutenInventory(env, b.caseId));
    return json({ results });
  }

  if (path === "/api/ingest/inventory" && req.method === "POST") {
    const b = (await req.json().catch(() => ({}))) as { caseId?: string };
    const results = b.caseId ? [await ingestInventory(env, b.caseId)] : await pumpInventory(env);
    return json({ results });
  }

  /* ───────── Slack ───────── */

  // 登録した Webhook がちゃんと届くかをこの画面から確かめられるようにする
  if (path === "/api/slack/test" && req.method === "POST") {
    if (!env.SLACK_WEBHOOK_URL) {
      return json({ ok: false, message: "SLACK_WEBHOOK_URL が未設定です（Cloudflare の Runtime の Secret に登録してください）" }, 400);
    }
    const who = viewer(req) ?? "不明なユーザー";
    const res = await fetch(env.SLACK_WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: `:white_check_mark: モール横断ダッシュボードからのテスト送信です（${who}／${todayJst()}）`,
      }),
    });
    const body = await res.text();
    return json({
      ok: res.ok,
      message: res.ok ? "送信しました。Slack を確認してください" : `Slack に拒否されました：HTTP ${res.status} ${body.slice(0, 200)}`,
    });
  }

  // ライセンスキーの期限
  if (path === "/api/licenses") {
    return json({ expiring: await expiringLicenses(env.DB, 60) });
  }

  if (path === "/api/notify/license" && req.method === "POST") {
    const r = await notifyLicenseExpiry(env);
    return json({
      ok: r.sent,
      message: r.sent
        ? `${r.count} 件の期限を通知しました`
        : r.count
          ? `期限が近いものが ${r.count} 件ありますが、SLACK_WEBHOOK_URL が未設定のため送れません`
          : "期限が近いライセンスキーはありません",
    });
  }

  // 在庫アラートを今すぐ流す
  if (path === "/api/notify/inventory" && req.method === "POST") {
    const r = await notifyInventory(env);
    return json({
      ok: r.sent,
      message: r.sent
        ? `${r.count} 件のアラートを送りました`
        : r.count
          ? `対象が ${r.count} 件ありますが、SLACK_WEBHOOK_URL が未設定のため送れません`
          : "いま流すアラートはありません（欠品・欠品間近なし）",
    });
  }

  /* ───────── 接続情報（管理者のみ） ───────── */

  if (path.startsWith("/api/connections")) {
    const email = viewer(req);
    const { admins, all, isAdmin } = await ensureAdmin(env.DB, email);

    if (path === "/api/connections" && req.method === "GET") {
      if (!isAdmin) return json({ error: "forbidden", admins }, 403);
      return json({ ...(await listConnections(env) as object), fields: FIELDS, admins, adminAll: all, me: email });
    }

    if (path === "/api/connections" && req.method === "POST") {
      if (!isAdmin) return json({ error: "forbidden" }, 403);
      const b = (await req.json()) as {
        caseId: string; mall: Mall; values: Record<string, string>;
        licenseExpiresOn?: string | null; attributionDays?: number | null;
      };
      await saveConnection(env, b.caseId, b.mall, b.values ?? {},
        { licenseExpiresOn: b.licenseExpiresOn, attributionDays: b.attributionDays }, email);
      return json({ ok: true });
    }

    if (path === "/api/connections/test" && req.method === "POST") {
      if (!isAdmin) return json({ error: "forbidden" }, 403);
      const b = (await req.json()) as { caseId: string; mall: Mall };
      return json(await testConnection(env, b.caseId, b.mall));
    }

    // APIの疎通確認。どのロールが足りていないかをここで突き止める
    if (path === "/api/connections/diagnose" && req.method === "POST") {
      if (!isAdmin) return json({ error: "forbidden" }, 403);
      const b = (await req.json()) as { caseId?: string; mall?: Mall };
      const results = await diagnose(env, { caseId: b.caseId, mall: b.mall });
      // 診断した事実を履歴に残す（止まっていることに後から気づけるように）
      for (const r of results) {
        await env.DB.prepare(
          `INSERT INTO ingests (id, case_id, mall, kind, rows, status, error, source)
           VALUES (?, ?, ?, 'diagnose', ?, ?, ?, 'api')`
        )
          .bind(
            crypto.randomUUID(), r.caseId, r.mall,
            r.probes.filter((p) => p.ok).length,
            r.probes.every((p) => p.ok) ? "ok" : "error",
            r.probes.filter((p) => !p.ok).map((p) => `${p.label}: ${p.message}`).join(" / ") || null
          )
          .run();
      }
      return json({ results });
    }

    // 管理者の管理。追加・削除と「全員管理者」の切り替え
    if (path === "/api/connections/admins" && req.method === "POST") {
      if (!isAdmin) return json({ error: "forbidden" }, 403);
      const b = (await req.json()) as { action?: "add" | "remove" | "all"; email?: string; enabled?: boolean };
      try {
        if (b.action === "remove" && b.email) {
          return json({ admins: await removeAdmin(env.DB, b.email.trim(), email) });
        }
        if (b.action === "all") {
          return json({ adminAll: await setAdminAll(env.DB, Boolean(b.enabled), email) });
        }
        if (!b.email) return json({ error: "メールアドレスを入れてください" }, 400);
        return json({ admins: await addAdmin(env.DB, b.email.trim(), email) });
      } catch (e) {
        return json({ error: String(e instanceof Error ? e.message : e) }, 400);
      }
    }
  }

  // 連携ステータス。止まっていることに気づけるようにするための画面の裏側
  if (path === "/api/ingests") {
    // 案件を選んでいるときは、その案件と全体のバッチ（案件なし）の記録だけ
    const caseId = new URL(req.url).searchParams.get("case_id");
    const sql = `SELECT id, case_id, mall, kind, rows, status, error, created_at
         FROM ingests ${caseId ? "WHERE case_id = ? OR case_id IS NULL" : ""} ORDER BY created_at DESC LIMIT 50`;
    const { results } = await (caseId ? env.DB.prepare(sql).bind(caseId) : env.DB.prepare(sql)).all();
    return json({ ingests: results });
  }

  return json({ error: "not found", path }, 404);
}

/** 画面から来る期間の指定（preset か from/to） */
function periodQuery(u: URL) {
  return { preset: u.searchParams.get("preset"), from: u.searchParams.get("from"), to: u.searchParams.get("to") };
}

/** 共有URLの中身。集計済みのレポートだけを返し、それ以外には一切触れさせない */
async function shareResponse(req: Request, env: Env, url: URL): Promise<Response> {
  const headers = {
    "x-robots-tag": "noindex, nofollow, noarchive",
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  };
  if (req.method !== "GET" && req.method !== "HEAD") return new Response("Method Not Allowed", { status: 405, headers });
  const token = url.pathname.slice("/share/".length).replace(/\.(md|json|txt)$/, "");
  try {
    const link = await resolveShareToken(env.DB, token);
    // 期限切れと存在しないURLは見分けがつかないようにする
    if (!link) return new Response("このURLは無効か、有効期限が切れています。\n", { status: 404, headers: { ...headers, "content-type": "text/plain; charset=utf-8" } });
    const s = await buildCaseSummary(env.DB, link.caseId, link.range);
    if (!s) return new Response("Not Found\n", { status: 404, headers });
    if (url.pathname.endsWith(".json") || url.searchParams.get("format") === "json") {
      return new Response(JSON.stringify(s, null, 2), { headers: { ...headers, "content-type": "application/json; charset=utf-8" } });
    }
    // text/plain にしておくと、どのAIの読み込み機能でもそのまま読める
    return new Response(renderCaseMarkdown(s, { url: `${url.origin}${url.pathname}` }),
      { headers: { ...headers, "content-type": "text/plain; charset=utf-8" } });
  } catch {
    return new Response("一時的に読み込めませんでした。少し待ってからもう一度開いてください。\n", { status: 500, headers: { ...headers, "content-type": "text/plain; charset=utf-8" } });
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    // 共有URL。ここだけは Cloudflare Access の外から読める（Access 側で /share を Bypass にする）
    if (url.pathname.startsWith("/share/")) return shareResponse(req, env, url);
    if (url.pathname.startsWith("/api/")) {
      try {
        return await api(req, env, url.pathname);
      } catch (e) {
        return json({ error: String(e) }, 500);
      }
    }
    return env.ASSETS.fetch(req);
  },

  /**
   * 毎朝6時（JST）の日次バッチ。
   * ver 0.8 では枠だけ。SP-API / RMS の取り込みをここに足していく。
   */
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // 5分ごとの実行は、過去データの取り込みを進めるためだけのもの。
    // レポートの呼び出し制限が1分に1回なので、短い間隔で少しずつ進めるほうが早く終わる
    if (event.cron === "*/5 * * * *") {
      ctx.waitUntil(
        (async () => {
          // 広告レポートは出来上がるまで数分〜数十分かかるので、ここで少しずつ取りに行く
          const ads = await env.DB
            .prepare("SELECT COUNT(*) AS n FROM ads_report_jobs WHERE status IN ('queued', 'requested')")
            .first<{ n: number }>();
          if (ads?.n) await pumpAdsReports(env, { budgetMs: 60000 });
          const pending = await env.DB
            .prepare("SELECT COUNT(*) AS n FROM backfill WHERE status = 'running'")
            .first<{ n: number }>();
          if (!pending?.n) return;
          await runBackfill(env, { budgetMs: 180000 });
        })()
      );
      return;
    }

    ctx.waitUntil(
      (async () => {
        // SP-API のレポートは依頼してから生成までに数分かかる。
        // 6時の実行で依頼し、7時の実行で取りに行く。穴があれば7日前まで遡って埋める
        const results = await pump(env, { days: 7 });
        // 入金明細は売上より遅れて確定するので、別に10日ぶん遡って埋める
        const fin = await pumpFinances(env, { days: 10 });
        // 在庫は毎日とり直す。定期便を先に取り込むのは、判定に使うため
        await pumpSns(env);
        await pumpInventory(env);
        // 楽天。売上と在庫をまとめて取り込む
        await pumpRakuten(env, { days: 7 });
        // Amazon広告：直近14日ぶんの依頼を積む（6時の回だけ）。取りに行くのは5分ごとの実行
        if (event.cron === "0 21 * * *") {
          await queueDailyAds(env);
          await pumpAdsReports(env, { budgetMs: 30000 });
        }
        // 取り込んだぶんの概算手数料を入れ直す
        await recalcAllFeeEst(env.DB);
        // 商品情報の照合は朝6時の実行だけ。価格はそう頻繁に変わらない
        if (event.cron === "0 21 * * *") await pumpRakutenItems(env);
        await notifyInventory(env);
        // 期限通知は朝6時の実行だけ。7時の実行でもう一度流さないため
        if (event.cron === "0 21 * * *") await notifyLicenseExpiry(env);
        // 過去データの取り込みは5分ごとの実行に任せている
        const rows = results.reduce((n, r) => n + (r.rows ?? 0), 0)
          + fin.reduce((n, r) => n + (r.rows ?? 0), 0);
        const failed = [...results, ...fin].filter((r) => r.status === "error");
        await env.DB.prepare(
          `INSERT INTO ingests (id, kind, rows, status, error, source)
           VALUES (?, 'scheduled', ?, ?, ?, 'api')`
        )
          .bind(
            crypto.randomUUID(), rows,
            failed.length ? "error" : "ok",
            failed.length ? failed.map((f) => `${f.date}: ${f.message}`).join(" / ").slice(0, 500) : null
          )
          .run();
      })()
    );
  },
};
