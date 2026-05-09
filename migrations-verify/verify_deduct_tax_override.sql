-- 驗證 2.6.1: salary_records.deduct_tax_manual_override

-- §1. 欄位存在 + 屬性正確
SELECT column_name, data_type, column_default, is_nullable
FROM information_schema.columns
WHERE table_name='salary_records'
  AND column_name='deduct_tax_manual_override';
-- expect: 1 row、boolean / default false / NO

-- §2. backfill 結果
SELECT
  COUNT(*)                                                   AS total_rows,
  COUNT(*) FILTER (WHERE deduct_tax IS NOT NULL AND deduct_tax > 0) AS taxable_rows,
  COUNT(*) FILTER (WHERE deduct_tax IS NOT NULL AND deduct_tax > 0
                   AND deduct_tax_manual_override = true)    AS protected_rows,
  COUNT(*) FILTER (WHERE (deduct_tax IS NULL OR deduct_tax = 0)
                   AND deduct_tax_manual_override = false)   AS auto_rows
FROM salary_records;
-- expect: taxable_rows = protected_rows(全部有扣稅的都被保護)
-- expect: total_rows = protected_rows + auto_rows

-- §3. 全表 row count(防止漏資料)
SELECT COUNT(*) FROM salary_records;
-- expect: 47(階段 1.1 之後不變)

-- §4. comment 寫進去
SELECT col_description(
  (SELECT oid FROM pg_class WHERE relname='salary_records'),
  (SELECT ordinal_position FROM information_schema.columns
    WHERE table_name='salary_records' AND column_name='deduct_tax_manual_override')
) AS comment;
-- expect: comment 包含 '_auto' / 'calculator' 等關鍵字
