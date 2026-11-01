-- 在庫は「販売可能」だけ見ていても判断できない。
-- 入庫中・引当済み・販売不可を分けて持ち、欠品の読み違いを防ぐ。
ALTER TABLE daily_inventory ADD COLUMN inbound       INTEGER NOT NULL DEFAULT 0;  -- 納品中（作成中＋発送済み＋受領中）
ALTER TABLE daily_inventory ADD COLUMN reserved      INTEGER NOT NULL DEFAULT 0;  -- 引当済み（注文確定・移動中など）
ALTER TABLE daily_inventory ADD COLUMN unfulfillable INTEGER NOT NULL DEFAULT 0;  -- 販売不可
ALTER TABLE daily_inventory ADD COLUMN total         INTEGER NOT NULL DEFAULT 0;  -- Amazon が返す合計
ALTER TABLE daily_inventory ADD COLUMN velocity      REAL;                        -- 直近の1日あたり販売数
