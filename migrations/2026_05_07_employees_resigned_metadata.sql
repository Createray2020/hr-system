-- Phase 1.7 MVP: employees 加 resigned_at + resigned_reason 欄位
--
-- 背景:既有 status='resigned' 已存在、但無「離職時間」、「離職原因」欄位。
-- 離職時間用 updated_at 替代不精準(離職後若改其他欄位會漂)。
-- 法律 / 稅務 / 勞檢需要明確的離職時間紀錄。
--
-- 三段式:① VERIFY → ② ALTER → ③ Backfill 既有 resigned row(用 updated_at 替代)

-- ═══ ① VERIFY(prod 跑前確認欄位不存在 + 統計影響範圍)═══
SELECT column_name FROM information_schema.columns
 WHERE table_name = 'employees' AND column_name IN ('resigned_at','resigned_reason');
SELECT status, COUNT(*) AS row_count
  FROM employees
 GROUP BY status
 ORDER BY status;

-- ═══ ② ALTER ADD COLUMN ═══
BEGIN;
ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS resigned_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS resigned_reason TEXT;
COMMIT;

-- ═══ ③ Backfill 既有 resigned row(updated_at → resigned_at)═══
-- updated_at 不精準(離職後若改其他欄位會漂)、但比 null 好、
-- 至少法律 / 勞檢有個近似的離職時間。
-- 期望:回 N rows updated(N = ① VERIFY 的 resigned count)
BEGIN;
UPDATE employees
   SET resigned_at = updated_at
 WHERE status = 'resigned'
   AND resigned_at IS NULL;
COMMIT;

-- ═══ ④ PostgREST schema cache reload ═══
NOTIFY pgrst, 'reload schema';
