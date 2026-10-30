-- 0001_init.sql
-- モール横断パフォーマンス管理ツール / 初期スキーマ
--
-- 方針
--  * 金額はすべて「円」の整数で持つ。小数は使わない（集計のずれを防ぐため）
--  * 日付は 'YYYY-MM-DD' の文字列
--  * すべてのデータは案件（case）に属する。案件をまたぐ集計は画面側だけで行う
--  * 「事実の設定」（原価など）は適用開始日を持たせ、過去を塗り替えない
--  * 「構成の設定」（粗利の費目など）は settings に置き、変更したら全期間を再計算する

-- ───────── 案件とアカウント ─────────

CREATE TABLE cases (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active',   -- active | archived
  slack_channel TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE case_malls (
  id                 TEXT PRIMARY KEY,
  case_id            TEXT NOT NULL REFERENCES cases(id),
  mall               TEXT NOT NULL CHECK (mall IN ('amazon','rakuten')),
  account_label      TEXT,                        -- 画面に出す名前（セラーID等は入れない）
  credentials_enc    TEXT,                        -- 暗号化済みの接続情報。平文では絶対に入れない
  license_expires_on TEXT,                        -- 楽天ライセンスキーの有効期限
  attribution_days   INTEGER DEFAULT 7,           -- Amazon 広告の帰属期間（7 / 14）
  default_fulfillment TEXT DEFAULT 'fba',         -- fba | own | mcf
  connected_at       TEXT,
  UNIQUE (case_id, mall)
);

-- ───────── 商品 ─────────

CREATE TABLE products (
  id        TEXT PRIMARY KEY,
  case_id   TEXT NOT NULL REFERENCES cases(id),
  sku       TEXT NOT NULL,                        -- 自社SKU。すべての集計の軸
  name      TEXT NOT NULL,
  jan       TEXT,
  ad_policy TEXT DEFAULT 'profit',                -- profit（利益重視）| share（シェア獲得）| nurture（育成中）
  status    TEXT NOT NULL DEFAULT 'active',       -- active | discontinued
  UNIQUE (case_id, sku)
);

-- 商品 × モール（出品の紐づけ）。ここが両モールを突き合わせる要
CREATE TABLE product_listings (
  id          TEXT PRIMARY KEY,
  product_id  TEXT NOT NULL REFERENCES products(id),
  mall        TEXT NOT NULL CHECK (mall IN ('amazon','rakuten')),
  external_id TEXT NOT NULL,                      -- Amazon SKU / 楽天 商品管理番号
  asin        TEXT,
  fulfillment TEXT,                               -- NULL なら case_malls の既定を継承
  UNIQUE (mall, external_id)
);
CREATE INDEX idx_listings_product ON product_listings(product_id);

-- 原価・送料・梱包資材費（事実の設定：適用開始日つき）
CREATE TABLE cost_history (
  id             TEXT PRIMARY KEY,
  product_id     TEXT NOT NULL REFERENCES products(id),
  effective_from TEXT NOT NULL,
  unit_cost      INTEGER NOT NULL,                -- 仕入原価
  shipping_cost  INTEGER NOT NULL DEFAULT 0,      -- 自社発送時の送料
  packaging_cost INTEGER NOT NULL DEFAULT 0,      -- 梱包資材費
  UNIQUE (product_id, effective_from)
);

-- ───────── 設定 ─────────

-- 構成の設定。scope は company / case / case_mall / listing の4階層
-- 下の階層に行が無ければ上の階層の値を継承する
CREATE TABLE settings (
  scope      TEXT NOT NULL,
  scope_id   TEXT NOT NULL DEFAULT '',            -- company の場合は ''
  key        TEXT NOT NULL,
  value      TEXT NOT NULL,                       -- JSON
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by TEXT,
  PRIMARY KEY (scope, scope_id, key)
);

-- 設定の変更履歴。「知らない間に数字が変わっていた」を追えるようにする
CREATE TABLE settings_log (
  id         TEXT PRIMARY KEY,
  scope      TEXT NOT NULL,
  scope_id   TEXT NOT NULL,
  key        TEXT NOT NULL,
  old_value  TEXT,
  new_value  TEXT,
  changed_by TEXT,
  changed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ───────── 日次の明細 ─────────

CREATE TABLE daily_sales (
  case_id     TEXT NOT NULL REFERENCES cases(id),
  mall        TEXT NOT NULL,
  product_id  TEXT REFERENCES products(id),       -- マスタ未登録なら NULL
  date        TEXT NOT NULL,
  units       INTEGER NOT NULL DEFAULT 0,
  revenue     INTEGER NOT NULL DEFAULT 0,         -- 税込
  returns     INTEGER NOT NULL DEFAULT 0,
  discounts   INTEGER NOT NULL DEFAULT 0,         -- クーポン・値引の自社負担分
  points_cost INTEGER NOT NULL DEFAULT 0,         -- ポイント原資
  fee_est     INTEGER NOT NULL DEFAULT 0,         -- 料率ベースの概算手数料（日次）
  fee_actual  INTEGER,                            -- 入金明細の実額（月次で埋まる）
  sessions    INTEGER,
  page_views  INTEGER,
  source      TEXT NOT NULL DEFAULT 'api',        -- api | csv
  PRIMARY KEY (case_id, mall, date, product_id)
);
CREATE INDEX idx_sales_case_date ON daily_sales(case_id, date);

CREATE TABLE daily_inventory (
  case_id        TEXT NOT NULL REFERENCES cases(id),
  mall           TEXT NOT NULL,
  product_id     TEXT NOT NULL REFERENCES products(id),
  date           TEXT NOT NULL,
  qty            INTEGER NOT NULL DEFAULT 0,
  days_of_supply REAL,
  PRIMARY KEY (case_id, mall, date, product_id)
);

-- 広告：日 × キャンペーン × キーワード
CREATE TABLE daily_ads (
  case_id     TEXT NOT NULL REFERENCES cases(id),
  mall        TEXT NOT NULL,
  date        TEXT NOT NULL,
  campaign    TEXT NOT NULL,
  ad_group    TEXT NOT NULL DEFAULT '',
  keyword     TEXT NOT NULL DEFAULT '',
  match_type  TEXT NOT NULL DEFAULT '',           -- 楽天RPPは空
  product_id  TEXT REFERENCES products(id),
  impressions INTEGER NOT NULL DEFAULT 0,
  clicks      INTEGER NOT NULL DEFAULT 0,
  cost        INTEGER NOT NULL DEFAULT 0,
  orders      INTEGER NOT NULL DEFAULT 0,
  sales       INTEGER NOT NULL DEFAULT 0,
  bid         INTEGER,
  imp_share   REAL,                               -- 検索語句インプレッションシェア（CSV由来）
  source      TEXT NOT NULL DEFAULT 'csv',
  PRIMARY KEY (case_id, mall, date, campaign, ad_group, keyword, match_type)
);
CREATE INDEX idx_ads_case_date ON daily_ads(case_id, date);
CREATE INDEX idx_ads_keyword ON daily_ads(case_id, keyword);

-- 検索語句レポート（広告経由で実際に検索された語句）
CREATE TABLE daily_search_terms (
  case_id     TEXT NOT NULL REFERENCES cases(id),
  mall        TEXT NOT NULL,
  date        TEXT NOT NULL,
  campaign    TEXT NOT NULL DEFAULT '',
  keyword     TEXT NOT NULL DEFAULT '',
  search_term TEXT NOT NULL,
  impressions INTEGER NOT NULL DEFAULT 0,
  clicks      INTEGER NOT NULL DEFAULT 0,
  cost        INTEGER NOT NULL DEFAULT 0,
  orders      INTEGER NOT NULL DEFAULT 0,
  sales       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (case_id, mall, date, campaign, keyword, search_term)
);

-- ───────── 市場・競合 ─────────

-- Brand Analytics 検索用語レポートから、案件に関係する語句だけを抜き出したもの
CREATE TABLE market_search_terms (
  case_id      TEXT NOT NULL REFERENCES cases(id),
  week         TEXT NOT NULL,                     -- 週の開始日
  term         TEXT NOT NULL,
  freq_rank    INTEGER,
  position     INTEGER NOT NULL,                  -- 1..3（上位クリック商品の順位）
  asin         TEXT NOT NULL,
  product_name TEXT,
  is_ours      INTEGER NOT NULL DEFAULT 0,
  click_share  REAL,
  conv_share   REAL,
  PRIMARY KEY (case_id, week, term, position)
);

-- 定点観測（検索結果のスクリーンショットを Claude が読み取った結果）
CREATE TABLE rank_observations (
  id             TEXT PRIMARY KEY,
  case_id        TEXT NOT NULL REFERENCES cases(id),
  mall           TEXT NOT NULL,
  term           TEXT NOT NULL,
  observed_on    TEXT NOT NULL,
  our_rank       INTEGER,
  our_sponsored  INTEGER,                         -- 広告枠に出ていたか
  competitors    TEXT,                            -- JSON: [{rank, name, sponsored}]
  screenshot_key TEXT,                            -- R2 のキー
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ───────── 提案と施策 ─────────

CREATE TABLE proposals (
  id              TEXT PRIMARY KEY,
  case_id         TEXT NOT NULL REFERENCES cases(id),
  mall            TEXT NOT NULL,
  week            TEXT NOT NULL,
  action          TEXT NOT NULL,                  -- lower | raise | pause | add_keyword | add_negative
  campaign        TEXT,
  ad_group        TEXT,
  keyword         TEXT,
  match_type      TEXT,
  current_bid     INTEGER,
  suggested_bid   INTEGER,
  rationale       TEXT NOT NULL,                  -- Claude が書く（数値はコードが埋める）
  market_note     TEXT,
  expected_effect INTEGER,                        -- 円。優先順位の根拠
  priority        TEXT NOT NULL DEFAULT 'mid',    -- high | mid | low
  status          TEXT NOT NULL DEFAULT 'open',   -- open | done | skipped
  status_reason   TEXT,                           -- 見送り理由。次回の提案に渡す
  acted_on        TEXT,
  measured_at     TEXT,
  measured_result TEXT,                           -- JSON: 14日後の前後比較
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_proposals_case_status ON proposals(case_id, status);

CREATE TABLE actions (
  id          TEXT PRIMARY KEY,
  case_id     TEXT NOT NULL REFERENCES cases(id),
  scope       TEXT NOT NULL DEFAULT 'case',       -- case | mall | product | keyword
  target_id   TEXT,
  kind        TEXT NOT NULL,                      -- ad | price | sale | coupon | page | stock | other
  title       TEXT NOT NULL,
  detail      TEXT,
  start_date  TEXT NOT NULL,
  end_date    TEXT,
  owner       TEXT,
  status      TEXT NOT NULL DEFAULT 'planned',    -- planned | running | done | cancelled
  source      TEXT NOT NULL DEFAULT 'manual',     -- manual | proposal | settings
  source_id   TEXT,
  result      TEXT,                               -- JSON: 効果測定
  note        TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_actions_case_date ON actions(case_id, start_date);

-- ───────── 取り込みの記録 ─────────

CREATE TABLE ingests (
  id           TEXT PRIMARY KEY,
  case_id      TEXT REFERENCES cases(id),
  mall         TEXT,
  kind         TEXT NOT NULL,                     -- orders | settlement | inventory | ads | search_terms | brand_analytics
  period_start TEXT,
  period_end   TEXT,
  rows         INTEGER NOT NULL DEFAULT 0,
  status       TEXT NOT NULL,                     -- ok | error
  error        TEXT,
  r2_key       TEXT,                              -- 生データの保管先。あとから再計算できる
  source       TEXT NOT NULL DEFAULT 'api',
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_ingests_created ON ingests(created_at);

-- ───────── 初期データ ─────────

INSERT INTO settings (scope, scope_id, key, value) VALUES
  ('company', '', 'profit_components', '{"cost":true,"commission":true,"payment_fee":true,"ad_cost":true,"points":true,"coupon":true,"affiliate":true,"fba_fee":true,"own_shipping":true,"packaging":true,"labor":false,"warehouse":false}'),
  ('company', '', 'daily_basis', '"estimate"'),
  ('company', '', 'monthly_basis', '"actual"'),
  ('company', '', 'max_proposals', '10'),
  ('company', '', 'stock_alert_days', '14'),
  ('company', '', 'sales_swing_pct', '30');
