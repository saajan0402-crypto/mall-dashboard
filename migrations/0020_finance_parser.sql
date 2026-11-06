-- 入金明細を読んだプログラムの版。
-- 2＝Amazonポイントの費用（CostOfPointsGranted / Returned）も読む版。
-- 1（NULL）の日は、R2 に残している生データから読み直す（API は呼び直さない）。
ALTER TABLE ingests ADD COLUMN parser INTEGER;
