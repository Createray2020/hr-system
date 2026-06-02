-- 夜間津貼:班別有效起始 >= 18:00 的整段班,每工時 +50；寫進 night_allowance，納入 gross/net
ALTER TABLE salary_records ADD COLUMN IF NOT EXISTS night_allowance NUMERIC(10,2) DEFAULT 0;
COMMENT ON COLUMN salary_records.night_allowance IS '夜間津貼:班別起始>=18:00整段班 工時×50/h (_auto)';

ALTER TABLE salary_records DROP COLUMN IF EXISTS net_salary;
ALTER TABLE salary_records DROP COLUMN IF EXISTS gross_salary;

ALTER TABLE salary_records ADD COLUMN gross_salary NUMERIC(12,2)
  GENERATED ALWAYS AS (
    COALESCE(prorata_base, base_salary)
    + COALESCE(attendance_bonus_actual, 0::numeric)
    + COALESCE(grade_allowance, 0::numeric)
    + COALESCE(manager_allowance, 0::numeric)
    + COALESCE(allowance, 0::numeric)
    + COALESCE(extra_allowance, 0::numeric)
    + COALESCE(night_allowance, 0::numeric)
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
    + COALESCE(grade_allowance, 0::numeric)
    + COALESCE(manager_allowance, 0::numeric)
    + COALESCE(allowance, 0::numeric)
    + COALESCE(extra_allowance, 0::numeric)
    + COALESCE(night_allowance, 0::numeric)
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
