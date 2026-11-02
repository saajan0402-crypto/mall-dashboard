-- 楽天の商品情報（商品API 2.0 の items.bulk.get は無料で使える）
--   price       : 販売価格。バリエーションがある場合はいちばん安いもの
--   mall_name   : モール側の商品名。マスタの商品名と突き合わせるため
--   checked_at  : 最後に照合した日時
--   check_status: ok | not_found（商品管理番号がモールに存在しない＝マスタの誤り）
ALTER TABLE product_listings ADD COLUMN price        INTEGER;
ALTER TABLE product_listings ADD COLUMN mall_name    TEXT;
ALTER TABLE product_listings ADD COLUMN checked_at   TEXT;
ALTER TABLE product_listings ADD COLUMN check_status TEXT;
