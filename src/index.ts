/**
 * モール横断パフォーマンス管理ツール
 *
 * 構成の原則（要件定義 §14 より）
 *   - 数える・計算する処理はこのコードが行う。金額は必ずここで確定させる
 *   - 読む・書く・判断する処理だけを Claude API に渡す
 *   - モールへ書き込む経路は作らない。データは取り込み方向の一方向のみ
 */

import { parseProductSheet, importProducts } from "./importProducts";
import { readProducts, saveProduct, deleteProduct, exportSheet } from "./productEdit";
import { ensureAdmin, addAdmin, removeAdmin, setAdminAll, listConnections, saveConnection, testConnection, FIELDS, type Mall } from "./connections";
import { diagnose } from "./diagnose";
import { advance, pump, jstDate } from "./ingestSales";
import { ingestFinances, pumpFinances, reparseFinances } from "./ingestFinances";
import { monthlyStatement, feeBasis, postedDaily } from "./amazonFin";
import { pumpTransactions, ingestTransactionsDay } from "./ingestTransactions";
import { startRakutenBackfill, rakutenBackfillStatus, runRakutenBackfill } from "./rakutenBackfill";
import { startRematch, rematchStatus, runRematch } from "./rematch";
import { monthlyTrend } from "./adAllocation";
import { ingestInventory, pumpInventory, inventoryStatus, notifyInventory } from "./ingestInventory";
import { ingestSns, pumpSns } from "./ingestSns";
import { startBackfill, runBackfill, backfillStatus } from "./backfill";
import { notifyLicenseExpiry, expiringLicenses } from "./licenseAlert";
import { ingestRakutenSales, ingestRakutenInventory, pumpRakuten } from "./ingestRakuten";
import { syncRakutenItems, pumpRakutenItems } from "./rakutenItems";
import { importAdFile, importAdUpload, adCoverage, adSummary, type ImportResult, type SummaryLevel } from "./ingestAds";
import { SETTINGS, settingsLog, resolveSettings, saveSettings, feeRate, recalcFeeEst, recalcAllFeeEst, type Scope } from "./settings";
import { parseChargeCsv, saveCharges, listCharges, isBillpay, parseBillpay, saveBillpay, monthStatus, type ChargeRow } from "./mallCharges";
import { decodeCsv, parseCsv } from "./adImport";
import { buildCaseSummary, periodSummary, dataRange, resolvePeriod } from "./caseSummary";
import { buildAdAdvice } from "./adAdvice";
import { renderCaseMarkdown } from "./caseReport";
import { postSlack, listCaseSlack, saveCaseSlack } from "./slack";
import { sendDailySummaries } from "./dailySummary";
import { listEvents, saveEvent, deleteEvent, setParticipation } from "./events";
import { listAllCases, createCase, renameCase, setCaseStatus, copySettings, setNotify, notifyEnabled } from "./cases";
import { setTodoStatus, doneInMonth, actionsBetween, skippedTodos, STATUS_JA, type TodoStatus } from "./todos";
import { queueAdsReports, queueDailyAds, pumpAdsReports, adsJobStatus } from "./adsApi";

/**
 * 画面とサーバーの版。画面（public/index.html の UI_VERSION）と食い違っていたら、
 * どちらかが古いままデプロイされている。変更のたびに両方を同じ値に上げる
 */
const APP_VERSION = "0.20.4";

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

  /* ───────── 案件の管理 ───────── */
  if (path === "/api/cases/all") return json({ cases: await listAllCases(env.DB) });

  if (path === "/api/cases/manage" && req.method === "POST") {
    const email = viewer(req);
    const b = (await req.json()) as { action?: string; caseId?: string; name?: string; status?: "active" | "archived"; from?: string;
      notify?: Record<string, boolean> };
    try {
      // 通知のオン・オフと設定のコピーは設定の変更なので全員ができる。追加・名前・休止は管理者だけ
      if (b.action === "notify" && b.caseId) {
        await setNotify(env.DB, b.caseId, b.notify ?? {}, email);
        return json({ ok: true, cases: await listAllCases(env.DB) });
      }
      if (b.action === "copySettings" && b.caseId && b.from) {
        const n = await copySettings(env.DB, b.from, b.caseId, email);
        await recalcAllFeeEst(env.DB);
        return json({ ok: true, changed: n, cases: await listAllCases(env.DB) });
      }
      const { isAdmin } = await ensureAdmin(env.DB, email);
      if (!isAdmin) return json({ error: "案件の追加・名前の変更・休止は管理者のみです" }, 403);
      if (b.action === "create" && b.name) {
        const id = await createCase(env.DB, b.name);
        return json({ ok: true, id, cases: await listAllCases(env.DB) });
      }
      if (b.action === "rename" && b.caseId && b.name) {
        await renameCase(env.DB, b.caseId, b.name);
        return json({ ok: true, cases: await listAllCases(env.DB) });
      }
      if (b.action === "status" && b.caseId && b.status) {
        await setCaseStatus(env.DB, b.caseId, b.status);
        return json({ ok: true, cases: await listAllCases(env.DB) });
      }
      return json({ error: "操作が不正です" }, 400);
    } catch (e) {
      return json({ error: String(e instanceof Error ? e.message : e) }, 400);
    }
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
             MAX(CASE WHEN l.mall = 'rakuten' THEN NULLIF(l.sku_id, '') END) AS rakuten_sku,
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

  /* 商品マスタ：画面から1件ずつ編集する／スプレッドシート用に書き出す */
  if (path === "/api/products/one") {
    const id = new URL(req.url).searchParams.get("id");
    const p = id ? (await readProducts(env.DB, { id }))[0] : null;
    return p ? json({ product: p }) : json({ error: "商品が見つかりません" }, 404);
  }
  if (path === "/api/products/save" && req.method === "POST") {
    const b = (await req.json()) as Record<string, string>;
    const r = await saveProduct(env.DB, b, viewer(req));
    if (r.errors) return json({ error: r.errors.join(" / "), errors: r.errors }, 400);
    await env.DB.prepare(`INSERT INTO ingests (id, case_id, kind, rows, status, source, error) VALUES (?, ?, 'products', 1, 'ok', 'manual', ?)`)
      .bind(crypto.randomUUID(), b.caseId ?? null, `${b.id ? "編集" : "追加"}：${b.sku}（${viewer(req) ?? "不明"}）`).run();
    return json({ ok: true, id: r.id });
  }
  if (path === "/api/products/delete" && req.method === "POST") {
    const b = (await req.json()) as { id?: string; caseId?: string; sku?: string };
    if (!b.id) return json({ error: "商品を指定してください" }, 400);
    try {
      await deleteProduct(env.DB, b.id);
      await env.DB.prepare(`INSERT INTO ingests (id, case_id, kind, rows, status, source, error) VALUES (?, ?, 'products', 1, 'ok', 'manual', ?)`)
        .bind(crypto.randomUUID(), b.caseId ?? null, `削除：${b.sku ?? b.id}（${viewer(req) ?? "不明"}）`).run();
      return json({ ok: true });
    } catch (e) {
      return json({ error: String(e instanceof Error ? e.message : e) }, 400);
    }
  }
  if (path === "/api/products/export") {
    const u = new URL(req.url);
    const caseId = u.searchParams.get("all") === "1" ? null : u.searchParams.get("case_id");
    return json(await exportSheet(env.DB, caseId));
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
      `SELECT date, COALESCE(SUM(units), 0) AS units, COALESCE(SUM(revenue), 0) AS revenue, COALESCE(SUM(sessions), 0) AS sessions,
              COALESCE(SUM(CASE WHEN mall = 'amazon' THEN revenue ELSE 0 END), 0) AS amazon,
              COALESCE(SUM(CASE WHEN mall = 'rakuten' THEN revenue ELSE 0 END), 0) AS rakuten
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

  // 楽天の過去の売上（ふだんは直近7日しか取らないので、接続したばかりの案件は一度これを動かす）
  if (path === "/api/backfill/rakuten" && req.method === "GET") {
    const caseId = new URL(req.url).searchParams.get("case_id");
    return json({ progress: caseId ? await rakutenBackfillStatus(env.DB, caseId) : null });
  }
  if (path === "/api/backfill/rakuten" && req.method === "POST") {
    const b = (await req.json().catch(() => ({}))) as { action?: "start" | "run"; caseId?: string; days?: number };
    if (!b.caseId) return json({ error: "案件を選んでください" }, 400);
    if (b.action === "start") {
      const m = await env.DB.prepare("SELECT 1 AS x FROM case_malls WHERE case_id = ? AND mall = 'rakuten' AND credentials_enc IS NOT NULL")
        .bind(b.caseId).first();
      if (!m) return json({ error: "この案件は楽天の接続情報が未登録です" }, 400);
      await startRakutenBackfill(env.DB, b.caseId, Number(b.days ?? 365), viewer(req));
    }
    await runRakutenBackfill(env, { caseId: b.caseId, budgetMs: 20000 });
    return json({ progress: await rakutenBackfillStatus(env.DB, b.caseId) });
  }

  // 取り込み済みの Amazon のデータを、今の商品マスタで照合し直す（マスタの SKU を直したあと）
  if (path === "/api/rematch" && req.method === "GET") {
    const caseId = new URL(req.url).searchParams.get("case_id");
    return json(caseId ? await rematchStatus(env.DB, caseId) : { running: false });
  }
  if (path === "/api/rematch" && req.method === "POST") {
    const b = (await req.json().catch(() => ({}))) as { caseId?: string; action?: "start" | "run" };
    if (!b.caseId) return json({ error: "案件を選んでください" }, 400);
    if (b.action === "start") await startRematch(env.DB, b.caseId);
    await runRematch(env, { caseId: b.caseId, budgetMs: 20000 });
    return json(await rematchStatus(env.DB, b.caseId));
  }

  /* ───────── 請求明細（実額） ───────── */

  if (path === "/api/charges" && req.method === "GET") {
    const u = new URL(req.url);
    const caseId = u.searchParams.get("case_id");
    const month = u.searchParams.get("month") ?? jstDate(1).slice(0, 7);
    if (!caseId) return json({ charges: [] });
    return json({ month, charges: await listCharges(env.DB, caseId, month),
      status: { rakuten: await monthStatus(env.DB, caseId, "rakuten", month), amazon: await monthStatus(env.DB, caseId, "amazon", month) } });
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

    // 楽天の「請求・支払明細」（Shop_Billpay.csv）はそのまま読む。月は行ごとの精算対象期間で決まるので、対象月の指定は使わない
    const table = parseCsv(decodeCsv(bytes));
    if (table.length && isBillpay(table)) {
      if (mall !== "rakuten") return json({ saved: false, message: "楽天の請求・支払明細です。モールを「楽天」にして入れてください" });
      const b = parseBillpay(table, file.name);
      if (!b.ok) return json({ saved: false, message: b.message });
      const r2Key = `raw/rakuten/charges/${caseId}/billpay_${b.statementNo}.csv`;
      await env.FILES.put(r2Key, bytes, { httpMetadata: { contentType: "text/csv" } });
      const months = await saveBillpay(env, caseId, mall, b, r2Key);
      return json({ saved: true, format: "billpay", fileName: file.name, statementNo: b.statementNo, shop: b.shop, issued: b.issued,
        rows: b.rows.length, taxDiff: b.taxDiff, payments: b.payments, months,
        message: `${b.shop}／発行 ${b.issued}／${b.rows.length}行を ${b.months.join("・")} に振り分けました` });
    }

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
    const changes = await saveSettings(env.DB, b.scope, b.scopeId ?? "", b.values ?? {}, viewer(req));
    // 誰が・何を・いくつからいくつに変えたかを Slack に残す（制限ではなく見える化で防ぐ）
    const noticeCase = b.scope === "company" ? null : (b.scopeId ?? "").split(":")[0];
    if (changes.length && (!noticeCase || await notifyEnabled(env.DB, noticeCase, "settings_notice"))) {
      const caseId = noticeCase;
      const fmt = (v: number | null, unit: string) => (v == null ? "（上の階層に従う）" : `${v}${unit === "percent" ? "%" : "日"}`);
      const where = b.scope === "company" ? "会社共通" : b.scope === "case" ? "案件" : `案件×${(b.scopeId ?? "").endsWith(":rakuten") ? "楽天" : "Amazon"}`;
      await postSlack(env, caseId, [`:gear: *設定が変更されました*（${where}／${viewer(req) ?? "不明なユーザー"}）`,
        ...changes.map((c) => `• ${c.label}：${fmt(c.old, c.unit)} → ${fmt(c.new, c.unit)}`)].join("\n")).catch(() => null);
    }

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
    return json({ ok: true, recalculated, changed: changes.length });
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

  // 月次確定（明細ベース）：セラーセントラルの日付範囲レポートと同じ並びで、その月の入金明細をまとめる。
  // 新旧2つの日付の数え方を並べて返す（切り替え前に一致を確かめるため）。横に注文日ベースの同じ月も
  if (path === "/api/monthly/amazon") {
    const u = new URL(req.url);
    const caseId = u.searchParams.get("case_id");
    const month = u.searchParams.get("month") ?? jstDate(1).slice(0, 7);
    if (!caseId || !/^\d{4}-\d{2}$/.test(month)) return json({ error: "案件と月を指定してください" }, 400);
    const active = await feeBasis(env.DB);
    const posted = await monthlyStatement(env.DB, caseId, month, "posted");
    const release = await monthlyStatement(env.DB, caseId, month, "release");
    const st = active === "posted" ? posted : release;
    const last = `${month}-${String(st.days).padStart(2, "0")}`;
    const daily = await periodSummary(env.DB, caseId, `${month}-01`, last);
    const amz = daily.byMall.find((m) => m.mall === "amazon") ?? null;
    return json({ ...st, active, other: active === "posted" ? release : posted,
      orderBasis: amz ? { revenue: amz.revenue, units: amz.units, cost: amz.cost, gross: amz.gross } : null,
      otherFees: daily.otherFees, closed: last < jstDate(1) });
  }

  // 調べもの用：新しい入金明細（出荷日ベース）で、同じ注文が2つの日に入っていないかを見る（読み取りだけ）
  if (path === "/api/debug/tx-dupes") {
    const u = new URL(req.url);
    const key = u.searchParams.get("case") ?? u.searchParams.get("case_id") ?? "";
    const month = u.searchParams.get("month") ?? jstDate(1).slice(0, 7);
    const cs = await env.DB.prepare("SELECT id FROM cases WHERE id = ? OR name = ?").bind(key, key).first<{ id: string }>();
    if (!cs) return json({ error: "case に案件名か ID を指定してください" }, 400);
    const caseId = cs.id;
    const from = `${month}-01`, to = `${month}-31`;
    const { results: dup } = await env.DB.prepare(
      `SELECT order_id, GROUP_CONCAT(DISTINCT date) AS dates, COUNT(DISTINCT date) AS days, SUM(amount) AS principal, MAX(deferred) AS anyDeferred
         FROM fee_events WHERE case_id = ? AND mall = 'amazon' AND basis = 'posted' AND event_type = 'shipment'
          AND kind = 'charge' AND name = 'Principal' AND order_id IS NOT NULL AND date BETWEEN date(?, '-15 days') AND date(?, '+15 days')
        GROUP BY order_id HAVING COUNT(*) > 1 ORDER BY order_id LIMIT 20`
    ).bind(caseId, from, to).all();
    const { results: kinds } = await env.DB.prepare(
      `SELECT event_type, kind, name, deferred, COUNT(*) AS n, SUM(amount) AS amount FROM fee_events
        WHERE case_id = ? AND mall = 'amazon' AND basis = 'posted' AND date BETWEEN ? AND ?
        GROUP BY event_type, kind, name, deferred ORDER BY n DESC LIMIT 40`
    ).bind(caseId, from, to).all();
    // 重なっている注文が入っている日の生データから、その注文の取引だけを抜き出す
    const samples: unknown[] = [];
    const first = dup[0] as { order_id?: string; dates?: string } | undefined;
    if (first?.order_id) {
      for (const d of String(first.dates ?? "").split(",").slice(0, 3)) {
        const obj = await env.FILES.get(`raw/amazon/transactions/${caseId}/${d}.json`);
        if (!obj) continue;
        const list = (await obj.json()) as Array<{ relatedIdentifiers?: Array<{ relatedIdentifierValue?: string }> }>;
        samples.push({ date: d, transactions: list.filter((t) => (t.relatedIdentifiers ?? []).some((r) => r.relatedIdentifierValue === first.order_id)) });
      }
    }
    return json({ month, duplicatedOrders: dup, rowsByKind: kinds, samples });
  }

  // 入金明細をどちらの日付で数えるか（管理者のみ）
  if (path === "/api/flags/fee-basis" && req.method === "POST") {
    const email = viewer(req);
    const { isAdmin } = await ensureAdmin(env.DB, email);
    if (!isAdmin) return json({ error: "切り替えは管理者のみです" }, 403);
    const b = (await req.json().catch(() => ({}))) as { value?: string };
    const value = b.value === "posted" ? "posted" : "release";
    await env.DB.prepare(
      `INSERT INTO app_flags (key, value, updated_by) VALUES ('amazon_fee_basis', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = datetime('now')`
    ).bind(value, email).run();
    return json({ ok: true, value });
  }

  // 新しい入金明細（出荷日ベース）を今すぐ進める。caseId と date を渡すとその日だけ取り直す
  if (path === "/api/ingest/transactions" && req.method === "POST") {
    const b = (await req.json().catch(() => ({}))) as { caseId?: string; date?: string };
    if (b.caseId && b.date) return json(await ingestTransactionsDay(env, b.caseId, b.date));
    return json({ done: await pumpTransactions(env, { budgetMs: 25000, caseId: b.caseId }) });
  }

  // 日別の販売数・売上を「出荷日ベース」で（Amazon は新しい入金明細、楽天は注文日のまま）
  if (path === "/api/sales/posted") {
    const u = new URL(req.url);
    const from = u.searchParams.get("from") ?? jstDate(14);
    const to = u.searchParams.get("to") ?? jstDate(1);
    return json({ from, to, ...(await postedDaily(env.DB, u.searchParams.get("case_id"), from, to)) });
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
    const am = st.case.find((x) => x.key === "ad_profit_margin")?.effective ?? 10;
    return json({ ...(await buildAdAdvice(env.DB, caseId, per.from, per.to, am)), adMargin: am });
  }

  if (path === "/api/dashboard") {
    const u = new URL(req.url);
    const caseId = u.searchParams.get("case_id");
    if (!caseId) return json({ error: "案件を指定してください" }, 400);
    // 画面はモール別に切り替えて見るので、商品は多めに返す（AI用のコピーは上位15件のまま）
    const s = await buildCaseSummary(env.DB, caseId, periodQuery(u), { productLimit: 80 });
    if (!s) return json({ error: "案件が見つかりません" }, 404);
    return json(s);
  }

  // 月次推移（直近12か月）：売上・粗利・広告費・広告経由売上をモール別に
  if (path === "/api/monthly-trend") {
    const u = new URL(req.url);
    const caseId = u.searchParams.get("case_id");
    if (!caseId) return json({ error: "案件を指定してください" }, 400);
    return json({ months: await monthlyTrend(env.DB, caseId, Math.min(24, Number(u.searchParams.get("months") ?? 12))) });
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
        results.push(...(await importAdUpload(env, caseId, entry.name, await entry.arrayBuffer())));
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

  // 外のプログラムから広告レポートを送り込む入口（楽天RPPの自動ダウンロード用）。
  // Cloudflare Access のサービストークンで通す。案件は名前か ID で指定する
  if (path === "/api/import/ads/push" && req.method === "POST") {
    const form = await req.formData();
    const key = String(form.get("case") ?? "").trim();
    const c = await env.DB.prepare("SELECT id, name FROM cases WHERE id = ? OR name = ?").bind(key, key)
      .first<{ id: string; name: string }>();
    if (!c) return json({ error: `案件「${key}」が見つかりません（アプリに登録した案件名と同じにしてください）` }, 404);
    const results: ImportResult[] = [];
    const billpay: Array<Record<string, unknown>> = [];
    for (const entry of form.getAll("files")) {
      if (!(entry instanceof File)) continue;
      // 楽天の「請求・支払明細」（Shop_Billpay.csv）も同じ入口で受け取る。
      // 担当者の Playwright が RMS から落として送れば、請求明細の取り込みも自動になる（Cloudflare 側の設定変更は不要）
      if (/\.csv$/i.test(entry.name)) {
        const bytes = await entry.arrayBuffer();
        const table = parseCsv(decodeCsv(bytes));
        if (table.length && isBillpay(table)) {
          const b = parseBillpay(table, entry.name);
          if (!b.ok) { billpay.push({ fileName: entry.name, ok: false, message: b.message }); continue; }
          const r2Key = `raw/rakuten/charges/${c.id}/billpay_${b.statementNo}.csv`;
          await env.FILES.put(r2Key, bytes, { httpMetadata: { contentType: "text/csv" } });
          const months = await saveBillpay(env, c.id, "rakuten", b, r2Key);
          billpay.push({ fileName: entry.name, ok: true, statementNo: b.statementNo, months, taxDiff: b.taxDiff });
          continue;
        }
      }
      try {
        results.push(...(await importAdUpload(env, c.id, entry.name, await entry.arrayBuffer())));
      } catch (e) {
        results.push({ fileName: entry.name, ok: false, mall: "", level: "", periodStart: "", periodEnd: "", rows: 0, unknown: [],
          message: `読み込みに失敗：${String(e instanceof Error ? e.message : e)}` });
      }
    }
    if (billpay.length && !results.length) {
      const bad = billpay.filter((x) => !x.ok);
      if (bad.length) await postSlack(env, c.id, `:warning: 楽天の請求・支払明細の自動取り込みで ${bad.length}件 失敗しました\n${bad.map((x) => `• ${x.fileName}：${x.message}`).join("\n")}`).catch(() => null);
      return json({ case: c.name, ok: bad.length === 0, billpay });
    }
    const ng = results.filter((r) => !r.ok);
    await env.DB.prepare(`INSERT INTO ingests (id, case_id, mall, kind, rows, status, error, source) VALUES (?, ?, 'rakuten', 'ads_push', ?, ?, ?, 'push')`)
      .bind(crypto.randomUUID(), c.id, results.reduce((t, r) => t + r.rows, 0), ng.length ? "error" : "ok",
        ng.length ? ng.map((r) => `${r.fileName}: ${r.message}`).join(" / ").slice(0, 500) : null).run();
    if (ng.length) await postSlack(env, c.id, `:warning: 楽天RPPレポートの自動取り込みで ${ng.length}件 失敗しました\n${ng.slice(0, 5).map((r) => `• ${r.fileName}：${r.message}`).join("\n")}`).catch(() => null);
    return json({ case: c.name, ok: ng.length === 0, results, ...(billpay.length ? { billpay } : {}) });
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
    const b = (await req.json().catch(() => ({}))) as { caseId?: string };
    const who = viewer(req) ?? "不明なユーザー";
    const r = await postSlack(env, b.caseId ?? null, `:white_check_mark: モール横断ダッシュボードからのテスト送信です（${who}／${todayJst()}）`);
    return json({ ok: r.ok, message: r.ok
      ? `送信しました（${r.where === "case" ? "案件のチャンネル" : "全体のチャンネル"}）。Slack を確認してください` : r.message });
  }

  // 日次サマリを今すぐ送る（確認用）
  if (path === "/api/slack/daily" && req.method === "POST") {
    const b = (await req.json().catch(() => ({}))) as { caseId?: string };
    const results = await sendDailySummaries(env, b.caseId);
    return json({ ok: results.every((r) => r.ok), results });
  }

  /* ───────── セール・イベント ───────── */

  if (path === "/api/events" && req.method === "GET") {
    const u = new URL(req.url);
    const caseId = u.searchParams.get("case_id");
    if (!caseId) return json({ events: [] });
    const from = u.searchParams.get("from") ?? "2000-01-01", to = u.searchParams.get("to") ?? "2100-12-31";
    return json({ events: await listEvents(env.DB, caseId, from, to) });
  }
  if (path === "/api/events" && req.method === "POST") {
    const b = (await req.json()) as Record<string, unknown> & { action?: string };
    try {
      if (b.action === "delete") { await deleteEvent(env.DB, String(b.id)); return json({ ok: true }); }
      if (b.action === "participation") {
        await setParticipation(env.DB, String(b.caseId), String(b.eventId), Boolean(b.participating), viewer(req));
        return json({ ok: true });
      }
      const id = await saveEvent(env.DB, b as Parameters<typeof saveEvent>[1], viewer(req));
      return json({ ok: true, id });
    } catch (e) {
      return json({ error: String(e instanceof Error ? e.message : e) }, 400);
    }
  }

  /* ───────── 週次レポート ───────── */

  // レポートに載せる数字をまとめて返す。Excel と PDF は画面側で作る（Worker の処理時間を使わないため）
  if (path === "/api/report") {
    const u = new URL(req.url);
    const caseId = u.searchParams.get("case_id");
    if (!caseId) return json({ error: "案件を指定してください" }, 400);
    const s = await buildCaseSummary(env.DB, caseId, periodQuery(u), { trackTodos: false, productLimit: 200 });
    if (!s) return json({ error: "案件が見つかりません" }, 404);
    const st = await resolveSettings(env.DB, { caseId, mall: "amazon" });
    const am = st.case.find((x) => x.key === "ad_profit_margin")?.effective ?? 10;
    const adv = await buildAdAdvice(env.DB, caseId, s.period.from, s.period.to, am);
    return json({
      summary: s,
      actions: await actionsBetween(env.DB, caseId, s.period.from, s.period.to),
      advice: { bids: adv.bids.slice(0, 30), negatives: adv.negatives.slice(0, 30), harvest: adv.harvest.slice(0, 20),
        budgets: adv.budgets, impact: adv.impact, assumptions: adv.assumptions },
    });
  }

  /* ───────── 要対応の状態 ───────── */

  if (path === "/api/todo" && req.method === "POST") {
    const b = (await req.json()) as { caseId?: string; key?: string; status?: TodoStatus; text?: string; basis?: string;
      area?: string; priority?: string; note?: string };
    if (!b.caseId || !b.key || !b.status) return json({ error: "案件・項目・状態を指定してください" }, 400);
    try {
      await setTodoStatus(env.DB, b.caseId, { key: b.key, status: b.status, text: b.text, basis: b.basis ?? null,
        area: b.area, priority: b.priority, note: b.note?.trim() || null }, viewer(req));
      return json({ ok: true, status: b.status, label: STATUS_JA[b.status] });
    } catch (e) {
      return json({ error: String(e instanceof Error ? e.message : e) }, 400);
    }
  }

  // ある月に対応したこと（お客様向けレポートの素材）
  if (path === "/api/todo/done") {
    const u = new URL(req.url);
    const caseId = u.searchParams.get("case_id");
    if (!caseId) return json({ items: [] });
    const month = u.searchParams.get("month") ?? todayJst().slice(0, 7);
    return json({ month, items: await doneInMonth(env.DB, caseId, month), skipped: await skippedTodos(env.DB, caseId) });
  }

  // 設定の変更履歴
  if (path === "/api/settings/log") {
    return json({ log: await settingsLog(env.DB, 50) });
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
          ? `期限が近いものが ${r.count} 件ありますが、Slack の送り先（案件のチャンネルか全体の SLACK_WEBHOOK_URL）が無いため送れません`
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
          ? `対象が ${r.count} 件ありますが、Slack の送り先（案件のチャンネルか全体の SLACK_WEBHOOK_URL）が無いため送れません`
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

    // 案件ごとの Slack 通知先
    if (path === "/api/connections/slack" && req.method === "GET") {
      if (!isAdmin) return json({ error: "forbidden" }, 403);
      return json(await listCaseSlack(env));
    }
    if (path === "/api/connections/slack" && req.method === "POST") {
      if (!isAdmin) return json({ error: "forbidden" }, 403);
      const b = (await req.json()) as { caseId?: string; webhook?: string; channel?: string; dailySummary?: boolean };
      if (!b.caseId) return json({ error: "案件を指定してください" }, 400);
      try {
        await saveCaseSlack(env, b.caseId, { webhook: b.webhook, channel: b.channel, dailySummary: b.dailySummary }, email);
        return json({ ok: true, ...(await listCaseSlack(env)) });
      } catch (e) {
        return json({ error: String(e instanceof Error ? e.message : e) }, 400);
      }
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

/**
 * 楽天RPPのレポートが今朝届いたか。送り込みを使っている案件（直近14日に1度でも届いた案件）だけを見る
 */
/** D1 の UTC 時刻（"YYYY-MM-DD HH:MM:SS"）を日本時間の「M/D HH:MM」にする */
function jstStamp(utc: string): string {
  const d = new Date(Date.parse(utc.replace(" ", "T") + "Z") + 9 * 3600 * 1000);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

async function checkRppPush(env: Env): Promise<void> {
  const { results } = await env.DB.prepare(
    `SELECT c.id, c.name,
            (SELECT MAX(created_at) FROM ingests i WHERE i.case_id = c.id AND i.kind = 'ads_push') AS last
       FROM cases c
      WHERE c.status = 'active'
        AND EXISTS (SELECT 1 FROM ingests i WHERE i.case_id = c.id AND i.kind = 'ads_push' AND i.created_at >= datetime('now', '-14 days'))`
  ).all<{ id: string; name: string; last: string | null }>();
  // 今日（日本時間）の0時を UTC にしたもの
  const todayStartUtc = new Date(Date.parse(`${todayJst()}T00:00:00+09:00`)).toISOString().slice(0, 19).replace("T", " ");
  for (const c of results) {
    if (c.last && c.last >= todayStartUtc) continue;
    await postSlack(env, c.id, `:warning: 今日の楽天RPPレポート（前日分）がまだ届いていません（最後に届いたのは ${c.last ? jstStamp(c.last) : "—"}）。` +
      `ダウンロードするプログラムが止まっていないか確認してください`).catch(() => null);
  }
}

/** 画面から来る期間の指定（preset か from/to） */
function periodQuery(u: URL) {
  return { preset: u.searchParams.get("preset"), from: u.searchParams.get("from"), to: u.searchParams.get("to") };
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
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
    // 楽天RPPのレポートは、楽天の仕様で前日分が翌日12時ごろに外のプログラムから届く。
    // 14時になっても今日の分が届いていなければ知らせる（重い日次バッチは動かさない）
    if (event.cron === "0 5 * * *") {
      ctx.waitUntil(checkRppPush(env));
      return;
    }
    if (event.cron === "*/5 * * * *") {
      ctx.waitUntil(
        (async () => {
          // 入金明細の読み方を変えた日（ポイントの費用を読むようにした等）を、R2 の生データから読み直す
          await reparseFinances(env, 40).catch(() => 0);
          // 新しい入金明細（出荷日ベース）。直近14日は毎日取り直し、古い日は少しずつ埋める
          await pumpTransactions(env, { budgetMs: 60000 }).catch(() => 0);
          // 楽天の過去の売上（始めた案件だけ）
          await runRakutenBackfill(env, { budgetMs: 40000 }).catch(() => 0);
          // 商品マスタを直したあとの照合し直し（日次売上をレポートの生データから作り直す）
          await runRematch(env, { budgetMs: 40000 }).catch(() => 0);
          // 広告レポートは出来上がるまで数分〜数十分かかるので、ここで少しずつ取りに行く
          const ads = await env.DB
            .prepare("SELECT COUNT(*) AS n FROM ads_report_jobs WHERE status IN ('queued', 'requested')")
            .first<{ n: number }>();
          if (ads?.n) await pumpAdsReports(env, { budgetMs: 60000 });
          const pending = await env.DB
            .prepare("SELECT COUNT(*) AS n FROM backfill WHERE status = 'running' OR (kind = 'traffic' AND cursor IS NOT NULL AND cursor >= from_date)")
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
        // 楽天。売上と在庫をまとめて取り込む。
        // 後からのキャンセル・数量の変更を拾うため、売上は直近60日を毎日取り直す（注文番号の検索＋明細100件ずつなので軽い）
        await pumpRakuten(env, { days: 60 });
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
        // 日次サマリは7時の実行で送る。6時の実行で依頼したレポート（セッション数など）が揃ってから
        if (event.cron === "0 22 * * *") await sendDailySummaries(env);
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
