-- P5.3: 新增 admin_audit_note 欄位給 comp_time_balance
-- 用途:HR / admin / CEO / chairman 透過 PUT /api/comp-time/:id 修改既有 row 的 audit log
ALTER TABLE comp_time_balance
ADD COLUMN IF NOT EXISTS admin_audit_note text;

COMMENT ON COLUMN comp_time_balance.admin_audit_note IS
  'HR / admin / CEO / chairman 透過 PUT /api/comp-time/:id 修改既有 row 的 audit log。每次 admin_edit append 一行於開頭、format: [YYYY-MM-DD] admin_edit by {actor_id}: field oldVal→newVal, ...';
