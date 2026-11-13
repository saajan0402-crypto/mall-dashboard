-- 楽天：キーワード発見の追加で、入れる商品ページを担当者が選んだとき（JSON の配列）。無ければ一番売れている1ページだけに入れる
ALTER TABLE kw_plan ADD COLUMN pages TEXT;
