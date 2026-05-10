-- 階段 2.7.9 Part B: FK 改 ON DELETE SET NULL
--
-- 目的:
--   解決「DELETE salary_records 被 overtime_requests / attendance_penalty_records 的 FK 擋」
--   的痛點。HR 想清掉一筆薪資 row 重跑試算 / 修錯 / 補資料時、PG 會 FK violation:
--     ERROR 23503: update or delete on table "salary_records" violates foreign key constraint
--                  "fk_overtime_requests_salary" on table "overtime_requests"
--   因為 overtime_requests.applied_to_salary_record_id / attendance_penalty_records.salary_record_id
--   pin 著該 salary_record。
--
-- 改 ON DELETE SET NULL 之後:
--   DELETE salary_records WHERE id = 'S_xxx_2026_05'
--   → PG 自動把對應 overtime_requests.applied_to_salary_record_id 設 NULL
--   → 對應 attendance_penalty_records.salary_record_id 設 NULL
--   → 下次 calculator 重跑會把它們重新 mark applied (已透過 step 6/7 處理)
--
-- 配合 Part A (calculator UPSERT idempotency)、未來重跑試算流程:
--   1. (選用) DELETE FROM salary_records WHERE year=2026 AND month=5;  -- 不再被 FK 擋
--   2. POST /api/salary action=batch_v2 year=2026 month=5
--   3. 完成、不需要任何手動 unmark / 清 FK 的前置動作
--
-- 對應原 schema: supabase_attendance_v2_batch_c.sql §3 (line 65-71)
-- 對應驗證: migrations-verify/verify_fk_on_delete_set_null.sql

BEGIN;

-- ====================================================================
-- §1. overtime_requests.applied_to_salary_record_id
-- ====================================================================

ALTER TABLE overtime_requests
  DROP CONSTRAINT IF EXISTS fk_overtime_requests_salary;

ALTER TABLE overtime_requests
  ADD CONSTRAINT fk_overtime_requests_salary
    FOREIGN KEY (applied_to_salary_record_id)
    REFERENCES salary_records(id) ON DELETE SET NULL;

-- ====================================================================
-- §2. attendance_penalty_records.salary_record_id
-- ====================================================================

ALTER TABLE attendance_penalty_records
  DROP CONSTRAINT IF EXISTS fk_penalty_records_salary;

ALTER TABLE attendance_penalty_records
  ADD CONSTRAINT fk_penalty_records_salary
    FOREIGN KEY (salary_record_id)
    REFERENCES salary_records(id) ON DELETE SET NULL;

COMMIT;
