-- Amazon Ads API のレポート依頼。依頼 → 数分〜数十分待つ → 取得 → 保存 の順に進む
CREATE TABLE IF NOT EXISTS ads_report_jobs (
  id           TEXT PRIMARY KEY,
  case_id      TEXT NOT NULL REFERENCES cases(id),
  profile_id   TEXT NOT NULL,
  report_key   TEXT NOT NULL,           -- sp_campaign / sp_search_term など
  start_date   TEXT NOT NULL,
  end_date     TEXT NOT NULL,
  purpose      TEXT NOT NULL DEFAULT 'daily',   -- daily / backfill / manual
  status       TEXT NOT NULL DEFAULT 'queued',  -- queued / requested / imported / error
  report_id    TEXT,
  rows         INTEGER,
  attempts     INTEGER NOT NULL DEFAULT 0,
  error        TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ads_jobs_status ON ads_report_jobs(status, created_at);
CREATE INDEX IF NOT EXISTS idx_ads_jobs_case ON ads_report_jobs(case_id, created_at);
