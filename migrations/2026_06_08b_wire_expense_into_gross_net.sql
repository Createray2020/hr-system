-- migrations/2026_06_08b_wire_expense_into_gross_net.sql
-- 把 expense_reimbursement_total 接進 gross_salary / net_salary
-- 兩欄為 GENERATED STORED,只能 DROP 後重建;值自動重算、不掉資料
-- 冪等(DROP IF EXISTS 後重建);若有 view 依賴會在交易內 abort 不動 prod
-- 回滾見檔尾:重建為不含 expense 的原始產生式

BEGIN;

-- 重建前列出依賴物件(若有 view 依賴,下方 DROP 會整筆 abort,把錯誤貼回給我)
DO $$
DECLARE dep_count int;
BEGIN
  SELECT count(*) INTO dep_count
  FROM pg_depend d
  JOIN pg_rewrite r ON r.oid = d.objid
  JOIN pg_class c ON c.oid = r.ev_class
  JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
  WHERE d.refobjid = 'public.salary_records'::regclass
    AND a.attname IN ('gross_salary','net_salary');
  IF dep_count > 0 THEN
    RAISE NOTICE '偵測到 % 個物件依賴 gross_salary/net_salary,重建可能需處理依賴', dep_count;
  END IF;
END $$;

ALTER TABLE public.salary_records DROP COLUMN IF EXISTS gross_salary;
ALTER TABLE public.salary_records DROP COLUMN IF EXISTS net_salary;

ALTER TABLE public.salary_records
  ADD COLUMN gross_salary numeric GENERATED ALWAYS AS (
    (((((((((((((((COALESCE(prorata_base, base_salary) + COALESCE(attendance_bonus_actual, (0)::numeric)) + COALESCE(grade_allowance, (0)::numeric)) + COALESCE(manager_allowance, (0)::numeric)) + COALESCE(allowance, (0)::numeric)) + COALESCE(extra_allowance, (0)::numeric)) + COALESCE(night_allowance, (0)::numeric)) + COALESCE((overtime_pay_auto + overtime_pay_manual), (0)::numeric)) + COALESCE(comp_expiry_payout, (0)::numeric)) + COALESCE(holiday_work_pay, (0)::numeric)) + COALESCE(settlement_amount, (0)::numeric)) + COALESCE(bonus_yearend, (0)::numeric)) + COALESCE(bonus_festival, (0)::numeric)) + COALESCE(bonus_performance, (0)::numeric)) + COALESCE(bonus_other, (0)::numeric)) + COALESCE(expense_reimbursement_total, (0)::numeric))
  ) STORED;

ALTER TABLE public.salary_records
  ADD COLUMN net_salary numeric GENERATED ALWAYS AS (
    (((((((((((((((((((((((((((COALESCE(prorata_base, base_salary) + COALESCE(attendance_bonus_actual, (0)::numeric)) + COALESCE(grade_allowance, (0)::numeric)) + COALESCE(manager_allowance, (0)::numeric)) + COALESCE(allowance, (0)::numeric)) + COALESCE(extra_allowance, (0)::numeric)) + COALESCE(night_allowance, (0)::numeric)) + COALESCE((overtime_pay_auto + overtime_pay_manual), (0)::numeric)) + COALESCE(comp_expiry_payout, (0)::numeric)) + COALESCE(holiday_work_pay, (0)::numeric)) + COALESCE(settlement_amount, (0)::numeric)) + COALESCE(bonus_yearend, (0)::numeric)) + COALESCE(bonus_festival, (0)::numeric)) + COALESCE(bonus_performance, (0)::numeric)) + COALESCE(bonus_other, (0)::numeric)) + COALESCE(expense_reimbursement_total, (0)::numeric)) - COALESCE(deduct_absence, (0)::numeric)) - COALESCE(deduct_labor_ins, (0)::numeric)) - COALESCE(deduct_health_ins, (0)::numeric)) - COALESCE(deduct_tax, (0)::numeric)) - COALESCE(attendance_penalty_total, (0)::numeric)) - COALESCE(deduct_pension_voluntary, (0)::numeric)) - COALESCE(deduct_supplementary_health, (0)::numeric)) - COALESCE(deduct_welfare_fund, (0)::numeric)) - COALESCE(deduct_union_fee, (0)::numeric)) - COALESCE(deduct_court_garnishment, (0)::numeric)) - COALESCE(deduct_loan_repayment, (0)::numeric)) - COALESCE(deduct_other, (0)::numeric))
  ) STORED;

COMMIT;

-- 回滾(正常不要執行):重建為原始不含 expense 的產生式
-- BEGIN;
-- ALTER TABLE public.salary_records DROP COLUMN IF EXISTS gross_salary;
-- ALTER TABLE public.salary_records DROP COLUMN IF EXISTS net_salary;
-- ALTER TABLE public.salary_records ADD COLUMN gross_salary numeric GENERATED ALWAYS AS (...原始式...) STORED;
-- ALTER TABLE public.salary_records ADD COLUMN net_salary  numeric GENERATED ALWAYS AS (...原始式...) STORED;
-- COMMIT;
