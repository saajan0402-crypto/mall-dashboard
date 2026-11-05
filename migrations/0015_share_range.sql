-- 共有URLに期間を持たせる。「直近30日」のような呼び名なら、開くたびに今日から数え直す
ALTER TABLE share_links ADD COLUMN range_preset TEXT;
ALTER TABLE share_links ADD COLUMN range_from TEXT;
ALTER TABLE share_links ADD COLUMN range_to TEXT;
