-- Amazon広告レポートの取り込み
--
-- Amazon は広告の種類（SP / SB / SD）ごとに売上の帰属期間が違う。
-- SP は7日、SB は14日、楽天RPPは720時間（30日）。
-- 同じ「ROAS」でも条件が違うので、帰属期間を必ず一緒に持つ。

ALTER TABLE daily_ads ADD COLUMN ad_type          TEXT;      -- sp | sb | sd | rpp
ALTER TABLE daily_ads ADD COLUMN portfolio        TEXT;
ALTER TABLE daily_ads ADD COLUMN budget           INTEGER;   -- 1日の予算
ALTER TABLE daily_ads ADD COLUMN budget_coverage  REAL;      -- 予算内に収まっていた時間の割合（%）。100未満は予算切れ
ALTER TABLE daily_ads ADD COLUMN attribution_days INTEGER;   -- 売上の帰属期間（日）

-- 検索用語。まだ1行も入っていないので作り直す。
-- インプレッションシェアは Amazon 上に30日しか残らないので、ここに貯めていく
DROP TABLE daily_search_terms;

CREATE TABLE daily_search_terms (
  case_id          TEXT NOT NULL REFERENCES cases(id),
  mall             TEXT NOT NULL,
  date             TEXT NOT NULL,
  ad_type          TEXT NOT NULL,                 -- sp | sb
  campaign         TEXT NOT NULL DEFAULT '',
  ad_group         TEXT NOT NULL DEFAULT '',
  targeting        TEXT NOT NULL DEFAULT '',      -- 入札しているキーワード／ターゲット
  match_type       TEXT NOT NULL DEFAULT '',
  search_term      TEXT NOT NULL,                 -- 顧客が実際に打った検索語
  portfolio        TEXT,
  impressions      INTEGER,
  clicks           INTEGER NOT NULL DEFAULT 0,
  cost             INTEGER NOT NULL DEFAULT 0,
  orders           INTEGER NOT NULL DEFAULT 0,
  sales            INTEGER NOT NULL DEFAULT 0,
  imp_rank         INTEGER,                       -- 検索用語のインプレッションランク
  imp_share        REAL,                          -- 検索用語のインプレッションシェア（%）
  attribution_days INTEGER,
  source_file      TEXT,
  PRIMARY KEY (case_id, mall, date, ad_type, campaign, ad_group, targeting, match_type, search_term)
);

CREATE INDEX idx_search_terms_day  ON daily_search_terms (case_id, date);
CREATE INDEX idx_search_terms_term ON daily_search_terms (case_id, search_term);

-- すでに入っている楽天の行に種類と帰属期間を入れておく（入れ直しのときに消し漏れないように）
UPDATE daily_ads SET ad_type = 'rpp', attribution_days = 30 WHERE mall = 'rakuten' AND ad_type IS NULL;
