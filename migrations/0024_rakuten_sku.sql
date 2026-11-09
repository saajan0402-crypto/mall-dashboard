-- 楽天の SKU管理番号（variantId）を商品マスタに持つ。
-- 1つの商品管理番号（商品ページ）に複数の SKU があり、SKU ごとに別の商品（原価が違う）になっている場合があるため。
--   例：ism_3mainpage → r-sku001 / r-sku002 / r-sku003 がそれぞれ別の自社SKU
-- これまでの UNIQUE(mall, external_id) だと、同じ商品管理番号を複数の商品に付けられないので、
-- 表を作り直して UNIQUE(mall, external_id, sku_id) にする（sku_id は空文字＝商品ページ単位）
CREATE TABLE product_listings_new (
  id           TEXT PRIMARY KEY,
  product_id   TEXT NOT NULL REFERENCES products(id),
  mall         TEXT NOT NULL CHECK (mall IN ('amazon','rakuten')),
  external_id  TEXT NOT NULL,                      -- Amazon SKU / 楽天 商品管理番号
  sku_id       TEXT NOT NULL DEFAULT '',           -- 楽天 SKU管理番号（空＝商品ページ単位）
  asin         TEXT,
  fulfillment  TEXT,
  price        INTEGER,
  mall_name    TEXT,
  checked_at   TEXT,
  check_status TEXT,
  UNIQUE (mall, external_id, sku_id)
);
INSERT INTO product_listings_new (id, product_id, mall, external_id, sku_id, asin, fulfillment, price, mall_name, checked_at, check_status)
  SELECT id, product_id, mall, external_id, '', asin, fulfillment, price, mall_name, checked_at, check_status FROM product_listings;
DROP TABLE product_listings;
ALTER TABLE product_listings_new RENAME TO product_listings;
CREATE INDEX idx_listings_product ON product_listings(product_id);
CREATE INDEX idx_listings_sku ON product_listings(mall, sku_id);
