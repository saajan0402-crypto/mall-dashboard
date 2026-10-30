/**
 * モール横断パフォーマンス管理ツール
 *
 * 構成の原則（要件定義 §14 より）
 *   - 数える・計算する処理はこのコードが行う。金額は必ずここで確定させる
 *   - 読む・書く・判断する処理だけを Claude API に渡す
 *   - モールへ書き込む経路は作らない。データは取り込み方向の一方向のみ
 */

import { parseProductSheet, importProducts } from "./importProducts";
import { ensureAdmin, addAdmin, listConnections, saveConnection, testConnection, FIELDS, type Mall } from "./connections";

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

  /* ───────── 接続情報（管理者のみ） ───────── */

  if (path.startsWith("/api/connections")) {
    const email = viewer(req);
    const { admins, isAdmin } = await ensureAdmin(env.DB, email);

    if (path === "/api/connections" && req.method === "GET") {
      if (!isAdmin) return json({ error: "forbidden", admins }, 403);
      return json({ ...(await listConnections(env) as object), fields: FIELDS, admins, me: email });
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

    if (path === "/api/connections/admins" && req.method === "POST") {
      if (!isAdmin) return json({ error: "forbidden" }, 403);
      const b = (await req.json()) as { email: string };
      return json({ admins: await addAdmin(env.DB, b.email.trim(), email) });
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
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        const id = crypto.randomUUID();
        await env.DB.prepare(
          "INSERT INTO ingests (id, kind, status, rows, source) VALUES (?, 'scheduled', 'ok', 0, 'api')"
        )
          .bind(id)
          .run();
      })()
    );
  },
};
