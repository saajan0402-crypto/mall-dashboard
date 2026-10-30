-- SP-API のレポートは「依頼 → 生成待ち → ダウンロード」の3段階で、
-- 生成に数分かかる。1回の実行で待ち続けるのは無理があるので、
-- 依頼した事実をこの表に残し、次の実行で取りに行く。
CREATE TABLE report_jobs (
  id          TEXT PRIMARY KEY,
  case_id     TEXT NOT NULL REFERENCES cases(id),
  mall        TEXT NOT NULL,
  report_type TEXT NOT NULL,
  date        TEXT NOT NULL,                     -- 対象日（1日につき1レポート）
  report_id   TEXT,                              -- Amazon が返すレポートID
  document_id TEXT,
  status      TEXT NOT NULL,                     -- requested | done | error | empty
  attempts    INTEGER NOT NULL DEFAULT 0,
  rows        INTEGER NOT NULL DEFAULT 0,
  error       TEXT,
  r2_key      TEXT,                              -- 生データの保管先
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (case_id, mall, report_type, date)
);

CREATE INDEX idx_report_jobs_pending ON report_jobs (status, updated_at);
