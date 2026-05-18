-- P5.1: 新增 admin_audit_note 欄位給 overtime_requests
-- 用途:HR / admin / CEO / chairman 透過 admin-edit endpoint 修改既有 row 的 audit log
ALTER TABLE overtime_requests
ADD COLUMN IF NOT EXISTS admin_audit_note text;

COMMENT ON COLUMN overtime_requests.admin_audit_note IS
  'HR / admin / CEO / chairman 透過 admin-edit endpoint 修改既有 row 的 audit log。每次 admin_edit append 一行於開頭、format: [YYYY-MM-DD] admin_edit by {actor_id}: field oldVal→newVal, ...';
