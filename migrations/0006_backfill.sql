-- 過去データの取り込み
--
-- 売上レポートは「依頼・確認・取得」それぞれが1分に1回しか呼べないため、
-- 1日1レポートで遡ると数時間かかる。過去分は注文APIから取る。
-- 注文APIは1秒に2回まで呼べるので現実的な時間で終わる。
-- 代わりにセッション数は取れないので、過去分の CVR は出ない。

-- 注文の明細。1行＝1注文明細。何度取り直しても同じ行に上書きされる
CREATE TABLE order_items (
  case_id       TEXT NOT NULL REFERENCES cases(id),
  mall          TEXT NOT NULL,
  order_id      TEXT NOT NULL,
  order_item_id TEXT NOT NULL,
  date          TEXT NOT NULL,                  -- 注文日（日本時間）
  sku           TEXT,
  product_id    TEXT REFERENCES products(id),
  units         INTEGER NOT NULL DEFAULT 0,
  revenue       INTEGER NOT NULL DEFAULT 0,     -- 税込
  status        TEXT,
  PRIMARY KEY (case_id, mall, order_item_id)
);

CREATE INDEX idx_order_items_date ON order_items (case_id, mall, date);

-- 取り込みの進み具合。途中で閉じても続きから再開できるようにする
CREATE TABLE backfill (
  case_id    TEXT NOT NULL REFERENCES cases(id),
  kind       TEXT NOT NULL,                     -- orders | finances
  from_date  TEXT NOT NULL,
  to_date    TEXT NOT NULL,
  cursor     TEXT,                              -- orders: NextToken ／ finances: 次に取る日
  done       INTEGER NOT NULL DEFAULT 0,
  total      INTEGER NOT NULL DEFAULT 0,
  status     TEXT NOT NULL,                     -- running | done | error
  note       TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (case_id, kind)
);
