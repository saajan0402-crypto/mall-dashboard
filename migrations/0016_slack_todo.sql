-- 案件ごとの Slack 通知先。Webhook URL は鍵と同じ扱いなので暗号化して持つ
CREATE TABLE IF NOT EXISTS case_slack (
  case_id       TEXT PRIMARY KEY REFERENCES cases(id),
  webhook_enc   TEXT,
  channel       TEXT,                         -- 表示用（#xxx）。送り先は Webhook で決まる
  daily_summary INTEGER NOT NULL DEFAULT 1,   -- 毎朝の日次サマリを送るか
  updated_by    TEXT,
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 要対応の状態（未対応／対応済み／今はしない）。要対応はその都度計算し直すので、
-- 項目ごとに決まった鍵（key）で状態を結びつける
CREATE TABLE IF NOT EXISTS todo_status (
  case_id    TEXT NOT NULL REFERENCES cases(id),
  key        TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'open',   -- open / done / skip
  title      TEXT,
  basis      TEXT,
  area       TEXT,
  priority   TEXT,
  note       TEXT,
  updated_by TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen  TEXT,                           -- 最後に要対応として出た日（JST）
  PRIMARY KEY (case_id, key)
);

-- 状態を変えた記録。お客様向けレポートの「今月対応したこと」はここから作る
CREATE TABLE IF NOT EXISTS todo_events (
  id         TEXT PRIMARY KEY,
  case_id    TEXT NOT NULL REFERENCES cases(id),
  key        TEXT NOT NULL,
  status     TEXT NOT NULL,
  title      TEXT,
  basis      TEXT,
  area       TEXT,
  note       TEXT,
  changed_by TEXT,
  changed_at TEXT NOT NULL DEFAULT (datetime('now')),
  day        TEXT NOT NULL                   -- JST の日付（月ごとの集計用）
);
CREATE INDEX IF NOT EXISTS idx_todo_events_case_day ON todo_events(case_id, day);

ALTER TABLE settings_log ADD COLUMN case_name TEXT;
