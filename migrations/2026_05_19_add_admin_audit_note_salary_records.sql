-- P6.1: 新增 admin_audit_note 欄位給 salary_records
-- 用途:HR / admin / CEO / chairman 透過 PUT /api/salary/:id 修改既有 row 的 audit log
ALTER TABLE salary_records
ADD COLUMN IF NOT EXISTS admin_audit_note text;

COMMENT ON COLUMN salary_records.admin_audit_note IS
  'HR / admin / CEO / chairman 透過 PUT /api/salary/:id 修改既有 row 的 audit log。每次 admin_edit append 一行於開頭、format: [YYYY-MM-DD] admin_edit by {actor_id}: field oldVal→newVal, ... [FORCE] 標記表示 override lock。';
