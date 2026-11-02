-- モールからの請求明細（実額）
--
-- 楽天には手数料のAPIが無いので、料率からの概算しか作れない。
-- RMSから落とせる請求明細をCSVで入れてもらい、その月の手数料を実額に置き換える。
--
-- ただし請求明細は店舗単位で、商品ごとの内訳は無い。
-- 商品別の粗利を出すには売上で按分するしかないので、
-- 「どこまでが実額で、どこからが按分か」を必ず残す。
CREATE TABLE mall_charges (
  id           TEXT PRIMARY KEY,
  case_id      TEXT NOT NULL REFERENCES cases(id),
  mall         TEXT NOT NULL,
  period_start TEXT NOT NULL,                   -- 対象期間（月初）
  period_end   TEXT NOT NULL,                   -- 対象期間（月末）
  name         TEXT NOT NULL,                   -- 費目（システム利用料 など）
  amount       INTEGER NOT NULL,                -- 円。費用はプラスで持つ
  note         TEXT,
  source       TEXT NOT NULL DEFAULT 'csv',     -- csv | manual
  source_file  TEXT,
  r2_key       TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_mall_charges_period ON mall_charges (case_id, mall, period_start);

-- 手数料の出どころ。api（入金明細）／allocated（請求明細を売上で按分）／NULL（概算のみ）
ALTER TABLE daily_sales ADD COLUMN fee_source TEXT;
