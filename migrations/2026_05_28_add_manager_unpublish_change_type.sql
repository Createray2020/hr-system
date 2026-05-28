-- 2026-05-28: schedule_change_logs.change_type CHECK 加 'manager_unpublish'
--
-- 背景:F3 加「公告撤回」反向 transition(published → approved)、寫
-- schedule_change_logs change_type='manager_unpublish'。既有 CHECK constraint
-- 為原始 6 個值(employee_draft / employee_submit / manager_adjust /
-- manager_approve / system_lock / late_change),lib/schedule/change-logger.js
-- CHANGE_TYPES 已擴充到 11 個,但 prod CHECK 可能仍未同步擴充。
--
-- 本 migration:DROP 舊 CHECK + ADD 新 CHECK(現有 11 個 + 'manager_unpublish' = 12 個)。
-- 若 prod CHECK 已是 11 個 → 自動覆蓋為 12 個;若仍 6 個 → 一次補齊到 12 個。
--
-- ⚠ 必須在 F3 endpoint deploy 前跑完、否則 logScheduleChange 寫 manager_unpublish
-- 會被 CHECK 擋下、catch 吞掉、silent fail(對齊 publish.js / approve.js best-effort log pattern)。
--
-- 三段式:① VERIFY → ② ALTER CHECK → ③ NOTIFY pgrst

-- ═══ ① VERIFY(prod 跑前確認現況)═══
SELECT conname, pg_get_constraintdef(oid) AS current_constraint_def
  FROM pg_constraint
 WHERE conrelid = 'schedule_change_logs'::regclass
   AND contype = 'c'
   AND conname = 'schedule_change_logs_change_type_check';

-- 統計現況 change_type 分布
SELECT change_type, COUNT(*) AS row_count
  FROM schedule_change_logs
 GROUP BY change_type
 ORDER BY change_type;

-- ═══ ② ALTER CHECK(11 + 1 = 12 個合法值)═══
BEGIN;

ALTER TABLE schedule_change_logs
  DROP CONSTRAINT IF EXISTS schedule_change_logs_change_type_check;

ALTER TABLE schedule_change_logs
  ADD CONSTRAINT schedule_change_logs_change_type_check
  CHECK (change_type IN (
    -- 原始 6 個(batch_a):
    'employee_draft',
    'employee_submit',
    'manager_adjust',
    'manager_approve',
    'system_lock',
    'late_change',
    -- C6-2 + C7-C13 擴充 5 個:
    'hr_override_wish_deadline',
    'hr_announce',
    'hr_unlock',
    'manager_announce',
    'manager_publish',
    -- F3 新加(2026-05-28):
    'manager_unpublish'
  ));

COMMIT;

-- ═══ ③ PostgREST schema cache reload ═══
NOTIFY pgrst, 'reload schema';
