-- 育成中のキーワードに Amazon を加える（Amazon の推奨だけの語は低めに入れて育てる）。
-- Amazon は external_id に広告グループID、campaign・ad_group に名前（広告レポートとの突き合わせ用）
ALTER TABLE kw_grow ADD COLUMN campaign TEXT;
ALTER TABLE kw_grow ADD COLUMN ad_group TEXT;
