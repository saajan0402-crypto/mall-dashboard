-- 「その日の入金明細を取り込めているか」を日次売上の行ごとに確かめる問い合わせが多いので、索引を張る。
-- 無いと ingests を毎回全部なめるため、月次推移（12か月ぶんの損益）が時間切れで出なかった
CREATE INDEX IF NOT EXISTS idx_ingests_cover ON ingests (case_id, mall, kind, period_start, status);
