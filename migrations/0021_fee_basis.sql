-- Amazon の入金明細を「どの日付で数えるか」を2通り持つ。
--   release：旧 API（Finances v0）。注文の取引はお金が使えるようになった日（出荷の7〜10日後）で返ってくる
--   posted ：新 API（Finances 2024-06-19 listTransactions）。出荷・計上した日。留保中も含む。
--            セラーセントラルの日付範囲レポートと同じ数え方
-- 切り替えまでは両方を取り込んで並べ、月次確定で一致を確かめてから app_flags で切り替える
ALTER TABLE fee_events ADD COLUMN basis TEXT NOT NULL DEFAULT 'release';
-- 出荷数（新 API の ProductContext.quantityShipped）。出荷日ベースの販売数に使う
ALTER TABLE fee_events ADD COLUMN quantity INTEGER;
-- 留保中（DEFERRED）か
ALTER TABLE fee_events ADD COLUMN deferred INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_fee_events_basis ON fee_events (case_id, mall, basis, date);

-- アプリ全体の切り替え（今は amazon_fee_basis だけ）
CREATE TABLE app_flags (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_by TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
