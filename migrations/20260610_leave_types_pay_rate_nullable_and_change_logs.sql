-- 20260610_leave_types_pay_rate_nullable_and_change_logs.sql
-- Phase 1 步驟 1B(假別扣薪設定管理頁的 DB 配套):
--   (1) 允許 leave_types.pay_rate 為 NULL(支援「待設定」狀態,給 HR 頁面標 ⚠ 用)
--   (2) 新增 leave_type_change_logs audit table(每次 PATCH 任一可編輯欄位寫一筆)
--
-- 背景:
--   既有 leave_types.pay_rate 是 `NUMERIC(4,2) NOT NULL DEFAULT 1.00`
--   (supabase_attendance_v2_batch_a.sql:42),所有 row 都有 default 值,
--   但 Phase 1 偵察發現 leave_types.pay_rate 目前並沒有真的被薪資 calculator
--   消費(deduct_absence 只看 status=absent 天數);Phase 1 步驟 1B 開放 HR
--   主動設定後,有些假別需要明確標「待 HR 確認」而非用預設 1.00 假裝有結論。
--
--   leave_type_change_logs 給未來追溯誰在何時改了哪個欄位用、對齊
--   schedule_change_logs / employee_change_logs 的命名慣例。
--
-- 本 migration 不做的事:
--   - 不修改既有 pay_rate 值(現存所有 row 仍維持 1.00 或既有手設值)
--   - 不對接 calculator(那是 Phase 1 步驟 2 才會做)
--   - 不刪除 / 不停用任何 leave_type
--
-- 對應檔案:
--   api/leave-types/index.js  - GET 全列
--   api/leave-types/[code].js - PATCH 單筆 + 寫 change_logs
--   public/leave-types-admin.html - HR 管理頁

BEGIN;

-- (1) pay_rate 允許 NULL
ALTER TABLE leave_types ALTER COLUMN pay_rate DROP NOT NULL;

COMMENT ON COLUMN leave_types.pay_rate IS
  '扣薪比例 0.00~1.00、NULL=待 HR 設定。Phase 1 步驟 1B 開放 NULL 後,HR 後台可明確標「待確認」狀態而非沿用 default 1.00。';

-- (2) audit log table
CREATE TABLE IF NOT EXISTS leave_type_change_logs (
  id              BIGSERIAL PRIMARY KEY,
  leave_code      TEXT NOT NULL REFERENCES leave_types(code),
  changed_field   TEXT NOT NULL,
  before_value    TEXT,                            -- 一律轉字串存(null / boolean / 數字皆轉)
  after_value     TEXT,
  changed_by      TEXT NOT NULL REFERENCES employees(id),
  changed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_leave_type_change_logs_code_time
  ON leave_type_change_logs(leave_code, changed_at DESC);

CREATE INDEX IF NOT EXISTS idx_leave_type_change_logs_actor_time
  ON leave_type_change_logs(changed_by, changed_at DESC);

COMMENT ON TABLE leave_type_change_logs IS
  '假別設定異動 audit log。每次 PATCH /api/leave-types/:code 任一可編輯欄位變動寫一筆(同次請求改多欄就寫多筆)。對齊 schedule_change_logs / employee_change_logs 慣例。';

COMMIT;

-- Verify(跑完查一眼):
-- \d leave_types
-- \d leave_type_change_logs
-- SELECT code, name_zh, pay_rate FROM leave_types ORDER BY display_order;
