-- 商品ページの文章（商品名・キャッチコピー・箇条書き・説明文・検索キーワード）。API から読むだけ（1日1回・画面から取り直し）。
-- Amazon は ASIN、楽天は商品管理番号ごと。キーワード発見の「商品ページに入れるキーワード」の判定に使う
CREATE TABLE IF NOT EXISTS listing_content (
  case_id      TEXT NOT NULL REFERENCES cases(id),
  mall         TEXT NOT NULL,
  external_id  TEXT NOT NULL,
  title        TEXT,
  tagline      TEXT,                 -- 楽天：キャッチコピー
  bullets      TEXT,                 -- Amazon：箇条書き（JSON の配列）
  description  TEXT,                 -- 商品説明（楽天は PC・スマホ・販売説明文をまとめたもの）
  search_terms TEXT,                 -- Amazon：検索キーワード（セラーIDがあるときだけ取れる）
  error        TEXT,
  fetched_at   TEXT,
  PRIMARY KEY (case_id, mall, external_id)
);
