-- 定期おトク便（Subscribe & Save）
--
-- 旧レポート（GET_FBA_SNS_FORECAST_DATA）は2025年12月に廃止されたので、
-- 後継の Replenishment API から取る。
--
-- 継続購読数と今後30/60/90日の出荷予測は「確定した将来需要」なので、
-- 在庫があと何日もつかの判断にそのまま使える。
CREATE TABLE sns_offers (
  case_id          TEXT NOT NULL REFERENCES cases(id),
  date             TEXT NOT NULL,              -- 取得日
  offer_key        TEXT NOT NULL,              -- ASIN、無ければSKU
  asin             TEXT,
  sku              TEXT,
  product_id       TEXT REFERENCES products(id),
  subscriptions    INTEGER,                    -- 継続中の定期購読数
  eligibility      TEXT,                       -- ELIGIBLE など
  amazon_inventory INTEGER,                    -- Amazon が返す在庫数（参考）
  shipped_units    INTEGER,                    -- 直近1週間の出荷数
  shipped_revenue  INTEGER,                    -- 直近1週間の売上
  oos_not_delivered INTEGER,                   -- 在庫切れで届けられなかった数
  oos_lost_revenue  INTEGER,                   -- そのぶんの逸失売上
  next30_units     INTEGER,                    -- 今後30日の出荷予測
  next60_units     INTEGER,
  next90_units     INTEGER,
  next30_revenue   INTEGER,
  period_start     TEXT,                       -- 実績の対象週
  period_end       TEXT,
  PRIMARY KEY (case_id, date, offer_key)
);

CREATE INDEX idx_sns_product ON sns_offers (product_id, date);
