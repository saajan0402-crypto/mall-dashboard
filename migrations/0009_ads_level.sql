-- 広告データは同じ日のものが3つの粒度で届く。
--   キャンペーン別 / 商品別 / キーワード別
-- 1つの表に混ぜると、合計を出すときに同じ費用を何度も数えてしまう。
-- level を主キーに入れて、集計のときは必ず1つの粒度だけを見る。
--
-- daily_ads はまだ1行も入っていないので、作り直す。
DROP TABLE daily_ads;

CREATE TABLE daily_ads (
  case_id     TEXT NOT NULL REFERENCES cases(id),
  mall        TEXT NOT NULL,
  date        TEXT NOT NULL,
  level       TEXT NOT NULL,                      -- campaign | product | keyword
  campaign    TEXT NOT NULL DEFAULT '',
  ad_group    TEXT NOT NULL DEFAULT '',
  keyword     TEXT NOT NULL DEFAULT '',
  match_type  TEXT NOT NULL DEFAULT '',           -- 楽天RPPは空
  external_id TEXT NOT NULL DEFAULT '',           -- 商品管理番号 / SKU。照合前の生の値
  product_id  TEXT REFERENCES products(id),
  impressions INTEGER,                            -- 楽天はCTRからの逆算。求まらない行は NULL
  clicks      INTEGER NOT NULL DEFAULT 0,
  cost        INTEGER NOT NULL DEFAULT 0,
  orders      INTEGER NOT NULL DEFAULT 0,
  sales       INTEGER NOT NULL DEFAULT 0,
  bid         INTEGER,                            -- 自分で設定した入札額
  suggested_cpc INTEGER,                          -- 楽天が出す目安CPC。入札提案の基準に使う
  imp_share   REAL,
  new_clicks  INTEGER,                            -- 楽天の「新規」。既存との比率を見るため
  new_sales   INTEGER,
  source      TEXT NOT NULL DEFAULT 'csv',
  source_file TEXT,                               -- どのファイルから入ったか
  PRIMARY KEY (case_id, mall, date, level, campaign, ad_group, keyword, match_type, external_id)
);

CREATE INDEX idx_daily_ads_day     ON daily_ads (case_id, mall, date, level);
CREATE INDEX idx_daily_ads_product ON daily_ads (product_id, date);

-- 取り込んだファイルの記録。どの日が揃っていて、どの日が抜けているかを出す
CREATE TABLE ad_files (
  id          TEXT PRIMARY KEY,
  case_id     TEXT NOT NULL REFERENCES cases(id),
  mall        TEXT NOT NULL,
  level       TEXT NOT NULL,
  period_start TEXT NOT NULL,
  period_end   TEXT NOT NULL,
  rows        INTEGER NOT NULL DEFAULT 0,
  file_name   TEXT,
  r2_key      TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_ad_files_period ON ad_files (case_id, mall, level, period_start);
