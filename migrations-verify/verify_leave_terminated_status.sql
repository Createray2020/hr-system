-- ==========================================
-- Migration:2026_05_07_leave_terminated_status.sql
-- Phase:1.6
-- 用途:leave_requests 加 'terminated' status + terminated_by/at 欄位
-- 類型:DROP/ADD CHECK constraint(6→7 值)+ ALTER ADD COLUMN × 2(無 row-level data migration)
-- ==========================================

-- ═══════════════════════════════════════════
-- ① VERIFY PRE — 跑前確認現況
-- 預期:
--   Q1.1 既有 CHECK 6 值(沒 'terminated')
--   Q1.2 兩欄位不存在
--   Q1.3 expired_pending_count = 現有 pending+expired row 數(用於 1.6 終止流程後 HR 處理量估算)
-- ═══════════════════════════════════════════

-- Q1.1 CHECK 內容(should NOT contain 'terminated')
SELECT conname, pg_get_constraintdef(oid)
  FROM pg_constraint
 WHERE conrelid = 'leave_requests'::regclass
   AND conname = 'leave_requests_status_check';
-- 預期 1 row:CHECK ((status = ANY (ARRAY['pending_mgr','pending_ceo','approved',
--          'archived','rejected','cancelled']))) — 6 值、無 'terminated'

-- Q1.2 兩欄位不存在
SELECT column_name FROM information_schema.columns
 WHERE table_schema='public' AND table_name='leave_requests'
   AND column_name IN ('terminated_by','terminated_at');                -- 預期:0 row

-- Q1.3 統計 expired pending row(Phase 1.5 升級已標 expired、Phase 1.6 後給 HR 終止)
SELECT COUNT(*) AS expired_pending_count
  FROM leave_requests
 WHERE proof_status = 'expired'
   AND status IN ('pending_mgr','pending_ceo');
-- 記下這個數字、跑完後 HR 在 leave-admin 個案處理用


-- ═══════════════════════════════════════════
-- ② ALTER — 真正的 migration
-- ═══════════════════════════════════════════

BEGIN;
-- ②.1 CHECK 6 值 → 7 值
ALTER TABLE leave_requests DROP CONSTRAINT IF EXISTS leave_requests_status_check;
ALTER TABLE leave_requests ADD CONSTRAINT leave_requests_status_check
  CHECK (status IN (
    'pending_mgr',
    'pending_ceo',
    'approved',
    'archived',
    'rejected',
    'cancelled',
    'terminated'
  ));

-- ②.2 ADD COLUMN
ALTER TABLE leave_requests
  ADD COLUMN IF NOT EXISTS terminated_by TEXT REFERENCES employees(id),
  ADD COLUMN IF NOT EXISTS terminated_at TIMESTAMPTZ;
COMMIT;

NOTIFY pgrst, 'reload schema';


-- ═══════════════════════════════════════════
-- ③ VERIFY POST — 跑後確認生效
-- 預期:
--   Q3.1 CHECK 7 值含 'terminated'
--   Q3.2 兩欄位存在(both nullable、FK 對 employees.id)
--   Q3.3 row count 0 status='terminated'(無 backfill、新 HR 動作起算)
-- ═══════════════════════════════════════════

-- Q3.1 CHECK 內容(should contain 'terminated')
SELECT conname, pg_get_constraintdef(oid)
  FROM pg_constraint
 WHERE conrelid = 'leave_requests'::regclass
   AND conname = 'leave_requests_status_check';
-- 預期 1 row 含 'terminated'

-- Q3.2 兩欄位存在
SELECT column_name, data_type, is_nullable
  FROM information_schema.columns
 WHERE table_schema='public' AND table_name='leave_requests'
   AND column_name IN ('terminated_by','terminated_at')
 ORDER BY column_name;
-- 預期 2 row:
--   terminated_at  timestamp with time zone  YES
--   terminated_by  text                      YES

-- Q3.2.b FK 確認 terminated_by → employees(id)
SELECT conname, pg_get_constraintdef(oid)
  FROM pg_constraint
 WHERE conrelid = 'leave_requests'::regclass
   AND contype = 'f'
   AND conname LIKE '%terminated_by%';
-- 預期 1 row:FOREIGN KEY (terminated_by) REFERENCES employees(id)

-- Q3.3 status=terminated row count 0(無 backfill)
SELECT COUNT(*) FROM leave_requests WHERE status='terminated';          -- 預期:0

-- Q3.4 expired_pending_count 不變(沒被 cron / migration 動到、要 HR 手動終止)
SELECT COUNT(*) AS expired_pending_count_after
  FROM leave_requests
 WHERE proof_status = 'expired'
   AND status IN ('pending_mgr','pending_ceo');
-- 預期:跟 Q1.3 同數字
