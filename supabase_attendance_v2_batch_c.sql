-- =====================================================
-- supabase_attendance_v2_batch_c.sql
-- 出勤核心系統 v2.0 - Batch C：salary_records 大改（高風險）
-- 對應設計文件：docs/attendance-system-design-v1.md §4.6.1 + §8.3 (commit 8721a2f)
-- 執行時機：Batch A、Batch B 都驗收完才跑
-- 回滾方式：困難（GENERATED column 改動不易無痛回滾）— 見 README §回滾
-- =====================================================
--
-- ⚠ 重要：本檔分八步驟。直接 \i 執行會跑前 6 步 + 寫 backup table。
--   步驟 7（比對驗證 SELECT）與步驟 8（DROP _salary_backup）以註解形式包起來，
--   Ray 上 prod 時自行解註解後手動執行。
--
-- 反向 FK 區塊內容不變：型別由 column 決定，column 在 Batch A/B 已對齊
-- （overtime_requests.applied_to_salary_record_id = TEXT、
--   attendance_penalty_records.salary_record_id = TEXT、
--   leave_requests.source_overtime_request_id = BIGINT、
--   comp_time_balance.source_overtime_request_id = BIGINT）
-- =====================================================


-- ========== 步驟 1：取既有 gross_salary / net_salary 快照 ==========

CREATE TABLE _salary_backup AS
SELECT id, gross_salary, net_salary FROM salary_records;


-- ========== 步驟 2：補新欄位（先 NULLABLE / DEFAULT 0） ==========

ALTER TABLE salary_records ADD COLUMN IF NOT EXISTS
  overtime_pay_auto NUMERIC(10,2) NOT NULL DEFAULT 0;
ALTER TABLE salary_records ADD COLUMN IF NOT EXISTS
  overtime_pay_manual NUMERIC(10,2) NOT NULL DEFAULT 0;
ALTER TABLE salary_records ADD COLUMN IF NOT EXISTS
  overtime_pay_note TEXT;

ALTER TABLE salary_records ADD COLUMN IF NOT EXISTS
  comp_expiry_payout NUMERIC(10,2) NOT NULL DEFAULT 0;

ALTER TABLE salary_records ADD COLUMN IF NOT EXISTS
  attendance_penalty_total NUMERIC(10,2) NOT NULL DEFAULT 0;

ALTER TABLE salary_records ADD COLUMN IF NOT EXISTS
  attendance_bonus_base NUMERIC(10,2) NOT NULL DEFAULT 0;
ALTER TABLE salary_records ADD COLUMN IF NOT EXISTS
  attendance_bonus_deduction_rate NUMERIC(4,3) NOT NULL DEFAULT 0;
ALTER TABLE salary_records ADD COLUMN IF NOT EXISTS
  attendance_bonus_actual NUMERIC(10,2);

ALTER TABLE salary_records ADD COLUMN IF NOT EXISTS
  absence_days NUMERIC(4,1) NOT NULL DEFAULT 0;
ALTER TABLE salary_records ADD COLUMN IF NOT EXISTS
  daily_wage_snapshot NUMERIC(10,2);

ALTER TABLE salary_records ADD COLUMN IF NOT EXISTS
  holiday_work_pay NUMERIC(10,2) NOT NULL DEFAULT 0;

ALTER TABLE salary_records ADD COLUMN IF NOT EXISTS
  settlement_amount NUMERIC(10,2) NOT NULL DEFAULT 0;
ALTER TABLE salary_records ADD COLUMN IF NOT EXISTS
  settlement_note TEXT;


-- ========== 步驟 3：反向 FK 補上（前面 Section 已宣告） ==========

ALTER TABLE attendance_penalty_records
  ADD CONSTRAINT fk_penalty_records_salary
  FOREIGN KEY (salary_record_id) REFERENCES salary_records(id);

ALTER TABLE overtime_requests
  ADD CONSTRAINT fk_overtime_requests_salary
  FOREIGN KEY (applied_to_salary_record_id) REFERENCES salary_records(id);

ALTER TABLE leave_requests
  ADD CONSTRAINT fk_leave_requests_overtime
  FOREIGN KEY (source_overtime_request_id) REFERENCES overtime_requests(id);

ALTER TABLE comp_time_balance
  ADD CONSTRAINT fk_comp_time_balance_overtime
  FOREIGN KEY (source_overtime_request_id) REFERENCES overtime_requests(id);


-- ========== 步驟 4：Backfill 既有 salary_records ==========

UPDATE salary_records SET
  overtime_pay_auto = 0,
  overtime_pay_manual = COALESCE(overtime_pay, 0),
  comp_expiry_payout = 0,
  attendance_penalty_total = 0,
  attendance_bonus_base = COALESCE(bonus, 0),
  attendance_bonus_deduction_rate = 0,
  attendance_bonus_actual = COALESCE(bonus, 0),
  absence_days = 0,
  daily_wage_snapshot = base_salary / 30,
  holiday_work_pay = 0,
  settlement_amount = 0;


-- ========== 步驟 5：DROP gross_salary / net_salary ==========

ALTER TABLE salary_records DROP COLUMN gross_salary;
ALTER TABLE salary_records DROP COLUMN net_salary;


-- ========== 步驟 6：ADD GENERATED column（新公式） ==========

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
  ) STORED;
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
    - COALESCE(deduct_absence, 0)
    - COALESCE(deduct_labor_ins, 0)
    - COALESCE(deduct_health_ins, 0)
    - COALESCE(deduct_tax, 0)
    - COALESCE(attendance_penalty_total, 0)
  ) STORED;


-- ========== 步驟 7：比對驗證 SELECT（手動執行） ==========
--
-- ⚠ Ray：上 prod 時請手動解註解執行以下 SELECT。
-- 預期回 0 row。若有差異要 debug 後修正 backfill。
--
-- SELECT s.id, b.gross_salary AS old_gross, s.gross_salary AS new_gross,
--        b.gross_salary - s.gross_salary AS gross_diff,
--        b.net_salary AS old_net, s.net_salary AS new_net,
--        b.net_salary - s.net_salary AS net_diff
-- FROM salary_records s
-- JOIN _salary_backup b ON b.id = s.id
-- WHERE b.gross_salary != s.gross_salary
--    OR b.net_salary != s.net_salary;


-- ========== 步驟 8：DROP backup table（手動執行，確認無誤後） ==========
--
-- ⚠ Ray：步驟 7 驗證 0 row 後才執行。
--
-- DROP TABLE _salary_backup;
