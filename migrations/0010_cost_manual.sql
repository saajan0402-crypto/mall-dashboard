-- 1つの商品管理番号の中に複数の買い方があり、買い方によって原価が変わる商品がある。
-- そういう商品はマスタに「?」と入れてもらい、担当者があとから手で計算して入れる。
--
-- 原価を 0 として扱うと粗利が売上そのままになり、実態よりよく見える。
-- 「0円」と「まだ分からない」は別物なので、未確定は NULL で持ち、
-- 粗利の計算からも外す。
CREATE TABLE cost_history_new (
  id             TEXT PRIMARY KEY,
  product_id     TEXT NOT NULL REFERENCES products(id),
  effective_from TEXT NOT NULL,
  unit_cost      INTEGER,                         -- 未確定なら NULL
  shipping_cost  INTEGER NOT NULL DEFAULT 0,
  packaging_cost INTEGER NOT NULL DEFAULT 0,
  needs_manual   INTEGER NOT NULL DEFAULT 0,      -- 1 = 担当者が手で計算して入れる
  note           TEXT,
  UNIQUE (product_id, effective_from)
);

INSERT INTO cost_history_new (id, product_id, effective_from, unit_cost, shipping_cost, packaging_cost)
  SELECT id, product_id, effective_from, unit_cost, shipping_cost, packaging_cost FROM cost_history;

DROP TABLE cost_history;
ALTER TABLE cost_history_new RENAME TO cost_history;
