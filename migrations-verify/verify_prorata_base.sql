-- ==========================================
-- Migration: 2026_05_26_prorata_base.sql
-- Phase:     B26 批次 3.5(salary_records 加 prorata_base + 改 GENERATED 公式)
-- 用途:     新欄位 prorata_base + DROP / RECREATE gross_salary / net_salary GENERATED
-- 類型:     ADD COLUMN + DROP/RECREATE 2 GENERATED column
-- 對齊:     migrations/2026_05_10_salary_records_v2.sql L117-160 既有公式攤開 pattern
-- ⚠ PG 限制:GENERATED 不能 reference 另一個 GENERATED(42P17)、所以 net 整段攤開、不 ref gross
-- ==========================================

-- ═══════════════════════════════════════════
-- ① VERIFY PRE
-- 預期:
--   Q1.1 prorata_base 不存在(此次 migration 才新加)
--   Q1.2 snapshot table 建好、含當前 row 數
--   Q1.3 既有 gross/net 是 GENERATED ALWAYS、公式含 12 income(含 4 bonus)/ 12 deduction
-- ═══════════════════════════════════════════

-- Q1.1 prorata_base 不存在
SELECT column_name FROM information_schema.columns
 WHERE table_schema='public' AND table_name='salary_records'
   AND column_name = 'prorata_base';
-- 預期:0 row

-- Q1.2 建 snapshot(用於 Q3.3 對比)
DROP TABLE IF EXISTS _b26_gross_net_snapshot;
CREATE TEMP TABLE _b26_gross_net_snapshot AS
  SELECT id, gross_salary, net_salary FROM salary_records;
SELECT COUNT(*) AS snapshot_rows FROM _b26_gross_net_snapshot;
-- 預期 1 row、snapshot_rows = 既有 salary_records 數

-- Q1.3 既有 GENERATED 公式 snapshot(對比用)
SELECT column_name, is_generated, generation_expression
  FROM information_schema.columns
 WHERE table_schema='public' AND table_name='salary_records'
   AND column_name IN ('gross_salary','net_salary')
 ORDER BY column_name;
-- 預期 2 row、is_generated='ALWAYS'、expression 不含 'prorata_base'(批次 3.5 前)


-- ═══════════════════════════════════════════
-- ② DROP + RECREATE(從原檔複製)
-- ═══════════════════════════════════════════

BEGIN;

ALTER TABLE salary_records ADD COLUMN IF NOT EXISTS
  prorata_base NUMERIC(12,2);

ALTER TABLE salary_records DROP COLUMN IF EXISTS net_salary;
ALTER TABLE salary_records DROP COLUMN IF EXISTS gross_salary;

ALTER TABLE salary_records ADD COLUMN gross_salary NUMERIC(12,2)
  GENERATED ALWAYS AS (
    COALESCE(prorata_base, base_salary)
    + COALESCE(attendance_bonus_actual, 0::numeric)
    + COALESCE(allowance, 0::numeric)
    + COALESCE(extra_allowance, 0::numeric)
    + COALESCE((overtime_pay_auto + overtime_pay_manual), 0::numeric)
    + COALESCE(comp_expiry_payout, 0::numeric)
    + COALESCE(holiday_work_pay, 0::numeric)
    + COALESCE(settlement_amount, 0::numeric)
    + COALESCE(bonus_yearend, 0::numeric)
    + COALESCE(bonus_festival, 0::numeric)
    + COALESCE(bonus_performance, 0::numeric)
    + COALESCE(bonus_other, 0::numeric)
  ) STORED;

ALTER TABLE salary_records ADD COLUMN net_salary NUMERIC(12,2)
  GENERATED ALWAYS AS (
    COALESCE(prorata_base, base_salary)
    + COALESCE(attendance_bonus_actual, 0::numeric)
    + COALESCE(allowance, 0::numeric)
    + COALESCE(extra_allowance, 0::numeric)
    + COALESCE((overtime_pay_auto + overtime_pay_manual), 0::numeric)
    + COALESCE(comp_expiry_payout, 0::numeric)
    + COALESCE(holiday_work_pay, 0::numeric)
    + COALESCE(settlement_amount, 0::numeric)
    + COALESCE(bonus_yearend, 0::numeric)
    + COALESCE(bonus_festival, 0::numeric)
    + COALESCE(bonus_performance, 0::numeric)
    + COALESCE(bonus_other, 0::numeric)
    - COALESCE(deduct_absence, 0::numeric)
    - COALESCE(deduct_labor_ins, 0::numeric)
    - COALESCE(deduct_health_ins, 0::numeric)
    - COALESCE(deduct_tax, 0::numeric)
    - COALESCE(attendance_penalty_total, 0::numeric)
    - COALESCE(deduct_pension_voluntary, 0::numeric)
    - COALESCE(deduct_supplementary_health, 0::numeric)
    - COALESCE(deduct_welfare_fund, 0::numeric)
    - COALESCE(deduct_union_fee, 0::numeric)
    - COALESCE(deduct_court_garnishment, 0::numeric)
    - COALESCE(deduct_loan_repayment, 0::numeric)
    - COALESCE(deduct_other, 0::numeric)
  ) STORED;

COMMIT;

NOTIFY pgrst, 'reload schema';


-- ═══════════════════════════════════════════
-- ③ VERIFY POST
-- 預期:
--   Q3.1 prorata_base NUMERIC(12,2)、nullable、非 GENERATED、預設 NULL
--   Q3.2 gross/net GENERATED ALWAYS、expression 含 'COALESCE(prorata_base, base_salary)'
--   Q3.3 ⚠ 既有 row gross/net 完全一致(0 diff、prorata_base NULL 走 base_salary)
--   Q3.4 抽 5 row snapshot 對比
--   Q3.5 柯郁含 record 驗(prorata_base NULL、gross/net 走 base_salary)
-- ═══════════════════════════════════════════

-- Q3.1 prorata_base 欄位
SELECT column_name, data_type, is_nullable, is_generated, column_default
  FROM information_schema.columns
 WHERE table_schema='public' AND table_name='salary_records'
   AND column_name = 'prorata_base';
-- 預期 1 row:numeric / YES / NEVER / NULL

-- Q3.2 gross/net GENERATED 公式
SELECT column_name, is_generated, generation_expression
  FROM information_schema.columns
 WHERE table_schema='public' AND table_name='salary_records'
   AND column_name IN ('gross_salary','net_salary')
 ORDER BY column_name;
-- 預期 2 row、is_generated='ALWAYS'、expression 內含 'COALESCE(prorata_base, base_salary)'

-- Q3.3 ⚠ 比對 migration 前後 gross/net 完全一致
SELECT s.id,
       b.gross_salary AS old_gross, s.gross_salary AS new_gross,
       (b.gross_salary - s.gross_salary) AS gross_diff,
       b.net_salary AS old_net, s.net_salary AS new_net,
       (b.net_salary - s.net_salary) AS net_diff
FROM salary_records s
JOIN _b26_gross_net_snapshot b ON b.id = s.id
WHERE COALESCE(b.gross_salary, 0) != COALESCE(s.gross_salary, 0)
   OR COALESCE(b.net_salary, 0)   != COALESCE(s.net_salary, 0);
-- 預期 0 row

-- Q3.4 抽 5 row 對比細節
SELECT s.id, s.base_salary, s.prorata_base,
       b.gross_salary AS old_gross, s.gross_salary AS new_gross,
       b.net_salary AS old_net, s.net_salary AS new_net
FROM salary_records s
JOIN _b26_gross_net_snapshot b ON b.id = s.id
ORDER BY s.id LIMIT 5;

-- Q3.5 柯郁含 record(批次 3 已建、批次 3.5 後 prorata_base 仍 NULL)
SELECT id, base_salary, prorata_base, is_final_month, worked_days, total_days_in_month,
       gross_salary, net_salary
FROM salary_records
WHERE id = 'S_EMP_01251101_2026_05';
-- 預期 prorata_base=NULL、is_final_month=true、worked_days=13、total_days_in_month=31
-- gross_salary / net_salary 走 base_salary 公式、未變(批次 4 calculator pro-rata 重算後才寫 prorata_base)


-- ═══════════════════════════════════════════
-- ④ ROLLBACK PLAN(Q3.3 diff > 0 或 Q3.5 異常時)
-- ═══════════════════════════════════════════
-- BEGIN;
-- ALTER TABLE salary_records DROP COLUMN net_salary;
-- ALTER TABLE salary_records DROP COLUMN gross_salary;
-- ALTER TABLE salary_records DROP COLUMN prorata_base;
--
-- -- 從 migrations/2026_05_10_salary_records_v2.sql L117-160 複製原公式
-- ALTER TABLE salary_records ADD COLUMN gross_salary NUMERIC(12,2)
--   GENERATED ALWAYS AS (
--     base_salary
--     + COALESCE(attendance_bonus_actual, 0)
--     + COALESCE(allowance, 0)
--     + COALESCE(extra_allowance, 0)
--     + COALESCE(overtime_pay_auto + overtime_pay_manual, 0)
--     + COALESCE(comp_expiry_payout, 0)
--     + COALESCE(holiday_work_pay, 0)
--     + COALESCE(settlement_amount, 0)
--     + COALESCE(bonus_yearend, 0)
--     + COALESCE(bonus_festival, 0)
--     + COALESCE(bonus_performance, 0)
--     + COALESCE(bonus_other, 0)
--   ) STORED;
--
-- ALTER TABLE salary_records ADD COLUMN net_salary NUMERIC(12,2)
--   GENERATED ALWAYS AS (
--     base_salary
--     + COALESCE(attendance_bonus_actual, 0)
--     + COALESCE(allowance, 0)
--     + COALESCE(extra_allowance, 0)
--     + COALESCE(overtime_pay_auto + overtime_pay_manual, 0)
--     + COALESCE(comp_expiry_payout, 0)
--     + COALESCE(holiday_work_pay, 0)
--     + COALESCE(settlement_amount, 0)
--     + COALESCE(bonus_yearend, 0)
--     + COALESCE(bonus_festival, 0)
--     + COALESCE(bonus_performance, 0)
--     + COALESCE(bonus_other, 0)
--     - COALESCE(deduct_absence, 0)
--     - COALESCE(deduct_labor_ins, 0)
--     - COALESCE(deduct_health_ins, 0)
--     - COALESCE(deduct_tax, 0)
--     - COALESCE(attendance_penalty_total, 0)
--     - COALESCE(deduct_pension_voluntary, 0)
--     - COALESCE(deduct_supplementary_health, 0)
--     - COALESCE(deduct_welfare_fund, 0)
--     - COALESCE(deduct_union_fee, 0)
--     - COALESCE(deduct_court_garnishment, 0)
--     - COALESCE(deduct_loan_repayment, 0)
--     - COALESCE(deduct_other, 0)
--   ) STORED;
-- COMMIT;
