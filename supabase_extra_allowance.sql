-- ══════════════════════════════════════════════
--  額外加給功能 — 在 Supabase SQL Editor 執行
-- ══════════════════════════════════════════════

-- employees 表新增欄位
ALTER TABLE employees ADD COLUMN IF NOT EXISTS extra_allowance      NUMERIC(10,2) DEFAULT 0;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS extra_allowance_note TEXT          DEFAULT '';

-- salary_records 表新增欄位
ALTER TABLE salary_records ADD COLUMN IF NOT EXISTS extra_allowance      NUMERIC(10,2) DEFAULT 0;
ALTER TABLE salary_records ADD COLUMN IF NOT EXISTS extra_allowance_note TEXT          DEFAULT '';

-- 重新計算 gross_salary / net_salary（包含 extra_allowance）
-- 注意：GENERATED ALWAYS 欄位必須先 DROP 再 ADD
ALTER TABLE salary_records DROP COLUMN IF EXISTS gross_salary;
ALTER TABLE salary_records DROP COLUMN IF EXISTS net_salary;

ALTER TABLE salary_records
  ADD COLUMN gross_salary NUMERIC(12,2) GENERATED ALWAYS AS
  (base_salary + overtime_pay + bonus + allowance + extra_allowance) STORED;

ALTER TABLE salary_records
  ADD COLUMN net_salary NUMERIC(12,2) GENERATED ALWAYS AS
  (base_salary + overtime_pay + bonus + allowance + extra_allowance
   - deduct_absence - deduct_labor_ins - deduct_health_ins - deduct_tax) STORED;
