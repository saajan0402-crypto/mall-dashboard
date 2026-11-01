-- 過去データの精度を上げるための追加
--   discount : クーポン・プロモーションの自社負担分。日次の値引き額の集計に使う
ALTER TABLE order_items ADD COLUMN discount INTEGER NOT NULL DEFAULT 0;
