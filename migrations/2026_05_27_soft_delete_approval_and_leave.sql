-- ============================================================================
-- 2026-05-27: approval_requests + leave_requests soft-delete 三欄位
-- 設計：admin/chairman 才能刪、必填理由、所有 SELECT 一律過濾 deleted_at IS NULL
-- 還原方式：直接 DB UPDATE SET deleted_at = NULL（無 UI 入口）
-- ============================================================================

-- 1. approval_requests
ALTER TABLE approval_requests
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deleted_by TEXT REFERENCES employees(id),
  ADD COLUMN IF NOT EXISTS delete_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_approval_requests_deleted_at
  ON approval_requests(deleted_at)
  WHERE deleted_at IS NULL;

COMMENT ON COLUMN approval_requests.deleted_at IS '軟刪除時間戳，NULL 代表未刪除';
COMMENT ON COLUMN approval_requests.deleted_by IS '執行刪除的 employee.id（限 admin/chairman）';
COMMENT ON COLUMN approval_requests.delete_reason IS '刪除理由（必填）';

-- 2. leave_requests
ALTER TABLE leave_requests
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deleted_by TEXT REFERENCES employees(id),
  ADD COLUMN IF NOT EXISTS delete_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_leave_requests_deleted_at
  ON leave_requests(deleted_at)
  WHERE deleted_at IS NULL;

COMMENT ON COLUMN leave_requests.deleted_at IS '軟刪除時間戳，NULL 代表未刪除';
COMMENT ON COLUMN leave_requests.deleted_by IS '執行刪除的 employee.id（限 admin/chairman）';
COMMENT ON COLUMN leave_requests.delete_reason IS '刪除理由（必填）';
