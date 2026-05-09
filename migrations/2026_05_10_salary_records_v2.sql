-- 階段 1.1: salary_records 擴 19 欄(獎金 4 / 法定扣項 7 / 雇主成本 6 / period_id /
--          audit + snapshot + status 'pending_review'/'locked' + GENERATED 公式更新)
-- 依據: 勞基法 §22 §24、性別工作平等法、所得稅法、全民健保法 §31、勞退條例 §14
-- 規則: idempotent(可重跑)、GENERATED 公式更新是 destructive、整段 transaction 包住
-- 對應驗證: migrations-verify/verify_salary_records_v2.sql

BEGIN;

-- ====================================================================
-- §1. 獎金分流 4 欄(取代 extra_allowance 集中存獎金的問題)
-- ====================================================================

ALTER TABLE salary_records
  ADD COLUMN IF NOT EXISTS bonus_yearend     NUMERIC(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS bonus_festival    NUMERIC(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS bonus_performance NUMERIC(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS bonus_other       NUMERIC(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS bonus_other_note  TEXT;

COMMENT ON COLUMN salary_records.bonus_yearend     IS '年終獎金';
COMMENT ON COLUMN salary_records.bonus_festival    IS '三節獎金(端午/中秋/春節合計)';
COMMENT ON COLUMN salary_records.bonus_performance IS '績效 / 業績 / 久任獎金';
COMMENT ON COLUMN salary_records.bonus_other       IS '其他獎金(婚喪喜慶 / 退休 / 資遣等)';

-- ====================================================================
-- §2. 法定扣項擴充 7 欄
-- ====================================================================

ALTER TABLE salary_records
  ADD COLUMN IF NOT EXISTS deduct_pension_voluntary    NUMERIC(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS deduct_supplementary_health NUMERIC(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS deduct_welfare_fund         NUMERIC(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS deduct_union_fee            NUMERIC(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS deduct_court_garnishment    NUMERIC(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS deduct_loan_repayment       NUMERIC(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS deduct_other                NUMERIC(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS deduct_other_note           TEXT;

COMMENT ON COLUMN salary_records.deduct_pension_voluntary    IS '勞退員工自願提繳(免稅、勞退條例 §14)';
COMMENT ON COLUMN salary_records.deduct_supplementary_health IS '二代健保補充保費(獎金累計超過投保 4 倍部分 × 2.11%、健保法 §31)';
COMMENT ON COLUMN salary_records.deduct_welfare_fund         IS '職工福利金(預設薪資 0.5%)';
COMMENT ON COLUMN salary_records.deduct_union_fee            IS '工會會費';
COMMENT ON COLUMN salary_records.deduct_court_garnishment    IS '法院 / 行政執行扣押(優先順序高)';
COMMENT ON COLUMN salary_records.deduct_loan_repayment       IS '員工借支 / 貸款還款';
COMMENT ON COLUMN salary_records.deduct_other                IS '其他扣款(自由欄、需配 deduct_other_note 說明)';

-- ====================================================================
-- §3. snapshot 4 欄(月中異動防呆 / 年底開扣繳憑單用)
-- ====================================================================

ALTER TABLE salary_records
  ADD COLUMN IF NOT EXISTS taxable_income_snapshot        NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS insured_salary_labor_snapshot  NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS insured_salary_health_snapshot NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS pension_wage_snapshot          NUMERIC(10,2);

COMMENT ON COLUMN salary_records.taxable_income_snapshot        IS '本月課稅薪資基數 snapshot(扣除免稅項後)';
COMMENT ON COLUMN salary_records.insured_salary_labor_snapshot  IS '本月勞保投保薪資 snapshot';
COMMENT ON COLUMN salary_records.insured_salary_health_snapshot IS '本月健保投保金額 snapshot';
COMMENT ON COLUMN salary_records.pension_wage_snapshot          IS '本月勞退月提繳工資 snapshot';

-- ====================================================================
-- §4. 雇主負擔 6 欄(內部成本、不影響員工 net、影子計算)
-- ====================================================================

ALTER TABLE salary_records
  ADD COLUMN IF NOT EXISTS employer_cost_labor        NUMERIC(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS employer_cost_health       NUMERIC(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS employer_cost_pension      NUMERIC(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS employer_cost_occupational NUMERIC(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS employer_cost_employment   NUMERIC(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS employer_cost_welfare      NUMERIC(10,2) NOT NULL DEFAULT 0;

COMMENT ON COLUMN salary_records.employer_cost_labor        IS '雇主勞保 70% 負擔';
COMMENT ON COLUMN salary_records.employer_cost_health       IS '雇主健保 60% 負擔(含眷屬部分)';
COMMENT ON COLUMN salary_records.employer_cost_pension      IS '雇主勞退強制 6% 提繳';
COMMENT ON COLUMN salary_records.employer_cost_occupational IS '職災保險(依行業別 0.06%~0.5%)';
COMMENT ON COLUMN salary_records.employer_cost_employment   IS '就業保險(雇主負擔 70%、預設 0.7% 內)';
COMMENT ON COLUMN salary_records.employer_cost_welfare      IS '職工福利金提撥(預設薪資 0.05~0.15%)';

-- ====================================================================
-- §5. 期間關聯 + audit 9 欄
-- payroll_period_id 暫不加 FK(table 在 1.2 才建)、1.2 補 ADD CONSTRAINT
-- ====================================================================

ALTER TABLE salary_records
  ADD COLUMN IF NOT EXISTS payroll_period_id TEXT,
  ADD COLUMN IF NOT EXISTS calculated_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS calculated_by  TEXT REFERENCES employees(id),
  ADD COLUMN IF NOT EXISTS reviewed_by    TEXT REFERENCES employees(id),
  ADD COLUMN IF NOT EXISTS reviewed_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS finalized_by   TEXT REFERENCES employees(id),
  ADD COLUMN IF NOT EXISTS finalized_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS paid_by        TEXT REFERENCES employees(id),
  ADD COLUMN IF NOT EXISTS paid_at        TIMESTAMPTZ;

COMMENT ON COLUMN salary_records.payroll_period_id IS '對應 payroll_periods.id (1.2 加 FK)';
COMMENT ON COLUMN salary_records.calculated_at     IS '試算完成時間';
COMMENT ON COLUMN salary_records.reviewed_by       IS '主管 review 後寫入';
COMMENT ON COLUMN salary_records.finalized_by      IS '老闆 / HR 確認最終版後寫入';
COMMENT ON COLUMN salary_records.paid_by           IS '標記已發放的人';

-- ====================================================================
-- §6. status CHECK 加 'pending_review' / 'locked'
-- ====================================================================

ALTER TABLE salary_records DROP CONSTRAINT IF EXISTS salary_records_status_check;
ALTER TABLE salary_records ADD CONSTRAINT salary_records_status_check
  CHECK (status IN ('draft','calculating','pending_review','confirmed','paid','locked'));

-- ====================================================================
-- §7. GENERATED 公式更新(destructive — DROP + ADD)
-- gross 加 4 個獎金、net 加 4 個獎金 + 7 個扣項
-- ====================================================================

ALTER TABLE salary_records DROP COLUMN gross_salary;
ALTER TABLE salary_records ADD COLUMN gross_salary NUMERIC(12,2)
  GENERATED ALWAYS AS (
    base_salary
    + COALESCE(attendance_bonus_actual, 0)
    + COALESCE(allowance, 0)
    + COALESCE(extra_allowance, 0)
    + COALESCE(overtime_pay_auto + overtime_pay_manual, 0)
    + COALESCE(comp_expiry_payout, 0)
    + COALESCE(holiday_work_pay, 0)
    + COALESCE(settlement_amount, 0)
    + COALESCE(bonus_yearend, 0)
    + COALESCE(bonus_festival, 0)
    + COALESCE(bonus_performance, 0)
    + COALESCE(bonus_other, 0)
  ) STORED;

ALTER TABLE salary_records DROP COLUMN net_salary;
ALTER TABLE salary_records ADD COLUMN net_salary NUMERIC(12,2)
  GENERATED ALWAYS AS (
    base_salary
    + COALESCE(attendance_bonus_actual, 0)
    + COALESCE(allowance, 0)
    + COALESCE(extra_allowance, 0)
    + COALESCE(overtime_pay_auto + overtime_pay_manual, 0)
    + COALESCE(comp_expiry_payout, 0)
    + COALESCE(holiday_work_pay, 0)
    + COALESCE(settlement_amount, 0)
    + COALESCE(bonus_yearend, 0)
    + COALESCE(bonus_festival, 0)
    + COALESCE(bonus_performance, 0)
    + COALESCE(bonus_other, 0)
    - COALESCE(deduct_absence, 0)
    - COALESCE(deduct_labor_ins, 0)
    - COALESCE(deduct_health_ins, 0)
    - COALESCE(deduct_tax, 0)
    - COALESCE(attendance_penalty_total, 0)
    - COALESCE(deduct_pension_voluntary, 0)
    - COALESCE(deduct_supplementary_health, 0)
    - COALESCE(deduct_welfare_fund, 0)
    - COALESCE(deduct_union_fee, 0)
    - COALESCE(deduct_court_garnishment, 0)
    - COALESCE(deduct_loan_repayment, 0)
    - COALESCE(deduct_other, 0)
  ) STORED;

COMMIT;
