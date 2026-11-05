-- AIに読ませるための共有URL
-- URLの鍵（トークン）は照合用にハッシュで持つ。再表示できるように、暗号化した原文も持つ
CREATE TABLE IF NOT EXISTS share_links (
  id            TEXT PRIMARY KEY,
  case_id       TEXT NOT NULL REFERENCES cases(id),
  token_hash    TEXT NOT NULL UNIQUE,
  token_enc     TEXT,
  label         TEXT,
  created_by    TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at    TEXT NOT NULL,
  revoked_at    TEXT,
  last_access_at TEXT,
  access_count  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_share_links_case ON share_links(case_id);
