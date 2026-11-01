-- 入金明細（SP-API Finances）の明細。
-- 日次売上の手数料は料率ベースの概算で入れているが、
-- ここに入る実額で上書きして月次の粗利を確定させる。
-- 生の1行ずつを残しておくことで、あとから内訳を聞かれても答えられる。
CREATE TABLE fee_events (
  id         TEXT PRIMARY KEY,
  case_id    TEXT NOT NULL REFERENCES cases(id),
  mall       TEXT NOT NULL,
  date       TEXT NOT NULL,                  -- 計上日（日本時間）
  order_id   TEXT,
  sku        TEXT,                           -- モール側のSKU。照合前の生の値
  product_id TEXT REFERENCES products(id),   -- 商品マスタに無ければ NULL
  event_type TEXT NOT NULL,                  -- shipment | refund | service_fee | adjustment
  kind       TEXT NOT NULL,                  -- charge | fee | promotion | tax_withheld
  name       TEXT NOT NULL,                  -- Commission / FBAPerUnitFulfillmentFee など
  amount     INTEGER NOT NULL,               -- 円。費用はマイナスのまま入れる
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_fee_events_day     ON fee_events (case_id, mall, date);
CREATE INDEX idx_fee_events_product ON fee_events (product_id, date);
