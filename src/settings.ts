/**
 * 案件ごとの設定
 *
 * 階層は 会社共通 → 案件 → 案件×モール。
 * 下の階層に値があればそれを使い、無ければ上を継承する。
 * 空欄は「継承する」の意味で、0 とは区別する。
 *
 * 料率は「構成の設定」なので、変えたら過去にさかのぼって計算し直す。
 * 変えた日以降だけ直すと、同じ月の中で基準が混ざって比較できなくなるため。
 */

export type Scope = "company" | "case" | "case_mall";
export type Mall = "amazon" | "rakuten";

export interface SettingDef {
  key: string;
  label: string;
  help: string;
  unit: "percent" | "days" | "toggle";
  fallback: number;
  scopes: Scope[];
  /** case_mall のとき、どのモールに出すか */
  malls?: Mall[];
  /** 手数料の概算に使う料率かどうか */
  isFeeRate?: boolean;
  /** unit が toggle のときの選択肢（値と表示）。無ければ オフ／オン */
  options?: Array<[number, string]>;
}

export const SETTINGS: SettingDef[] = [
  {
    key: "target_margin", label: "目標粗利率", unit: "percent", fallback: 30,
    help: "この値を下回る商品を注意として扱います", scopes: ["company", "case"],
  },
  {
    key: "ad_profit_margin", label: "広告費を引いた後の目標利益率", unit: "percent", fallback: 10,
    help: "広告の改善提案に使います。「利益重視」の商品は、広告費を引いた後にこの率が残るように入札を提案します（目標粗利率は広告費を引く前の基準）",
    scopes: ["company", "case"],
  },
  {
    key: "ai_weekly", label: "AI分析（Claude API）", unit: "toggle", fallback: 0,
    help: "広告とキーワード発見のデータを AI（Claude）が分析し、キーワード発見タブに提案を出します。API の利用料が1回あたり数十円かかります。「手動のみ」は、キーワード発見タブの「今すぐ分析する」を押したときだけ動きます（既定はオフ）",
    scopes: ["case"], options: [[0, "オフ"], [1, "毎週月曜＋手動"], [2, "手動のみ"]],
  },
  {
    key: "stock_alert_days", label: "在庫アラート日数", unit: "days", fallback: 14,
    help: "残り日数がこれを下回ると欠品間近として通知します", scopes: ["company", "case"],
  },

  /* Amazon の料率。入金明細が入るまでの概算に使う */
  {
    key: "fee_rate_commission", label: "販売手数料率", unit: "percent", fallback: 15,
    help: "カテゴリによって 8〜15%。入金明細が入った日は実額で上書きされます",
    scopes: ["case_mall"], malls: ["amazon"], isFeeRate: true,
  },
  {
    key: "fee_rate_fba", label: "配送代行手数料率", unit: "percent", fallback: 12,
    help: "FBAの配送代行手数料を売上に対する率で概算します",
    scopes: ["case_mall"], malls: ["amazon"], isFeeRate: true,
  },

  /* 楽天の料率。楽天には手数料のAPIが無いので、ここが唯一の手がかりになる */
  {
    key: "fee_rate_system", label: "システム利用料", unit: "percent", fallback: 3.5,
    help: "月間売上高に応じて 2.0〜4.5%。RMSの請求明細で確認できます",
    scopes: ["case_mall"], malls: ["rakuten"], isFeeRate: true,
  },
  {
    key: "fee_rate_payment", label: "決済手数料", unit: "percent", fallback: 3.0,
    help: "楽天ペイの決済手数料",
    scopes: ["case_mall"], malls: ["rakuten"], isFeeRate: true,
  },
  {
    key: "fee_rate_point", label: "ポイント原資", unit: "percent", fallback: 1.0,
    help: "店舗が負担するポイント分。SPUや倍率キャンペーンの負担も含めます",
    scopes: ["case_mall"], malls: ["rakuten"], isFeeRate: true,
  },
  {
    key: "fee_rate_affiliate", label: "アフィリエイト", unit: "percent", fallback: 2.6,
    help: "アフィリエイト経由の売上がある場合の平均負担率",
    scopes: ["case_mall"], malls: ["rakuten"], isFeeRate: true,
  },
  {
    key: "fee_rate_other", label: "その他の料率", unit: "percent", fallback: 0,
    help: "上記に含まれない費用をまとめて率で見るときに使います",
    scopes: ["case_mall"], malls: ["amazon", "rakuten"], isFeeRate: true,
  },
];

export interface SettingsEnv {
  DB: D1Database;
}

type Row = { scope: string; scope_id: string; key: string; value: string };

async function allSettings(db: D1Database): Promise<Row[]> {
  const { results } = await db
    .prepare("SELECT scope, scope_id, key, value FROM settings")
    .all<Row>();
  return results;
}

function num(v: string | undefined): number | null {
  if (v === undefined) return null;
  try {
    const n = Number(JSON.parse(v));
    return Number.isFinite(n) ? n : null;
  } catch {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
}

export interface ResolvedSetting {
  key: string;
  label: string;
  help: string;
  unit: string;
  /** その階層に実際に入っている値。空欄なら null（継承） */
  own: number | null;
  /** 継承した結果、実際に使われる値 */
  effective: number;
  /** どの階層の値が使われているか */
  from: "company" | "case" | "case_mall" | "既定";
  isFeeRate: boolean;
  options?: Array<[number, string]>;
}

/** 設定を階層をたどって解決する */
export async function resolveSettings(
  db: D1Database,
  opts: { caseId?: string; mall?: Mall } = {}
): Promise<{ company: ResolvedSetting[]; case: ResolvedSetting[]; caseMall: ResolvedSetting[] }> {
  const rows = await allSettings(db);
  const at = (scope: string, id: string, key: string) =>
    num(rows.find((r) => r.scope === scope && r.scope_id === id && r.key === key)?.value);

  const caseId = opts.caseId ?? "";
  const mall = opts.mall;
  const caseMallId = caseId && mall ? `${caseId}:${mall}` : "";

  const build = (scope: Scope, defs: SettingDef[]): ResolvedSetting[] =>
    defs.map((d) => {
      const company = at("company", "", d.key);
      const forCase = caseId ? at("case", caseId, d.key) : null;
      const forMall = caseMallId ? at("case_mall", caseMallId, d.key) : null;

      let effective = d.fallback;
      let from: ResolvedSetting["from"] = "既定";
      if (company !== null) { effective = company; from = "company"; }
      if (forCase !== null) { effective = forCase; from = "case"; }
      if (forMall !== null) { effective = forMall; from = "case_mall"; }

      const own = scope === "company" ? company : scope === "case" ? forCase : forMall;
      return {
        key: d.key, label: d.label, help: d.help, unit: d.unit, options: d.options,
        own, effective, from, isFeeRate: Boolean(d.isFeeRate),
      };
    });

  return {
    company: build("company", SETTINGS.filter((d) => d.scopes.includes("company"))),
    case: build("case", SETTINGS.filter((d) => d.scopes.includes("case"))),
    caseMall: mall
      ? build("case_mall", SETTINGS.filter((d) => d.scopes.includes("case_mall") && d.malls?.includes(mall)))
      : [],
  };
}

/** 保存。空欄（null）はその階層の値を消す＝上から継承する */
export interface SettingChange { key: string; label: string; unit: string; old: number | null; new: number | null }

/**
 * 設定を保存する。画面は同じ階層の値をまとめて送ってくるので、変わったものだけを書いて履歴に残す。
 * 戻り値は変わった項目（Slack への通知に使う）
 */
export async function saveSettings(
  db: D1Database,
  scope: Scope,
  scopeId: string,
  values: Record<string, number | null>,
  by: string | null
): Promise<SettingChange[]> {
  const { results: cur } = await db.prepare("SELECT key, value FROM settings WHERE scope = ? AND scope_id = ?")
    .bind(scope, scopeId).all<{ key: string; value: string }>();
  const before = new Map(cur.map((r) => [r.key, Number(JSON.parse(r.value))]));
  const caseId = scope === "company" ? null : scopeId.split(":")[0];
  const caseName = caseId
    ? (await db.prepare("SELECT name FROM cases WHERE id = ?").bind(caseId).first<{ name: string }>())?.name ?? null : null;

  const statements: D1PreparedStatement[] = [];
  const changes: SettingChange[] = [];
  for (const [key, value] of Object.entries(values)) {
    const def = SETTINGS.find((d) => d.key === key);
    if (!def) continue;                                         // 知らないキーは入れない
    const old = before.has(key) ? before.get(key)! : null;
    if (old === value || (old == null && value == null)) continue;   // 変わっていない
    if (value === null) {
      statements.push(
        db.prepare("DELETE FROM settings WHERE scope = ? AND scope_id = ? AND key = ?")
          .bind(scope, scopeId, key)
      );
    } else {
      statements.push(
        db.prepare(
          `INSERT INTO settings (scope, scope_id, key, value, updated_by)
           VALUES (?,?,?,?,?)
           ON CONFLICT(scope, scope_id, key)
           DO UPDATE SET value = excluded.value, updated_at = datetime('now'), updated_by = excluded.updated_by`
        ).bind(scope, scopeId, key, JSON.stringify(value), by)
      );
    }
    statements.push(
      db.prepare(
        `INSERT INTO settings_log (id, scope, scope_id, key, old_value, new_value, changed_by, case_name)
         VALUES (?,?,?,?,?,?,?,?)`
      ).bind(crypto.randomUUID(), scope, scopeId, key,
        old == null ? "(継承)" : String(old), value === null ? "(継承)" : String(value), by, caseName)
    );
    changes.push({ key, label: def.label, unit: def.unit, old, new: value });
  }
  if (statements.length) await db.batch(statements);
  return changes;
}

/** 設定の変更履歴（新しい順） */
export async function settingsLog(db: D1Database, limit = 50) {
  const { results } = await db.prepare(
    `SELECT scope, scope_id, key, old_value, new_value, changed_by, changed_at, case_name
       FROM settings_log ORDER BY changed_at DESC LIMIT ?`
  ).bind(limit).all<Record<string, string | null>>();
  return results.map((r) => ({
    ...r,
    label: SETTINGS.find((d) => d.key === r.key)?.label
      ?? (String(r.key).startsWith("connection:") ? `接続情報（${String(r.key).endsWith("rakuten") ? "楽天" : "Amazon"}）` : r.key),
    where: r.scope === "company" ? "会社共通"
      : r.scope === "case" ? (r.case_name ?? r.scope_id)
      : `${r.case_name ?? String(r.scope_id).split(":")[0]}／${String(r.scope_id).endsWith(":rakuten") ? "楽天" : "Amazon"}`,
  }));
}

/* ───────── 手数料の概算 ───────── */

/** 案件×モールの合計料率（%） */
export async function feeRate(db: D1Database, caseId: string, mall: Mall): Promise<number> {
  const r = await resolveSettings(db, { caseId, mall });
  return r.caseMall.filter((s) => s.isFeeRate).reduce((n, s) => n + s.effective, 0);
}

/**
 * 日次売上の概算手数料を計算し直す。
 * 料率は「構成の設定」なので、過去にさかのぼって全期間を直す
 */
export async function recalcFeeEst(db: D1Database, caseId: string, mall: Mall): Promise<number> {
  const rate = await feeRate(db, caseId, mall);
  // 楽天は、料率に楽天RSLの物流費（商品マスタの暫定値 × 販売数）を足す。
  // 料率には物流費が入っていないので、RSLを使う商品は請求明細がそろうまで粗利が高く出すぎるため。
  // 請求明細がそろった月は fee_actual（実額の按分）が優先されるので、この暫定値は使われなくなる
  const rsl = mall === "rakuten"
    ? ` + units * COALESCE((SELECT CAST(value AS INTEGER) FROM settings st
          WHERE st.scope = 'listing' AND st.scope_id = daily_sales.product_id AND st.key = 'rsl_fee'), 0)`
    : "";
  const r = await db
    .prepare(
      `UPDATE daily_sales SET fee_est = CAST(ROUND(revenue * ? / 100.0) AS INTEGER)${rsl}
        WHERE case_id = ? AND mall = ?`
    )
    .bind(rate, caseId, mall)
    .run();
  return (r.meta as { changes?: number })?.changes ?? 0;
}

/** 全案件×全モールぶん */
export async function recalcAllFeeEst(db: D1Database): Promise<number> {
  const { results } = await db
    .prepare("SELECT DISTINCT case_id, mall FROM daily_sales")
    .all<{ case_id: string; mall: Mall }>();
  let total = 0;
  for (const r of results) total += await recalcFeeEst(db, r.case_id, r.mall);
  return total;
}
