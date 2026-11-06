-- セール・イベント
-- 全案件共通のもの（case_id が NULL）と、案件だけのもの（自社クーポンなど）がある。
-- 日時は日本時間 'YYYY-MM-DD HH:MM'。先行セールがあるものは presale_at に始まりを入れる
CREATE TABLE IF NOT EXISTS sale_events (
  id          TEXT PRIMARY KEY,
  case_id     TEXT REFERENCES cases(id),
  mall        TEXT NOT NULL CHECK (mall IN ('amazon','rakuten')),
  kind        TEXT NOT NULL DEFAULT 'other',      -- supersale / marathon / primeday / big / smile / own / other
  name        TEXT NOT NULL,
  start_at    TEXT NOT NULL,
  end_at      TEXT NOT NULL,
  presale_at  TEXT,
  source      TEXT NOT NULL DEFAULT 'manual',     -- preset（最初から登録）/ manual（手で登録）
  confidence  TEXT NOT NULL DEFAULT 'confirmed',  -- confirmed / estimated（日程は要確認）
  note        TEXT,
  updated_by  TEXT,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sale_events_period ON sale_events(start_at, end_at);

-- 案件ごとの参加・不参加。行が無ければ「参加」として扱う
CREATE TABLE IF NOT EXISTS case_event_participation (
  case_id       TEXT NOT NULL REFERENCES cases(id),
  event_id      TEXT NOT NULL REFERENCES sale_events(id),
  participating INTEGER NOT NULL DEFAULT 1,
  updated_by    TEXT,
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (case_id, event_id)
);

-- 2025〜2026年の主なイベント（公開情報のまとめから作成。estimated は日程が未確認のもの）

INSERT OR IGNORE INTO sale_events (id, mall, kind, name, start_at, end_at, presale_at, source, confidence) VALUES ('ev-r-2025-01-01-other', 'rakuten', 'other', '超ポイントバック祭', '2025-01-01 00:00', '2025-01-03 23:59', NULL, 'preset', 'confirmed');
INSERT OR IGNORE INTO sale_events (id, mall, kind, name, start_at, end_at, presale_at, source, confidence) VALUES ('ev-r-2025-01-09-marathon', 'rakuten', 'marathon', 'お買い物マラソン', '2025-01-09 20:00', '2025-01-16 01:59', NULL, 'preset', 'confirmed');
INSERT OR IGNORE INTO sale_events (id, mall, kind, name, start_at, end_at, presale_at, source, confidence) VALUES ('ev-r-2025-01-24-marathon', 'rakuten', 'marathon', 'お買い物マラソン', '2025-01-24 20:00', '2025-01-29 01:59', NULL, 'preset', 'confirmed');
INSERT OR IGNORE INTO sale_events (id, mall, kind, name, start_at, end_at, presale_at, source, confidence) VALUES ('ev-r-2025-02-04-marathon', 'rakuten', 'marathon', 'お買い物マラソン', '2025-02-04 20:00', '2025-02-10 01:59', NULL, 'preset', 'confirmed');
INSERT OR IGNORE INTO sale_events (id, mall, kind, name, start_at, end_at, presale_at, source, confidence) VALUES ('ev-r-2025-02-19-marathon', 'rakuten', 'marathon', 'お買い物マラソン', '2025-02-19 20:00', '2025-02-23 01:59', NULL, 'preset', 'confirmed');
INSERT OR IGNORE INTO sale_events (id, mall, kind, name, start_at, end_at, presale_at, source, confidence) VALUES ('ev-r-2025-03-21-marathon', 'rakuten', 'marathon', 'お買い物マラソン', '2025-03-21 20:00', '2025-03-27 01:59', NULL, 'preset', 'confirmed');
INSERT OR IGNORE INTO sale_events (id, mall, kind, name, start_at, end_at, presale_at, source, confidence) VALUES ('ev-r-2025-04-04-marathon', 'rakuten', 'marathon', 'お買い物マラソン', '2025-04-04 20:00', '2025-04-10 01:59', NULL, 'preset', 'confirmed');
INSERT OR IGNORE INTO sale_events (id, mall, kind, name, start_at, end_at, presale_at, source, confidence) VALUES ('ev-r-2025-04-14-marathon', 'rakuten', 'marathon', 'お買い物マラソン', '2025-04-14 20:00', '2025-04-17 01:59', NULL, 'preset', 'confirmed');
INSERT OR IGNORE INTO sale_events (id, mall, kind, name, start_at, end_at, presale_at, source, confidence) VALUES ('ev-r-2025-04-24-marathon', 'rakuten', 'marathon', 'お買い物マラソン', '2025-04-24 20:00', '2025-04-27 01:59', NULL, 'preset', 'confirmed');
INSERT OR IGNORE INTO sale_events (id, mall, kind, name, start_at, end_at, presale_at, source, confidence) VALUES ('ev-r-2025-05-09-marathon', 'rakuten', 'marathon', 'お買い物マラソン', '2025-05-09 20:00', '2025-05-16 01:59', NULL, 'preset', 'confirmed');
INSERT OR IGNORE INTO sale_events (id, mall, kind, name, start_at, end_at, presale_at, source, confidence) VALUES ('ev-r-2025-05-23-marathon', 'rakuten', 'marathon', 'お買い物マラソン', '2025-05-23 20:00', '2025-05-27 01:59', NULL, 'preset', 'confirmed');
INSERT OR IGNORE INTO sale_events (id, mall, kind, name, start_at, end_at, presale_at, source, confidence) VALUES ('ev-r-2025-06-22-marathon', 'rakuten', 'marathon', 'お買い物マラソン', '2025-06-22 20:00', '2025-06-27 01:59', NULL, 'preset', 'confirmed');
INSERT OR IGNORE INTO sale_events (id, mall, kind, name, start_at, end_at, presale_at, source, confidence) VALUES ('ev-r-2025-07-04-marathon', 'rakuten', 'marathon', 'お買い物マラソン', '2025-07-04 20:00', '2025-07-11 01:59', NULL, 'preset', 'confirmed');
INSERT OR IGNORE INTO sale_events (id, mall, kind, name, start_at, end_at, presale_at, source, confidence) VALUES ('ev-r-2025-07-19-marathon', 'rakuten', 'marathon', 'お買い物マラソン', '2025-07-19 20:00', '2025-07-26 01:59', NULL, 'preset', 'confirmed');
INSERT OR IGNORE INTO sale_events (id, mall, kind, name, start_at, end_at, presale_at, source, confidence) VALUES ('ev-r-2025-08-04-marathon', 'rakuten', 'marathon', 'お買い物マラソン', '2025-08-04 20:00', '2025-08-11 01:59', NULL, 'preset', 'confirmed');
INSERT OR IGNORE INTO sale_events (id, mall, kind, name, start_at, end_at, presale_at, source, confidence) VALUES ('ev-r-2025-08-24-marathon', 'rakuten', 'marathon', 'お買い物マラソン', '2025-08-24 20:00', '2025-08-27 01:59', NULL, 'preset', 'confirmed');
INSERT OR IGNORE INTO sale_events (id, mall, kind, name, start_at, end_at, presale_at, source, confidence) VALUES ('ev-r-2025-10-04-marathon', 'rakuten', 'marathon', 'お買い物マラソン', '2025-10-04 20:00', '2025-10-09 01:59', NULL, 'preset', 'confirmed');
INSERT OR IGNORE INTO sale_events (id, mall, kind, name, start_at, end_at, presale_at, source, confidence) VALUES ('ev-r-2025-10-14-marathon', 'rakuten', 'marathon', 'お買い物マラソン', '2025-10-14 20:00', '2025-10-17 01:59', NULL, 'preset', 'confirmed');
INSERT OR IGNORE INTO sale_events (id, mall, kind, name, start_at, end_at, presale_at, source, confidence) VALUES ('ev-r-2025-10-24-marathon', 'rakuten', 'marathon', 'お買い物マラソン', '2025-10-24 20:00', '2025-10-27 01:59', NULL, 'preset', 'confirmed');
INSERT OR IGNORE INTO sale_events (id, mall, kind, name, start_at, end_at, presale_at, source, confidence) VALUES ('ev-r-2025-11-04-marathon', 'rakuten', 'marathon', 'お買い物マラソン', '2025-11-04 20:00', '2025-11-11 01:59', NULL, 'preset', 'confirmed');
INSERT OR IGNORE INTO sale_events (id, mall, kind, name, start_at, end_at, presale_at, source, confidence) VALUES ('ev-r-2025-09-19-marathon', 'rakuten', 'marathon', 'お買い物マラソン', '2025-09-19 20:00', '2025-09-24 01:59', NULL, 'preset', 'estimated');
INSERT OR IGNORE INTO sale_events (id, mall, kind, name, start_at, end_at, presale_at, source, confidence) VALUES ('ev-r-2025-03-04-supersale', 'rakuten', 'supersale', '楽天スーパーSALE', '2025-03-04 20:00', '2025-03-11 01:59', NULL, 'preset', 'confirmed');
INSERT OR IGNORE INTO sale_events (id, mall, kind, name, start_at, end_at, presale_at, source, confidence) VALUES ('ev-r-2025-06-04-supersale', 'rakuten', 'supersale', '楽天スーパーSALE', '2025-06-04 20:00', '2025-06-11 01:59', NULL, 'preset', 'confirmed');
INSERT OR IGNORE INTO sale_events (id, mall, kind, name, start_at, end_at, presale_at, source, confidence) VALUES ('ev-r-2025-09-04-supersale', 'rakuten', 'supersale', '楽天スーパーSALE', '2025-09-04 20:00', '2025-09-11 01:59', NULL, 'preset', 'confirmed');
INSERT OR IGNORE INTO sale_events (id, mall, kind, name, start_at, end_at, presale_at, source, confidence) VALUES ('ev-r-2025-12-04-supersale', 'rakuten', 'supersale', '楽天スーパーSALE', '2025-12-04 20:00', '2025-12-11 01:59', NULL, 'preset', 'confirmed');
INSERT OR IGNORE INTO sale_events (id, mall, kind, name, start_at, end_at, presale_at, source, confidence) VALUES ('ev-r-2025-11-20-big', 'rakuten', 'big', '楽天ブラックフライデー', '2025-11-20 20:00', '2025-11-27 01:59', NULL, 'preset', 'confirmed');
INSERT OR IGNORE INTO sale_events (id, mall, kind, name, start_at, end_at, presale_at, source, confidence) VALUES ('ev-r-2025-12-13-other', 'rakuten', 'other', '超ポイントバック祭', '2025-12-13 00:00', '2025-12-15 23:59', NULL, 'preset', 'confirmed');
INSERT OR IGNORE INTO sale_events (id, mall, kind, name, start_at, end_at, presale_at, source, confidence) VALUES ('ev-r-2025-12-19-big', 'rakuten', 'big', '楽天大感謝祭', '2025-12-19 20:00', '2025-12-26 01:59', NULL, 'preset', 'confirmed');
INSERT OR IGNORE INTO sale_events (id, mall, kind, name, start_at, end_at, presale_at, source, confidence) VALUES ('ev-r-2026-01-01-other', 'rakuten', 'other', '超ポイントバック祭', '2026-01-01 00:00', '2026-01-03 23:59', NULL, 'preset', 'confirmed');
INSERT OR IGNORE INTO sale_events (id, mall, kind, name, start_at, end_at, presale_at, source, confidence) VALUES ('ev-r-2026-01-09-marathon', 'rakuten', 'marathon', 'お買い物マラソン', '2026-01-09 20:00', '2026-01-16 01:59', NULL, 'preset', 'confirmed');
INSERT OR IGNORE INTO sale_events (id, mall, kind, name, start_at, end_at, presale_at, source, confidence) VALUES ('ev-r-2026-01-24-marathon', 'rakuten', 'marathon', 'お買い物マラソン', '2026-01-24 20:00', '2026-01-29 01:59', NULL, 'preset', 'confirmed');
INSERT OR IGNORE INTO sale_events (id, mall, kind, name, start_at, end_at, presale_at, source, confidence) VALUES ('ev-r-2026-02-04-marathon', 'rakuten', 'marathon', 'お買い物マラソン', '2026-02-04 20:00', '2026-02-10 01:59', NULL, 'preset', 'confirmed');
INSERT OR IGNORE INTO sale_events (id, mall, kind, name, start_at, end_at, presale_at, source, confidence) VALUES ('ev-r-2026-02-19-marathon', 'rakuten', 'marathon', 'お買い物マラソン', '2026-02-19 20:00', '2026-02-23 01:59', NULL, 'preset', 'confirmed');
INSERT OR IGNORE INTO sale_events (id, mall, kind, name, start_at, end_at, presale_at, source, confidence) VALUES ('ev-r-2026-03-20-marathon', 'rakuten', 'marathon', 'お買い物マラソン', '2026-03-20 20:00', '2026-03-26 01:59', NULL, 'preset', 'confirmed');
INSERT OR IGNORE INTO sale_events (id, mall, kind, name, start_at, end_at, presale_at, source, confidence) VALUES ('ev-r-2026-04-04-marathon', 'rakuten', 'marathon', 'お買い物マラソン', '2026-04-04 20:00', '2026-04-10 01:59', NULL, 'preset', 'confirmed');
INSERT OR IGNORE INTO sale_events (id, mall, kind, name, start_at, end_at, presale_at, source, confidence) VALUES ('ev-r-2026-04-14-marathon', 'rakuten', 'marathon', 'お買い物マラソン', '2026-04-14 20:00', '2026-04-17 01:59', NULL, 'preset', 'confirmed');
INSERT OR IGNORE INTO sale_events (id, mall, kind, name, start_at, end_at, presale_at, source, confidence) VALUES ('ev-r-2026-04-24-marathon', 'rakuten', 'marathon', 'お買い物マラソン', '2026-04-24 20:00', '2026-04-27 01:59', NULL, 'preset', 'confirmed');
INSERT OR IGNORE INTO sale_events (id, mall, kind, name, start_at, end_at, presale_at, source, confidence) VALUES ('ev-r-2026-05-09-marathon', 'rakuten', 'marathon', 'お買い物マラソン', '2026-05-09 20:00', '2026-05-16 01:59', NULL, 'preset', 'confirmed');
INSERT OR IGNORE INTO sale_events (id, mall, kind, name, start_at, end_at, presale_at, source, confidence) VALUES ('ev-r-2026-05-23-marathon', 'rakuten', 'marathon', 'お買い物マラソン', '2026-05-23 20:00', '2026-05-27 01:59', NULL, 'preset', 'confirmed');
INSERT OR IGNORE INTO sale_events (id, mall, kind, name, start_at, end_at, presale_at, source, confidence) VALUES ('ev-r-2026-11-04-marathon', 'rakuten', 'marathon', 'お買い物マラソン', '2026-11-04 20:00', '2026-11-11 01:59', NULL, 'preset', 'confirmed');
INSERT OR IGNORE INTO sale_events (id, mall, kind, name, start_at, end_at, presale_at, source, confidence) VALUES ('ev-r-2026-06-20-marathon', 'rakuten', 'marathon', 'お買い物マラソン', '2026-06-20 20:00', '2026-06-26 01:59', NULL, 'preset', 'estimated');
INSERT OR IGNORE INTO sale_events (id, mall, kind, name, start_at, end_at, presale_at, source, confidence) VALUES ('ev-r-2026-07-04-marathon', 'rakuten', 'marathon', 'お買い物マラソン', '2026-07-04 20:00', '2026-07-11 01:59', NULL, 'preset', 'estimated');
INSERT OR IGNORE INTO sale_events (id, mall, kind, name, start_at, end_at, presale_at, source, confidence) VALUES ('ev-r-2026-07-19-marathon', 'rakuten', 'marathon', 'お買い物マラソン', '2026-07-19 20:00', '2026-07-26 01:59', NULL, 'preset', 'estimated');
INSERT OR IGNORE INTO sale_events (id, mall, kind, name, start_at, end_at, presale_at, source, confidence) VALUES ('ev-r-2026-08-04-marathon', 'rakuten', 'marathon', 'お買い物マラソン', '2026-08-04 20:00', '2026-08-11 01:59', NULL, 'preset', 'estimated');
INSERT OR IGNORE INTO sale_events (id, mall, kind, name, start_at, end_at, presale_at, source, confidence) VALUES ('ev-r-2026-08-24-marathon', 'rakuten', 'marathon', 'お買い物マラソン', '2026-08-24 20:00', '2026-08-27 01:59', NULL, 'preset', 'estimated');
INSERT OR IGNORE INTO sale_events (id, mall, kind, name, start_at, end_at, presale_at, source, confidence) VALUES ('ev-r-2026-09-19-marathon', 'rakuten', 'marathon', 'お買い物マラソン', '2026-09-19 20:00', '2026-09-24 01:59', NULL, 'preset', 'estimated');
INSERT OR IGNORE INTO sale_events (id, mall, kind, name, start_at, end_at, presale_at, source, confidence) VALUES ('ev-r-2026-10-04-marathon', 'rakuten', 'marathon', 'お買い物マラソン', '2026-10-04 20:00', '2026-10-09 01:59', NULL, 'preset', 'estimated');
INSERT OR IGNORE INTO sale_events (id, mall, kind, name, start_at, end_at, presale_at, source, confidence) VALUES ('ev-r-2026-10-14-marathon', 'rakuten', 'marathon', 'お買い物マラソン', '2026-10-14 20:00', '2026-10-17 01:59', NULL, 'preset', 'estimated');
INSERT OR IGNORE INTO sale_events (id, mall, kind, name, start_at, end_at, presale_at, source, confidence) VALUES ('ev-r-2026-10-24-marathon', 'rakuten', 'marathon', 'お買い物マラソン', '2026-10-24 20:00', '2026-10-27 01:59', NULL, 'preset', 'estimated');
INSERT OR IGNORE INTO sale_events (id, mall, kind, name, start_at, end_at, presale_at, source, confidence) VALUES ('ev-r-2026-03-04-supersale', 'rakuten', 'supersale', '楽天スーパーSALE', '2026-03-04 20:00', '2026-03-11 01:59', NULL, 'preset', 'estimated');
INSERT OR IGNORE INTO sale_events (id, mall, kind, name, start_at, end_at, presale_at, source, confidence) VALUES ('ev-r-2026-06-04-supersale', 'rakuten', 'supersale', '楽天スーパーSALE', '2026-06-04 20:00', '2026-06-11 01:59', NULL, 'preset', 'estimated');
INSERT OR IGNORE INTO sale_events (id, mall, kind, name, start_at, end_at, presale_at, source, confidence) VALUES ('ev-r-2026-09-04-supersale', 'rakuten', 'supersale', '楽天スーパーSALE', '2026-09-04 20:00', '2026-09-11 01:59', NULL, 'preset', 'confirmed');
INSERT OR IGNORE INTO sale_events (id, mall, kind, name, start_at, end_at, presale_at, source, confidence) VALUES ('ev-r-2026-12-04-supersale', 'rakuten', 'supersale', '楽天スーパーSALE', '2026-12-04 20:00', '2026-12-11 01:59', NULL, 'preset', 'estimated');
INSERT OR IGNORE INTO sale_events (id, mall, kind, name, start_at, end_at, presale_at, source, confidence) VALUES ('ev-r-2026-11-20-big', 'rakuten', 'big', '楽天ブラックフライデー', '2026-11-20 20:00', '2026-11-27 01:59', NULL, 'preset', 'estimated');
INSERT OR IGNORE INTO sale_events (id, mall, kind, name, start_at, end_at, presale_at, source, confidence) VALUES ('ev-a-2025-01-03-big', 'amazon', 'big', '初売り', '2025-01-03 00:00', '2025-01-07 23:59', NULL, 'preset', 'confirmed');
INSERT OR IGNORE INTO sale_events (id, mall, kind, name, start_at, end_at, presale_at, source, confidence) VALUES ('ev-a-2025-02-28-big', 'amazon', 'big', '新生活セール', '2025-02-28 00:00', '2025-03-04 23:59', NULL, 'preset', 'confirmed');
INSERT OR IGNORE INTO sale_events (id, mall, kind, name, start_at, end_at, presale_at, source, confidence) VALUES ('ev-a-2025-03-28-big', 'amazon', 'big', '新生活セールFINAL', '2025-03-28 00:00', '2025-04-01 23:59', NULL, 'preset', 'confirmed');
INSERT OR IGNORE INTO sale_events (id, mall, kind, name, start_at, end_at, presale_at, source, confidence) VALUES ('ev-a-2025-04-18-smile', 'amazon', 'smile', 'スマイルSALE（GW）', '2025-04-18 00:00', '2025-04-21 23:59', NULL, 'preset', 'confirmed');
INSERT OR IGNORE INTO sale_events (id, mall, kind, name, start_at, end_at, presale_at, source, confidence) VALUES ('ev-a-2025-07-11-primeday', 'amazon', 'primeday', 'プライムデー', '2025-07-11 00:00', '2025-07-14 23:59', NULL, 'preset', 'confirmed');
INSERT OR IGNORE INTO sale_events (id, mall, kind, name, start_at, end_at, presale_at, source, confidence) VALUES ('ev-a-2025-10-07-big', 'amazon', 'big', 'プライム感謝祭', '2025-10-07 00:00', '2025-10-10 23:59', NULL, 'preset', 'confirmed');
INSERT OR IGNORE INTO sale_events (id, mall, kind, name, start_at, end_at, presale_at, source, confidence) VALUES ('ev-a-2025-11-24-big', 'amazon', 'big', 'ブラックフライデー', '2025-11-24 00:00', '2025-12-01 23:59', NULL, 'preset', 'confirmed');
INSERT OR IGNORE INTO sale_events (id, mall, kind, name, start_at, end_at, presale_at, source, confidence) VALUES ('ev-a-2026-01-03-big', 'amazon', 'big', '初売り', '2026-01-03 00:00', '2026-01-07 23:59', NULL, 'preset', 'confirmed');
INSERT OR IGNORE INTO sale_events (id, mall, kind, name, start_at, end_at, presale_at, source, confidence) VALUES ('ev-a-2026-01-27-smile', 'amazon', 'smile', 'スマイルSALE', '2026-01-27 00:00', '2026-02-02 23:59', NULL, 'preset', 'confirmed');
INSERT OR IGNORE INTO sale_events (id, mall, kind, name, start_at, end_at, presale_at, source, confidence) VALUES ('ev-a-2026-03-06-big', 'amazon', 'big', '新生活セール', '2026-03-06 00:00', '2026-03-09 23:59', '2026-03-03 00:00', 'preset', 'confirmed');
INSERT OR IGNORE INTO sale_events (id, mall, kind, name, start_at, end_at, presale_at, source, confidence) VALUES ('ev-a-2026-04-03-big', 'amazon', 'big', '新生活セールFINAL', '2026-04-03 00:00', '2026-04-06 23:59', '2026-03-31 00:00', 'preset', 'confirmed');
INSERT OR IGNORE INTO sale_events (id, mall, kind, name, start_at, end_at, presale_at, source, confidence) VALUES ('ev-a-2026-04-30-smile', 'amazon', 'smile', 'スマイルSALE（GW）', '2026-04-30 00:00', '2026-05-03 23:59', NULL, 'preset', 'confirmed');
INSERT OR IGNORE INTO sale_events (id, mall, kind, name, start_at, end_at, presale_at, source, confidence) VALUES ('ev-a-2026-05-27-smile', 'amazon', 'smile', 'スマイルSALE', '2026-05-27 00:00', '2026-06-02 23:59', NULL, 'preset', 'confirmed');
INSERT OR IGNORE INTO sale_events (id, mall, kind, name, start_at, end_at, presale_at, source, confidence) VALUES ('ev-a-2026-07-10-primeday', 'amazon', 'primeday', 'プライムデー', '2026-07-10 00:00', '2026-07-13 23:59', '2026-07-07 00:00', 'preset', 'confirmed');
INSERT OR IGNORE INTO sale_events (id, mall, kind, name, start_at, end_at, presale_at, source, confidence) VALUES ('ev-a-2026-08-28-smile', 'amazon', 'smile', 'スマイルSALE', '2026-08-28 00:00', '2026-09-03 23:59', NULL, 'preset', 'confirmed');
INSERT OR IGNORE INTO sale_events (id, mall, kind, name, start_at, end_at, presale_at, source, confidence) VALUES ('ev-a-2026-10-16-big', 'amazon', 'big', 'プライム感謝祭', '2026-10-16 00:00', '2026-10-19 23:59', '2026-10-13 00:00', 'preset', 'confirmed');
INSERT OR IGNORE INTO sale_events (id, mall, kind, name, start_at, end_at, presale_at, source, confidence) VALUES ('ev-a-2026-11-04-smile', 'amazon', 'smile', 'スマイルSALE', '2026-11-04 00:00', '2026-11-12 23:59', NULL, 'preset', 'confirmed');
