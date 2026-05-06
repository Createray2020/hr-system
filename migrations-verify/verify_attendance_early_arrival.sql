-- ==========================================
-- Migration:2026_05_07_attendance_early_arrival.sql
-- Phase:Attendance backlog(預備 Phase B 評估)
-- 用途:attendance 加 early_arrival_minutes audit 欄位
--      (純記錄、不改 overtime_hours 算法、Phase B 等 prod 累積數據後再評估)
-- 類型:ALTER ADD COLUMN(NOT NULL DEFAULT 0、無 row-level data migration)
-- ==========================================

-- ═══════════════════════════════════════════
-- ① VERIFY PRE — 跑前確認現況
-- 預期:
--   Q1.1 欄位不存在
--   Q1.2 attendance 總 row count(背景對照、實際勿動)
-- ═══════════════════════════════════════════

-- Q1.1 欄位不存在
SELECT column_name FROM information_schema.columns
 WHERE table_schema='public' AND table_name='attendance'
   AND column_name='early_arrival_minutes';                             -- 預期:0 row

-- Q1.2 attendance 總 row(背景、不影響 migration)
SELECT COUNT(*) AS attendance_total FROM attendance;


-- ═══════════════════════════════════════════
-- ② ALTER — 真正的 migration
-- ═══════════════════════════════════════════

BEGIN;
ALTER TABLE attendance
  ADD COLUMN IF NOT EXISTS early_arrival_minutes INT NOT NULL DEFAULT 0;
COMMIT;

NOTIFY pgrst, 'reload schema';


-- ═══════════════════════════════════════════
-- ③ VERIFY POST — 跑後確認生效
-- 預期:
--   Q3.1 欄位存在(NOT NULL、DEFAULT 0、type=integer)
--   Q3.2 既有 row 全 = 0(DEFAULT 套用)
--   Q3.3 sum 總和 = 0(double-check、無歷史 backfill)
-- ═══════════════════════════════════════════

-- Q3.1 欄位確認 + DEFAULT
SELECT column_name, data_type, is_nullable, column_default
  FROM information_schema.columns
 WHERE table_schema='public' AND table_name='attendance'
   AND column_name='early_arrival_minutes';
-- 預期 1 row:
--   early_arrival_minutes  integer  NO  0

-- Q3.2 既有 row 全 0(NOT NULL DEFAULT 0)
SELECT COUNT(*) AS not_zero_count
  FROM attendance WHERE early_arrival_minutes != 0;                    -- 預期:0

SELECT COUNT(*) AS null_count
  FROM attendance WHERE early_arrival_minutes IS NULL;                  -- 預期:0(NOT NULL)

-- Q3.3 sum total 0
SELECT COALESCE(SUM(early_arrival_minutes), 0) AS total_early_arrival
  FROM attendance;                                                       -- 預期:0
