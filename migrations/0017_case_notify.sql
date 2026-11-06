-- 通知の種類ごとのオン・オフ（案件ごと）。
-- 例：在庫が少ないことはダッシュボードで見たいが、Slack には流さない、に対応するため
ALTER TABLE case_slack ADD COLUMN stock_alert INTEGER NOT NULL DEFAULT 1;
ALTER TABLE case_slack ADD COLUMN settings_notice INTEGER NOT NULL DEFAULT 1;
ALTER TABLE case_slack ADD COLUMN license_alert INTEGER NOT NULL DEFAULT 1;
