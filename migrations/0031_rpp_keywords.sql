-- 楽天RPP の登録キーワード一覧（RPP の管理画面からダウンロードした CSV を読み込む。読み込むたびに案件ぶんを入れ替える）。
-- クリック0のキーワードはレポートに出ないので、商品ごとの登録数（上限20）・かぶりの判定はこちらを正とする
CREATE TABLE IF NOT EXISTS rpp_keywords (
  case_id       TEXT NOT NULL REFERENCES cases(id),
  external_id   TEXT NOT NULL,       -- 商品管理番号
  keyword       TEXT NOT NULL,
  keyword_cpc   INTEGER,
  item_cpc      INTEGER,             -- 商品CPC
  suggested_cpc INTEGER,             -- 目安CPC
  item_name     TEXT,
  imported_at   TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (case_id, external_id, keyword)
);
