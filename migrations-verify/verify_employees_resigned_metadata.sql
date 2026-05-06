-- ==========================================
-- Migration:2026_05_07_employees_resigned_metadata.sql
-- Phase:1.7 MVP
-- 用途:employees 加 resigned_at + resigned_reason 欄位 + backfill 既有 resigned row
-- 類型:ALTER ADD COLUMN × 2 + UPDATE row-level data migration
-- ⚠ 有 row-level data migration:UPDATE employees SET resigned_at = updated_at
--    WHERE status='resigned' AND resigned_at IS NULL
-- ==========================================

-- ═══════════════════════════════════════════
-- ① VERIFY PRE — 跑前確認現況
-- 預期:
--   Q1.1 columns 0 row(兩欄位不存在)
--   Q1.2 status 分布:active / inactive / resigned 各幾筆
--        記下 resigned 的 N、第 ② 段 backfill 應 UPDATE N rows
-- ═══════════════════════════════════════════

-- Q1.1 兩欄位不存在
SELECT column_name FROM information_schema.columns
 WHERE table_schema='public' AND table_name='employees'
   AND column_name IN ('resigned_at','resigned_reason');                -- 預期:0 row

-- Q1.2 status 分布(記下 resigned count、給第 ② 段 backfill 對照)
SELECT status, COUNT(*) AS row_count
  FROM employees GROUP BY status ORDER BY status;
-- 預期格式:
--   active     N1
--   inactive   N2
--   resigned   N3   ← 記下這個數字、跑 ② 後要 UPDATE 出 N3 rows


-- ═══════════════════════════════════════════
-- ② ALTER + Backfill — 真正的 migration
-- ═══════════════════════════════════════════

-- ②.1 ALTER ADD COLUMN
BEGIN;
ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS resigned_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS resigned_reason TEXT;
COMMIT;

-- ②.2 Backfill 既有 resigned row
-- 期望 UPDATE Supabase 回:"UPDATE N3"(N3 = ① VERIFY 的 resigned count)
BEGIN;
UPDATE employees
   SET resigned_at = updated_at
 WHERE status = 'resigned'
   AND resigned_at IS NULL;
COMMIT;

NOTIFY pgrst, 'reload schema';


-- ═══════════════════════════════════════════
-- ③ VERIFY POST — 跑後確認生效
-- 預期:
--   Q3.1 columns 2 row(both nullable、type 對)
--   Q3.2 backfilled count = N3(全 resigned row 都有 resigned_at)
--   Q3.3 還有 NULL 的 resigned row → 0(全部 backfill 成功)
--   Q3.4 active row 的 resigned_at 仍 NULL(只 backfill resigned status)
--   Q3.5 抽樣看 resigned_at = updated_at(等同)
-- ═══════════════════════════════════════════

-- Q3.1 columns 確認存在
SELECT column_name, data_type, is_nullable
  FROM information_schema.columns
 WHERE table_schema='public' AND table_name='employees'
   AND column_name IN ('resigned_at','resigned_reason')
 ORDER BY column_name;
-- 預期 2 row:
--   resigned_at      timestamp with time zone  YES
--   resigned_reason  text                      YES

-- Q3.2 backfilled resigned 數 = N3
SELECT COUNT(*) AS resigned_with_resigned_at
  FROM employees
 WHERE status = 'resigned' AND resigned_at IS NOT NULL;
-- 預期:N3(等同 ① 的 resigned row count)

-- Q3.3 有 status=resigned 但 resigned_at 仍 NULL 的(should be 0)
SELECT COUNT(*) AS still_null_resigned
  FROM employees
 WHERE status = 'resigned' AND resigned_at IS NULL;                     -- 預期:0

-- Q3.4 active row 不該被 backfill 動到
SELECT COUNT(*) AS active_with_resigned_at
  FROM employees
 WHERE status = 'active' AND resigned_at IS NOT NULL;                   -- 預期:0

-- Q3.5 抽樣 1 筆對照 resigned_at 跟 updated_at(should match)
SELECT id, name, status, resigned_at, updated_at,
       (resigned_at = updated_at) AS match_updated_at
  FROM employees WHERE status='resigned'
 ORDER BY updated_at DESC LIMIT 5;
-- 預期 match_updated_at 全 true
