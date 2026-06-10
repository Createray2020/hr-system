-- 20260611_add_deduct_unpaid_leave.sql
-- Phase 3 步驟 3B:把 leave_types.pay_rate 接進薪資扣薪
--
-- ⚠⚠⚠ 待 Ray 審核公式後才能上 prod、勿先跑 ⚠⚠⚠
--
-- 動的事:
--   (1) salary_records 加 deduct_unpaid_leave 欄(numeric NOT NULL DEFAULT 0)
--   (2) DROP + RECREATE net_salary GENERATED:**逐字 copy migrations/2026_06_08b_wire_expense_into_gross_net.sql
--       的 net_salary 內部運算式**(應發 16 項 + 扣除 12 項),只在最末扣項加一行
--       `- COALESCE(deduct_unpaid_leave, (0)::numeric)`,其餘一字不動。
--   (3) gross_salary 不動。
--
-- 應發 16 項:prorata_base/base_salary, attendance_bonus_actual, grade_allowance, manager_allowance,
--           allowance, extra_allowance, night_allowance, (overtime_pay_auto+overtime_pay_manual),
--           comp_expiry_payout, holiday_work_pay, settlement_amount,
--           bonus_yearend, bonus_festival, bonus_performance, bonus_other, expense_reimbursement_total
-- 扣除 13 項:deduct_absence, deduct_labor_ins, deduct_health_ins, deduct_tax,
--           attendance_penalty_total, deduct_pension_voluntary, deduct_supplementary_health,
--           deduct_welfare_fund, deduct_union_fee, deduct_court_garnishment, deduct_loan_repayment,
--           deduct_other, deduct_unpaid_leave(★ 唯一新增)
--
-- 對應檔:
--   api/salary/_repo.js findApprovedLeavesForDeduction
--   lib/salary/unpaid-leave.js allocateDaysInMonth(純函式)
--   lib/salary/calculator.js Step 3.5(新增、在 deduct_absence 後)

BEGIN;

-- (1) 加欄(idempotent)
ALTER TABLE public.salary_records
  ADD COLUMN IF NOT EXISTS deduct_unpaid_leave numeric NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.salary_records.deduct_unpaid_leave IS
  '無薪/半薪請假扣薪(_auto、Phase 3B 起接入)。公式:Σ (base_salary/30) × 當月分攤天數 × (1 − leave_types.pay_rate);兼職 = 0;pay_rate=null 不扣但 calculator breakdown 標 needs_rate。';

-- (2) 檢查 view 依賴(同 2026_06_08b 慣例)
DO $$
DECLARE dep_count int;
BEGIN
  SELECT count(*) INTO dep_count
  FROM pg_depend d
  JOIN pg_rewrite r ON r.oid = d.objid
  JOIN pg_class c ON c.oid = r.ev_class
  JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
  WHERE d.refobjid = 'public.salary_records'::regclass
    AND a.attname = 'net_salary';
  IF dep_count > 0 THEN
    RAISE NOTICE '偵測到 % 個物件依賴 net_salary、重建可能需處理依賴', dep_count;
  END IF;
END $$;

-- (3) DROP + RECREATE net_salary
-- ─── 注意:內部運算式是逐字 copy 自 migrations/2026_06_08b_wire_expense_into_gross_net.sql:35
--           唯一差異是「最末多包一層 () 並追加 - COALESCE(deduct_unpaid_leave, (0)::numeric)」。
--           其餘逐字不動(特別是 extra_allowance 在第 6 個應發項,務必對上)。
ALTER TABLE public.salary_records DROP COLUMN IF EXISTS net_salary;

ALTER TABLE public.salary_records
  ADD COLUMN net_salary numeric GENERATED ALWAYS AS (
    ((((((((((((((((((((((((((((COALESCE(prorata_base, base_salary) + COALESCE(attendance_bonus_actual, (0)::numeric)) + COALESCE(grade_allowance, (0)::numeric)) + COALESCE(manager_allowance, (0)::numeric)) + COALESCE(allowance, (0)::numeric)) + COALESCE(extra_allowance, (0)::numeric)) + COALESCE(night_allowance, (0)::numeric)) + COALESCE((overtime_pay_auto + overtime_pay_manual), (0)::numeric)) + COALESCE(comp_expiry_payout, (0)::numeric)) + COALESCE(holiday_work_pay, (0)::numeric)) + COALESCE(settlement_amount, (0)::numeric)) + COALESCE(bonus_yearend, (0)::numeric)) + COALESCE(bonus_festival, (0)::numeric)) + COALESCE(bonus_performance, (0)::numeric)) + COALESCE(bonus_other, (0)::numeric)) + COALESCE(expense_reimbursement_total, (0)::numeric)) - COALESCE(deduct_absence, (0)::numeric)) - COALESCE(deduct_labor_ins, (0)::numeric)) - COALESCE(deduct_health_ins, (0)::numeric)) - COALESCE(deduct_tax, (0)::numeric)) - COALESCE(attendance_penalty_total, (0)::numeric)) - COALESCE(deduct_pension_voluntary, (0)::numeric)) - COALESCE(deduct_supplementary_health, (0)::numeric)) - COALESCE(deduct_welfare_fund, (0)::numeric)) - COALESCE(deduct_union_fee, (0)::numeric)) - COALESCE(deduct_court_garnishment, (0)::numeric)) - COALESCE(deduct_loan_repayment, (0)::numeric)) - COALESCE(deduct_other, (0)::numeric)) - COALESCE(deduct_unpaid_leave, (0)::numeric))
  ) STORED;

COMMIT;

-- ─────────────────────────────────────────────────────────────
-- ★ 上 prod 後驗證用(交易外、Ray 手動跑;migration 前後各跑一次,
--   因 deduct_unpaid_leave 對所有既有列 default 0,sum_net 必須前後完全一致)
-- ─────────────────────────────────────────────────────────────
-- SELECT count(*) AS rows,
--        sum(gross_salary) AS sum_gross,
--        sum(net_salary)   AS sum_net
--   FROM salary_records;
--
-- 預期:
--   migration 前 sum_net   == migration 後 sum_net      ← 公式等價驗證(關鍵)
--   migration 前 sum_gross == migration 後 sum_gross    ← gross 完全不動驗證

-- 回滾(正常不要執行):重建 net_salary 為原始 12 扣項版本
-- BEGIN;
-- ALTER TABLE public.salary_records DROP COLUMN IF EXISTS net_salary;
-- ALTER TABLE public.salary_records
--   ADD COLUMN net_salary numeric GENERATED ALWAYS AS (
--     -- 逐字 copy 自 migrations/2026_06_08b_wire_expense_into_gross_net.sql:35(無 deduct_unpaid_leave)
--     (((((((((((((((((((((((((((COALESCE(prorata_base, base_salary) + COALESCE(attendance_bonus_actual, (0)::numeric)) + COALESCE(grade_allowance, (0)::numeric)) + COALESCE(manager_allowance, (0)::numeric)) + COALESCE(allowance, (0)::numeric)) + COALESCE(extra_allowance, (0)::numeric)) + COALESCE(night_allowance, (0)::numeric)) + COALESCE((overtime_pay_auto + overtime_pay_manual), (0)::numeric)) + COALESCE(comp_expiry_payout, (0)::numeric)) + COALESCE(holiday_work_pay, (0)::numeric)) + COALESCE(settlement_amount, (0)::numeric)) + COALESCE(bonus_yearend, (0)::numeric)) + COALESCE(bonus_festival, (0)::numeric)) + COALESCE(bonus_performance, (0)::numeric)) + COALESCE(bonus_other, (0)::numeric)) + COALESCE(expense_reimbursement_total, (0)::numeric)) - COALESCE(deduct_absence, (0)::numeric)) - COALESCE(deduct_labor_ins, (0)::numeric)) - COALESCE(deduct_health_ins, (0)::numeric)) - COALESCE(deduct_tax, (0)::numeric)) - COALESCE(attendance_penalty_total, (0)::numeric)) - COALESCE(deduct_pension_voluntary, (0)::numeric)) - COALESCE(deduct_supplementary_health, (0)::numeric)) - COALESCE(deduct_welfare_fund, (0)::numeric)) - COALESCE(deduct_union_fee, (0)::numeric)) - COALESCE(deduct_court_garnishment, (0)::numeric)) - COALESCE(deduct_loan_repayment, (0)::numeric)) - COALESCE(deduct_other, (0)::numeric))
--   ) STORED;
-- ALTER TABLE public.salary_records DROP COLUMN IF EXISTS deduct_unpaid_leave;
-- COMMIT;
