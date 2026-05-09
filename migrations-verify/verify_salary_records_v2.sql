-- 驗證 1.1 migration: salary_records 擴 19 欄

-- §1. 獎金 5 欄(4 numeric + 1 note)
SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_name='salary_records'
  AND column_name IN ('bonus_yearend','bonus_festival','bonus_performance','bonus_other','bonus_other_note')
ORDER BY column_name;
-- expect: 5 rows

-- §2. 法定扣項 8 欄(7 numeric + 1 note)
SELECT column_name FROM information_schema.columns
WHERE table_name='salary_records'
  AND column_name IN (
    'deduct_pension_voluntary','deduct_supplementary_health',
    'deduct_welfare_fund','deduct_union_fee','deduct_court_garnishment',
    'deduct_loan_repayment','deduct_other','deduct_other_note'
  )
ORDER BY column_name;
-- expect: 8 rows

-- §3. snapshot 4 欄
SELECT column_name FROM information_schema.columns
WHERE table_name='salary_records'
  AND column_name IN (
    'taxable_income_snapshot','insured_salary_labor_snapshot',
    'insured_salary_health_snapshot','pension_wage_snapshot'
  )
ORDER BY column_name;
-- expect: 4 rows

-- §4. 雇主負擔 6 欄
SELECT column_name FROM information_schema.columns
WHERE table_name='salary_records'
  AND column_name LIKE 'employer_cost_%'
ORDER BY column_name;
-- expect: 6 rows

-- §5. period_id + audit 9 欄
SELECT column_name FROM information_schema.columns
WHERE table_name='salary_records'
  AND column_name IN (
    'payroll_period_id','calculated_at','calculated_by',
    'reviewed_by','reviewed_at','finalized_by','finalized_at','paid_by','paid_at'
  )
ORDER BY column_name;
-- expect: 9 rows

-- §6. status CHECK 包含 6 個 status
SELECT pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conrelid='salary_records'::regclass
  AND conname='salary_records_status_check';
-- expect: 1 row、定義含 'draft','calculating','pending_review','confirmed','paid','locked'

-- §7. gross_salary / net_salary 仍是 GENERATED
SELECT column_name, is_generated
FROM information_schema.columns
WHERE table_name='salary_records'
  AND column_name IN ('gross_salary','net_salary')
ORDER BY column_name;
-- expect: 2 rows、is_generated='ALWAYS'

-- §7. gross 公式涵蓋新獎金 4 欄
SELECT generation_expression
FROM information_schema.columns
WHERE table_name='salary_records' AND column_name='gross_salary';
-- expect: 公式含 bonus_yearend / bonus_festival / bonus_performance / bonus_other

-- §7. net 公式涵蓋新獎金 4 欄 + 新扣項 7 欄
SELECT generation_expression
FROM information_schema.columns
WHERE table_name='salary_records' AND column_name='net_salary';
-- expect: 公式含 bonus_* 4 欄 + deduct_pension_voluntary / deduct_supplementary_health / deduct_welfare_fund / deduct_union_fee / deduct_court_garnishment / deduct_loan_repayment / deduct_other

-- 既有資料 sanity check:gross/net 重新算後跟原本接近(獎金 / 扣項都 0)
SELECT id, year, month, base_salary, gross_salary, net_salary,
       bonus_yearend, bonus_festival, deduct_other
FROM salary_records
ORDER BY year DESC, month DESC
LIMIT 5;
-- expect: 既有 row bonus_*/deduct_other 都 0、gross/net 跟 migration 前一致

-- 全表 row count(防止漏資料)
SELECT count(*) FROM salary_records;
-- expect: 跟 migration 前一致(應該不變)
