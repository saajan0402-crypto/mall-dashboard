-- 外部広告費（モールの外の広告：SNS広告・インフルエンサーなど）。案件×月の合計を税別で手入力する。
-- 期間の集計では、月の金額をその月の日数で割って日ごとに按分する（月の途中なら経過した日数ぶんだけ）
CREATE TABLE IF NOT EXISTS external_ads (
  case_id    TEXT NOT NULL REFERENCES cases(id),
  month      TEXT NOT NULL,                 -- YYYY-MM
  amount     INTEGER NOT NULL,              -- 税別
  updated_by TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (case_id, month)
);

-- リピート率（楽天）。注文ごとに「購入者の印」を持つ。
-- 印は注文者の氏名・電話番号などを SECRET_KEY 由来の鍵で HMAC-SHA256 にかけた値で、元の個人情報には戻せない。
-- 氏名・電話番号そのものは保存しない
CREATE TABLE IF NOT EXISTS customer_orders (
  case_id  TEXT NOT NULL REFERENCES cases(id),
  mall     TEXT NOT NULL,
  order_id TEXT NOT NULL,
  date     TEXT NOT NULL,                   -- 注文日（日本時間）
  customer TEXT NOT NULL,                   -- 購入者の印
  revenue  INTEGER NOT NULL DEFAULT 0,      -- 税込
  PRIMARY KEY (case_id, mall, order_id)
);
CREATE INDEX IF NOT EXISTS idx_customer_orders_cust ON customer_orders (case_id, mall, customer, date);
CREATE INDEX IF NOT EXISTS idx_customer_orders_date ON customer_orders (case_id, mall, date);

-- リピート率（Amazon）。ブランド分析の「リピート購入」レポート（月単位・ASIN 単位）
-- asin = '_none' はその月のデータが無かった印（何度も依頼しないため）
CREATE TABLE IF NOT EXISTS repeat_purchase (
  case_id            TEXT NOT NULL REFERENCES cases(id),
  mall               TEXT NOT NULL,
  month              TEXT NOT NULL,         -- YYYY-MM
  asin               TEXT NOT NULL,
  orders             INTEGER NOT NULL DEFAULT 0,
  unique_customers   INTEGER NOT NULL DEFAULT 0,
  repeat_pct         REAL,                  -- 期間内に2回以上買った顧客の割合（%）
  repeat_revenue     INTEGER,
  repeat_revenue_pct REAL,
  PRIMARY KEY (case_id, mall, month, asin)
);
