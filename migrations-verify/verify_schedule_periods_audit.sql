-- ==========================================
-- Migration:2026_05_07_schedule_periods_audit.sql
-- Phase:2.x.3
-- 用途:schedule_periods 加 published_by + published_at audit 欄位
--      (approve.js 既寫 approved_at、Phase 2.x.3 起 caller.id 寫 approved_by)
-- 類型:ALTER ADD COLUMN × 2(無 row-level data migration)
-- ==========================================

-- ═══════════════════════════════════════════
-- ① VERIFY PRE — 跑前確認現況
-- 預期:
--   Q1.1 approved_by / approved_at 已存在(legacy + batch_b)
--        published_by / published_at 不存在
--   Q1.2 status 分布(approved / published row count、稽核時對照)
-- ═══════════════════════════════════════════

-- Q1.1 4 欄位狀態
SELECT column_name, data_type, is_nullable
  FROM information_schema.columns
 WHERE table_schema='public' AND table_name='schedule_periods'
   AND column_name IN ('approved_by','approved_at','published_by','published_at')
 ORDER BY column_name;
-- 預期 2 row(approved_by + approved_at);published_by / published_at 不在

-- Q1.2 status 分布
SELECT status, COUNT(*) AS row_count
  FROM schedule_periods GROUP BY status ORDER BY status;
-- 記下 approved / published count


-- ═══════════════════════════════════════════
-- ② ALTER — 真正的 migration
-- ═══════════════════════════════════════════

BEGIN;
ALTER TABLE schedule_periods
  ADD COLUMN IF NOT EXISTS published_by TEXT REFERENCES employees(id),
  ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ;
COMMIT;

NOTIFY pgrst, 'reload schema';


-- ═══════════════════════════════════════════
-- ③ VERIFY POST — 跑後確認生效
-- 預期:
--   Q3.1 4 欄位都在(approved_by/at legacy + 新加 published_by/at)
--   Q3.2 FK published_by → employees(id)
--   Q3.3 既有 published row 的 published_by/at 全 NULL(無 backfill、新動作起算)
-- ═══════════════════════════════════════════

-- Q3.1 4 欄位確認
SELECT column_name, data_type, is_nullable
  FROM information_schema.columns
 WHERE table_schema='public' AND table_name='schedule_periods'
   AND column_name IN ('approved_by','approved_at','published_by','published_at')
 ORDER BY column_name;
-- 預期 4 row:
--   approved_at    timestamp with time zone  YES
--   approved_by    text                      YES
--   published_at   timestamp with time zone  YES
--   published_by   text                      YES

-- Q3.2 FK published_by 對 employees(id)
SELECT conname, pg_get_constraintdef(oid)
  FROM pg_constraint
 WHERE conrelid = 'schedule_periods'::regclass
   AND contype = 'f'
   AND conname LIKE '%published_by%';
-- 預期 1 row:FOREIGN KEY (published_by) REFERENCES employees(id)

-- Q3.3 既有 published row 的 published_by 全 NULL(無 backfill)
SELECT COUNT(*) AS published_with_published_by
  FROM schedule_periods
 WHERE status = 'published' AND published_by IS NOT NULL;               -- 預期:0
SELECT COUNT(*) AS published_total
  FROM schedule_periods
 WHERE status = 'published';
-- published_total = ① 的 published count、published_with_published_by = 0

-- Q3.4 既有 approved 的 approved_by 也全 NULL(legacy 沒寫過、Phase 2.x.3 起 caller.id 寫)
SELECT COUNT(*) AS approved_with_approved_by_before_phase
  FROM schedule_periods
 WHERE status IN ('approved','published','locked')
   AND approved_by IS NOT NULL;
-- 預期:0(若 prod 之前有 row 已寫過 approved_by 則 > 0、看清紀錄)
