-- 2026-06-02: schedule_change_logs.change_type CHECK 加 'executive_unlock'
--
-- 背景:新增 executive unlock 反向 transition(locked → approved)、API
-- api/schedule-periods/[id]/unlock.js 寫 change_type='executive_unlock'。
-- 既有 CHECK 是 12 個值(對應 2026-05-28 manager_unpublish migration),
-- lib/schedule/change-logger.js CHANGE_TYPES 已擴到 13 個,prod CHECK 需同步擴充。
--
-- 本 migration:DROP 舊 CHECK + ADD 新 CHECK(12 + 1 = 13 個)。
--
-- ⚠ 必須在 unlock endpoint deploy 前跑完、否則 logScheduleChange 寫 executive_unlock
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

-- ═══ ② ALTER CHECK(12 + 1 = 13 個合法值)═══
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
    -- F3 加(2026-05-28):
    'manager_unpublish',
    -- 2026-06-02 新加:executive 解鎖 locked period
    'executive_unlock'
  ));

COMMIT;

-- ═══ ③ PostgREST schema cache reload ═══
NOTIFY pgrst, 'reload schema';
