-- 20260610_leave_request_change_logs.sql
-- Phase 2 #3(請假總覽管理頁的 DB 配套):
--   新增 leave_request_change_logs audit table。
--
-- 背景:
--   既有 api/leaves/[id].js admin_edit 故意把 days / hours / finalized_hours / status /
--   start_at / end_at / employee_id 列為 FORBIDDEN_FIELDS(:156-165),只允許改
--   leave_type / proof_status / proof_due_at。
--
--   Phase 2 #3 新開「請假總覽」管理頁,讓 HR 以上**修正**個別請假紀錄的數量欄位
--   (leave_type / days / hours / finalized_hours),需要 audit log 記錄誰在何時動了
--   哪欄、舊值新值各是什麼,以及修改理由(寫進 leave_requests.admin_audit_note,
--   2026-05-29 已加此欄)。
--
--   leave_request_change_logs 結構對齊 leave_type_change_logs / salary_grade_change_logs /
--   schedule_change_logs 既有慣例(每次 PATCH 實際變動的欄位寫一筆、同次請求改多欄寫多筆)。
--
-- 不對接的:
--   - 不重算薪資、不重算 leave balance(扣餘額由 approve flow 既有負責、本頁不 touch)
--   - 不改 status / 不改 review fields / 不改 start_at / end_at
--   - 不新增 / 不刪除既有 leave_requests row(刪除走 admin/chairman 既有 soft delete)
--
-- 對應檔案:
--   api/leave-overview/index.js   - GET 月別請假總覽 + summary
--   api/leave-overview/[id].js    - PATCH 單筆 + 寫 change_logs + 必填 admin_audit_note
--   public/leave-overview-admin.html - HR 後台月別請假總覽頁

BEGIN;

CREATE TABLE IF NOT EXISTS leave_request_change_logs (
  id                BIGSERIAL PRIMARY KEY,
  leave_request_id  TEXT NOT NULL REFERENCES leave_requests(id),
  employee_id       TEXT NOT NULL,     -- snapshot(便於 join-less 查歷史)
  changed_field     TEXT NOT NULL,
  before_value      TEXT,              -- 一律轉字串存(null / boolean / 數字皆轉)
  after_value       TEXT,
  changed_by        TEXT NOT NULL REFERENCES employees(id),
  changed_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_leave_request_change_logs_req_time
  ON leave_request_change_logs(leave_request_id, changed_at DESC);

CREATE INDEX IF NOT EXISTS idx_leave_request_change_logs_emp_time
  ON leave_request_change_logs(employee_id, changed_at DESC);

CREATE INDEX IF NOT EXISTS idx_leave_request_change_logs_actor_time
  ON leave_request_change_logs(changed_by, changed_at DESC);

COMMENT ON TABLE leave_request_change_logs IS
  '請假紀錄異動 audit log(Phase 2 #3、leave-overview-admin 專用)。每次 PATCH /api/leave-overview/:id 實際變動的欄位寫一筆;對齊 leave_type_change_logs / salary_grade_change_logs 慣例。';

COMMIT;

-- Verify:
-- \d leave_request_change_logs
