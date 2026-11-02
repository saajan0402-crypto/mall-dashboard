/**
 * 楽天ライセンスキーの期限通知
 *
 * 楽天のライセンスキーは90日ごとに更新が必要で、切れると全APIが一斉に401になる。
 * 気づくのが切れた後だと、その日の売上も在庫も取り込めない。
 * 期限の2週間前から毎朝Slackに流して、更新を忘れないようにする。
 */

export interface LicenseEnv {
  DB: D1Database;
  SLACK_WEBHOOK_URL?: string;
}

export interface LicenseRow {
  caseId: string;
  caseName: string;
  expiresOn: string;
  daysLeft: number;
}

/** 期限が近い、または切れている鍵を返す */
export async function expiringLicenses(db: D1Database, withinDays = 14): Promise<LicenseRow[]> {
  const { results } = await db
    .prepare(
      `SELECT m.case_id, c.name AS case_name, m.license_expires_on
         FROM case_malls m JOIN cases c ON c.id = m.case_id
        WHERE m.mall = 'rakuten' AND c.status = 'active'
          AND m.license_expires_on IS NOT NULL
        ORDER BY m.license_expires_on`
    )
    .all<{ case_id: string; case_name: string; license_expires_on: string }>();

  const today = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const out: LicenseRow[] = [];
  for (const r of results) {
    const days = Math.round((Date.parse(r.license_expires_on) - Date.parse(today)) / 86400000);
    if (days <= withinDays) {
      out.push({ caseId: r.case_id, caseName: r.case_name, expiresOn: r.license_expires_on, daysLeft: days });
    }
  }
  return out;
}

/** 期限が近い鍵があれば Slack に流す */
export async function notifyLicenseExpiry(env: LicenseEnv): Promise<{ sent: boolean; count: number }> {
  const rows = await expiringLicenses(env.DB);
  if (!rows.length || !env.SLACK_WEBHOOK_URL) return { sent: false, count: rows.length };

  const lines = rows.map((r) => {
    if (r.daysLeft < 0) {
      return `:red_circle: *${r.caseName}* の楽天ライセンスキーは ${r.expiresOn} に期限が切れています（${-r.daysLeft}日経過）。更新するまで楽天のデータは取り込めません`;
    }
    if (r.daysLeft === 0) {
      return `:red_circle: *${r.caseName}* の楽天ライセンスキーは本日（${r.expiresOn}）が期限です`;
    }
    return `:warning: *${r.caseName}* の楽天ライセンスキーは ${r.expiresOn} に期限が切れます（あと${r.daysLeft}日）`;
  });

  await fetch(env.SLACK_WEBHOOK_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      text: [
        "*楽天ライセンスキーの期限*",
        ...lines,
        "RMS → 店舗様向け情報・サービス → WEB APIサービス → 利用設定 → アプリ一覧 から更新し、アプリの接続画面で登録し直してください。",
      ].join("\n"),
    }),
  });
  return { sent: true, count: rows.length };
}
