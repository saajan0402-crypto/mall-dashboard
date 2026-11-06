-- 楽天の過去の売上の取り込み（案件ごと）。
-- ふだんの取り込みは直近7日だけなので、接続したばかりの案件は過去の月がほぼ空になる。
-- 30日ずつ新しい方から古い方へさかのぼり、5分ごとの実行で少しずつ進める
CREATE TABLE rakuten_backfill (
  case_id    TEXT PRIMARY KEY REFERENCES cases(id),
  from_date  TEXT NOT NULL,              -- ここまでさかのぼる
  cursor     TEXT NOT NULL,              -- 次に取る期間の終わりの日
  status     TEXT NOT NULL DEFAULT 'running',   -- running | done | error
  windows    INTEGER NOT NULL DEFAULT 0, -- 取り込んだ期間の数
  orders     INTEGER NOT NULL DEFAULT 0, -- 取り込んだ日×商品の行数
  fails      INTEGER NOT NULL DEFAULT 0,
  error      TEXT,
  started_by TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
