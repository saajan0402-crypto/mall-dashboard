-- 楽天の「請求・支払明細」（Shop_Billpay.csv）をそのまま取り込むための列。
--
-- 1つの明細に、対象月の違う項目が混ざって届く（例：10/20発行の明細に、システム利用料は7月分・楽天ペイ利用料は8月分）。
-- そのため「月ごとに消して入れ直す」では、別の明細から入れた同じ月の行まで消えてしまう。
-- 店舗別内訳書No（statement_no）ごとに消して入れ直す。
ALTER TABLE mall_charges ADD COLUMN statement_no TEXT;
-- 集約科目（システム利用料・決済手数料・販売促進費・物流費 など）
ALTER TABLE mall_charges ADD COLUMN category TEXT;
-- 税抜の金額と税率（amount は税込。アプリの金額はすべて税込でそろえている）
ALTER TABLE mall_charges ADD COLUMN amount_ex INTEGER;
ALTER TABLE mall_charges ADD COLUMN tax_rate INTEGER;
-- 1＝手数料に数えない（RPP の広告掲載料。広告費として広告タブで数えているので、二重に引かない）
ALTER TABLE mall_charges ADD COLUMN excluded INTEGER NOT NULL DEFAULT 0;

CREATE INDEX idx_mall_charges_statement ON mall_charges (case_id, mall, statement_no);
