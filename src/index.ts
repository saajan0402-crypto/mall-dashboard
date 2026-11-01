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
import { feeLabel, isKnownFee } from "./feeNames";
import { ingestInventory, pumpInventory, inventoryStatus, notifyInventory } from "./ingestInventory";
import { ingestSns, pumpSns } from "./ingestSns";
import { startBackfill, runBackfill, backfillStatus } from "./backfill";

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

  if (path === "/api/me") return json({ email: viewer(req) });

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
             (SELECT unit_cost FROM cost_history h WHERE h.product_id = p.id
               ORDER BY h.effective_from DESC LIMIT 1) AS unit_cost
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
        ORDER BY s.date DESC, p.sku`
    )
      .bind(...(caseId ? [from, to, caseId] : [from, to]))
      .all();

    // 日ごとの合計もここで出す。画面側で足し算させない
    const byDate = new Map<string, { date: string; units: number; revenue: number; sessions: number }>();
    for (const r of results as Array<Record<string, number | string | null>>) {
      const d = String(r.date);
      const agg = byDate.get(d) ?? { date: d, units: 0, revenue: 0, sessions: 0 };
      agg.units += Number(r.units ?? 0);
      agg.revenue += Number(r.revenue ?? 0);
      agg.sessions += Number(r.sessions ?? 0);
      byDate.set(d, agg);
    }
    return json({ from, to, rows: results, daily: [...byDate.values()].sort((a, b) => (a.date < b.date ? 1 : -1)) });
  }

  // 月次のまとめ。手数料の実額が入っている分はそれを使い、無い日は概算で埋める
  if (path === "/api/summary") {
    const u = new URL(req.url);
    const caseId = u.searchParams.get("case_id");
    const month = u.searchParams.get("month") ?? jstDate(1).slice(0, 7);
    const from = `${month}-01`;
    const to = `${month}-31`;
    if (!caseId) return json({ error: "案件を指定してください" }, 400);

    const sales = await env.DB.prepare(
      `SELECT
         COALESCE(SUM(s.units), 0)   AS units,
         COALESCE(SUM(s.revenue), 0) AS revenue,
         COALESCE(SUM(s.returns), 0) AS returns,
         COALESCE(SUM(COALESCE(
           (SELECT unit_cost FROM cost_history h
             WHERE h.product_id = s.product_id AND h.effective_from <= s.date
             ORDER BY h.effective_from DESC LIMIT 1),
           (SELECT unit_cost FROM cost_history h
             WHERE h.product_id = s.product_id ORDER BY h.effective_from ASC LIMIT 1),
           0) * s.units), 0) AS cost,
         COALESCE(SUM(COALESCE(s.fee_actual, s.fee_est)), 0) AS fees,
         SUM(CASE WHEN s.fee_actual IS NULL THEN 1 ELSE 0 END) AS rows_without_actual,
         COUNT(*) AS rows_total
       FROM daily_sales s
      WHERE s.case_id = ? AND s.mall = 'amazon' AND s.date BETWEEN ? AND ?`
    )
      .bind(caseId, from, to)
      .first<Record<string, number>>();

    // 商品に紐づかない費用（注文単位の手数料・月額登録料など）
    const other = await env.DB.prepare(
      `SELECT COALESCE(-SUM(amount), 0) AS amount FROM fee_events
        WHERE case_id = ? AND mall = 'amazon' AND date BETWEEN ? AND ?
          AND product_id IS NULL AND kind = 'fee'`
    )
      .bind(caseId, from, to)
      .first<{ amount: number }>();

    // 手数料の内訳。何にいくら取られているかを名前ごとに出す
    const { results: breakdownRaw } = await env.DB.prepare(
      `SELECT name, -SUM(amount) AS amount, COUNT(*) AS count FROM fee_events
        WHERE case_id = ? AND mall = 'amazon' AND date BETWEEN ? AND ?
          AND kind IN ('fee', 'promotion', 'tax_withheld')
        GROUP BY name ORDER BY amount DESC`
    )
      .bind(caseId, from, to)
      .all<{ name: string; amount: number; count: number }>();

    // 英語の識別子のままでは読めないので日本語を付ける。
    // Amazon のレポートと突き合わせられるよう、元の名前も一緒に返す
    const breakdown = breakdownRaw.map((b) => ({
      ...b, label: feeLabel(b.name), known: isKnownFee(b.name),
    }));

    const revenue = sales?.revenue ?? 0;
    const returns = sales?.returns ?? 0;
    const cost = sales?.cost ?? 0;
    const fees = sales?.fees ?? 0;
    const otherFees = other?.amount ?? 0;
    const gross = revenue - returns - cost - fees - otherFees;

    return json({
      month, caseId,
      units: sales?.units ?? 0,
      revenue, returns, cost, fees, otherFees, gross,
      grossRate: revenue ? Math.round((gross / revenue) * 1000) / 10 : null,
      // 損益分岐ROAS = 1 ÷ 広告費を除いた粗利率
      breakEvenRoas: revenue && gross > 0 ? Math.round((revenue / gross) * 100) / 100 : null,
      actual: { missing: sales?.rows_without_actual ?? 0, total: sales?.rows_total ?? 0 },
      breakdown,
    });
  }

  /* ───────── 過去データの取り込み ───────── */

  if (path === "/api/backfill" && req.method === "GET") {
    const caseId = new URL(req.url).searchParams.get("case_id") ?? undefined;
    return json({ progress: await backfillStatus(env, caseId) });
  }

  if (path === "/api/backfill" && req.method === "POST") {
    const b = (await req.json().catch(() => ({}))) as {
      caseId?: string; days?: number; action?: "start" | "run"; traffic?: boolean;
    };
    if (b.action === "start") {
      if (!b.caseId) return json({ error: "案件を選んでください" }, 400);
      try {
        return json({ progress: await startBackfill(env, b.caseId, b.days ?? 365, { traffic: b.traffic }) });
      } catch (e) {
        return json({ error: String(e instanceof Error ? e.message : e) }, 400);
      }
    }
    // 進める。画面から繰り返し呼ばれる
    return json(await runBackfill(env, { caseId: b.caseId, budgetMs: 48000 }));
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
      return json({ results: [await advance(env, b.caseId, date, { wait: true, maxWaitMs: 55000, force: true })] });
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
    const { results } = await env.DB.prepare(
      `SELECT id, case_id, mall, kind, rows, status, error, created_at
         FROM ingests ORDER BY created_at DESC LIMIT 50`
    ).all();
    return json({ ingests: results });
  }

  return json({ error: "not found", path }, 404);
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
    if (event.cron === "*/5 * * * *") {
      ctx.waitUntil(
        (async () => {
          const pending = await env.DB
            .prepare("SELECT COUNT(*) AS n FROM backfill WHERE status = 'running'")
            .first<{ n: number }>();
          if (!pending?.n) return;
          await runBackfill(env, { budgetMs: 240000 });
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
        await notifyInventory(env);
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
