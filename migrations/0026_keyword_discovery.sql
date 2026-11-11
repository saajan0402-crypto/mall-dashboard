-- キーワード発見
-- 監視するキーワード（案件ごと）。競合の順位・価格・レビューを毎日記録する
CREATE TABLE IF NOT EXISTS kw_watch (
  case_id  TEXT NOT NULL REFERENCES cases(id),
  keyword  TEXT NOT NULL,
  added_by TEXT,
  added_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (case_id, keyword)
);

-- Amazon 広告 API のキーワード推奨（自社 ASIN ごと）。週に1回取り直す
CREATE TABLE IF NOT EXISTS kw_reco (
  case_id    TEXT NOT NULL REFERENCES cases(id),
  product_id TEXT NOT NULL,
  keyword    TEXT NOT NULL,
  rank       INTEGER,
  match_type TEXT,
  bid_low    INTEGER,
  bid_median INTEGER,
  bid_high   INTEGER,
  imp_share  REAL,
  imp_rank   INTEGER,
  fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (case_id, product_id, keyword)
);
CREATE INDEX IF NOT EXISTS idx_kw_reco_case ON kw_reco (case_id, keyword);

-- 監視キーワードの検索結果（Amazon はカタログ検索、楽天は楽天市場の商品検索）。1日1回
CREATE TABLE IF NOT EXISTS kw_serp (
  case_id      TEXT NOT NULL REFERENCES cases(id),
  mall         TEXT NOT NULL,
  keyword      TEXT NOT NULL,
  date         TEXT NOT NULL,
  position     INTEGER NOT NULL,
  item_id      TEXT NOT NULL,        -- ASIN／楽天の itemCode（店舗:商品管理番号）
  title        TEXT,
  shop         TEXT,                 -- 楽天の店舗名／Amazon のブランド
  price        INTEGER,
  review_count INTEGER,
  review_avg   REAL,
  sales_rank   INTEGER,              -- Amazon のランキング（BSR）
  own          INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (case_id, mall, keyword, date, position)
);
CREATE INDEX IF NOT EXISTS idx_kw_serp_kw ON kw_serp (case_id, keyword, date);

-- AI の週次分析（Claude API）。案件の設定「AIの週次分析」がオンの案件だけ
CREATE TABLE IF NOT EXISTS ai_reports (
  id            TEXT PRIMARY KEY,
  case_id       TEXT NOT NULL REFERENCES cases(id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at   TEXT,
  status        TEXT NOT NULL,       -- queued | running | done | error
  trigger_kind  TEXT,                -- weekly | manual
  requested_by  TEXT,
  model         TEXT,
  input_tokens  INTEGER,
  output_tokens INTEGER,
  web_searches  INTEGER,
  cost_usd      REAL,
  content       TEXT,
  error         TEXT
);
CREATE INDEX IF NOT EXISTS idx_ai_reports_case ON ai_reports (case_id, created_at);
