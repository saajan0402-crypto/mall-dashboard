-- キーワード発見の候補を「一括に入れる」にしたもの。広告タブの一括ファイル（Amazon の一括操作・楽天RPP のキーワード一括登録）に追加の行として入る。
-- 書き出して「対応済み」にしたら消え、todo_status の kw_added:… が done になる（対応の記録・レポートに載る）
CREATE TABLE IF NOT EXISTS kw_plan (
  case_id     TEXT NOT NULL REFERENCES cases(id),
  mall        TEXT NOT NULL,
  keyword     TEXT NOT NULL,
  source      TEXT,
  product_ids TEXT,                  -- 関連商品（JSON の配列）。入れる先の広告グループ・楽天の商品ページを決めるのに使う
  planned_by  TEXT,
  planned_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (case_id, mall, keyword)
);

-- 楽天RPP：ツールから追加したキーワード（育成中）。低い入札で入れ、14日ごとにクリックが少なければ +20%（上限は損益分岐のCPC）
CREATE TABLE IF NOT EXISTS kw_grow (
  case_id     TEXT NOT NULL REFERENCES cases(id),
  mall        TEXT NOT NULL,
  external_id TEXT NOT NULL,         -- 楽天：商品管理番号
  keyword     TEXT NOT NULL,
  start_bid   INTEGER NOT NULL,
  bid         INTEGER NOT NULL,      -- ツールで最後に入れた入札（一括ファイルを対応済みにしたとき更新）
  changed_on  TEXT NOT NULL,         -- 最後に入札を入れた日（日本時間）
  added_on    TEXT NOT NULL,
  added_by    TEXT,
  PRIMARY KEY (case_id, mall, external_id, keyword)
);
