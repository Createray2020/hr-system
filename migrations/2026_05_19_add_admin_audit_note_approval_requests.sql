-- P7.1: 新增 admin_audit_note 欄位給 approval_requests
-- 用途:HR / admin / CEO / chairman 透過 POST /api/approvals { action: 'admin_edit' } 修改既有 row 的 audit log
ALTER TABLE approval_requests
ADD COLUMN IF NOT EXISTS admin_audit_note text;

COMMENT ON COLUMN approval_requests.admin_audit_note IS
  'HR / admin / CEO / chairman 透過 POST /api/approvals admin_edit action 修改既有 row 的 audit log。每次 admin_edit append 一行於開頭、format: [YYYY-MM-DD] admin_edit by {actor_id}: form_data.{keys} updated, attachments updated, ...';
