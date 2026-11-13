-- 月の広告予算（Amazon＋楽天のモール広告の合計・税別）。案件×月の金額を手入力する（ダッシュボードの「今月の広告予算」）。
-- モール間の配分の提案はこれを上限にする：超えるペースなら減らす、余裕があり利益の出ているモールがあれば増やす
CREATE TABLE IF NOT EXISTS ad_budgets (
  case_id    TEXT NOT NULL REFERENCES cases(id),
  month      TEXT NOT NULL,                 -- YYYY-MM
  amount     INTEGER NOT NULL,              -- 税別
  updated_by TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (case_id, month)
);
