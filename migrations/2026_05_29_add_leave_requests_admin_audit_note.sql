-- 2026-05-29: leave_requests 加 admin_audit_note 欄位
-- 對齊既有 admin_audit_note 設計(overtime_requests / comp_time_balance /
-- salary_records / approval_requests 都有此欄位、leave_requests 漏)。
-- 用途:HR/admin 後台手動補單 / 編輯時留審計訊息,prefix 慣例 '[YYYY-MM-DD] ...'。
--
-- 對應 script:scripts/backfill_attendance_202605_warehouse.mjs(5 月倉儲後勤部
-- 11 筆批次補考勤,需在 leave_requests 寫 admin_audit_note 註記 HR 後台補單來源)。

ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS admin_audit_note TEXT;

COMMENT ON COLUMN leave_requests.admin_audit_note IS
  'HR/admin 後台改動的審計註記(對齊 overtime_requests / comp_time_balance / salary_records / approval_requests 同欄位)';
