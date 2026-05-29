-- ===========================================================================
-- 2026-05-30: salary_records 加 grade_allowance / manager_allowance
--             + DROP / RECREATE gross_salary / net_salary GENERATED
-- ===========================================================================
--
-- 目的:
--   employees 已有 grade_allowance / manager_allowance(payroll baseline 2026-05-10
--   加,註解寫「經常性給付、列入投保薪資」),但 salary_records 沒對應欄位、
--   也沒進 gross_salary / net_salary GENERATED 公式 → 全公司每月少算
--   71,000 元(17 人 grade=59000 + 3 人 manager=12000)。
--   本檔補結構。calculator.js 接通 + 全月重跑由「另案」處理(本 migration
--   純結構、不 backfill 值)。
--
-- 為何 DROP + RECREATE:
--   gross_salary / net_salary 是 GENERATED ALWAYS ... STORED。Postgres 不支援
--   in-place 修改 generation expression、唯一辦法是 DROP + ADD。
--   net_salary 是完整攤開公式(不 reference gross,因 PG 42P17 限制不允許
--   一個 generated 欄位 reference 另一個 generated 欄位)→ 兩段都要動。
--   既有 4 次 DROP+RECREATE 慣例:
--     - migrations/2026_05_10_salary_records_v2.sql:116-160(獎金 4 欄+扣項 7 欄)
--     - migrations/2026_05_26_prorata_base.sql:55-106(prorata_base)
--     - supabase_extra_allowance.sql:15-23(extra_allowance)
--     - supabase_attendance_v2_batch_c.sql:100-117(attendance_bonus_actual)
--
-- 既有 row 影響:
--   新欄位 NULL → COALESCE(..., 0::numeric) 視為 0 → gross/net 數值不變。
--   發薪流程不漏接。後續 calculator.js 接通並逐人重算才會把
--   employees.grade_allowance / manager_allowance 灌進來。
--   本 migration 不 backfill。
--
-- 相依檢查:
--   repo 全文 grep .sql:無任何 VIEW / MATVIEW / 其他 generated 欄位 / index
--   參照 salary_records.gross_salary / net_salary(唯一一支 VIEW
--   attendance_monthly_summary,supabase_attendance_v2_batch_a.sql:505,
--   只走 attendance + employees、無關)。
--   prod 端因 PostgREST 無暴露 SQL RPC、無法 SELECT pg_depend 直接驗,
--   但 4 次同款 DROP+RECREATE 在 prod 都成功 → empirically 無 dependency。
-- ===========================================================================

BEGIN;

-- 1. 加兩個新欄位
--    nullable、無 default(對齊 allowance / extra_allowance,COALESCE 處理 NULL)
ALTER TABLE salary_records
  ADD COLUMN grade_allowance   NUMERIC(12,2),
  ADD COLUMN manager_allowance NUMERIC(12,2);

COMMENT ON COLUMN salary_records.grade_allowance   IS
  '職等加給(經常性、列入投保薪資)。calculator 從 employees.grade_allowance 同步。';
COMMENT ON COLUMN salary_records.manager_allowance IS
  '主管加給(經常性、列入投保薪資)。calculator 從 employees.manager_allowance 同步。';

-- 2. DROP 既有 gross_salary / net_salary
--    順序:net 先,gross 後(對齊既有 migration 慣例)
ALTER TABLE salary_records DROP COLUMN IF EXISTS net_salary;
ALTER TABLE salary_records DROP COLUMN IF EXISTS gross_salary;

-- 3. RECREATE gross_salary
--    原文照搬 migrations/2026_05_26_prorata_base.sql:61-75
--    唯一改動:在 attendance_bonus_actual 那一行的正下方,插入兩項:
--      + COALESCE(grade_allowance, 0::numeric)
--      + COALESCE(manager_allowance, 0::numeric)
ALTER TABLE salary_records ADD COLUMN gross_salary NUMERIC(12,2)
  GENERATED ALWAYS AS (
    COALESCE(prorata_base, base_salary)
    + COALESCE(attendance_bonus_actual, 0::numeric)
    + COALESCE(grade_allowance, 0::numeric)
    + COALESCE(manager_allowance, 0::numeric)
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

-- 4. RECREATE net_salary
--    原文照搬 migrations/2026_05_26_prorata_base.sql:80-106
--    唯一改動:在 attendance_bonus_actual 那一行的正下方,插入兩項:
--      + COALESCE(grade_allowance, 0::numeric)
--      + COALESCE(manager_allowance, 0::numeric)
--    (net 收入端與 gross 一致,扣項段未改動)
ALTER TABLE salary_records ADD COLUMN net_salary NUMERIC(12,2)
  GENERATED ALWAYS AS (
    COALESCE(prorata_base, base_salary)
    + COALESCE(attendance_bonus_actual, 0::numeric)
    + COALESCE(grade_allowance, 0::numeric)
    + COALESCE(manager_allowance, 0::numeric)
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
