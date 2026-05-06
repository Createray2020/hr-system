-- 2026-05-07 prod drift audit 確認已套用(drift snapshot 對齊、無需重跑)
-- Phase 2.x.3:schedule_periods 加 published_by + published_at 欄位
--
-- 背景:approve.js 既有寫 approved_at(legacy approved_by 欄位有但沒寫入)、
-- publish.js 完全沒寫 published_by / published_at(audit gap、法律 / 勞檢需要)。
-- Phase 2.x.3 修補 caller 識別後、需要 audit 欄位記錄是誰簽。
--
-- 三段式:① VERIFY → ② ALTER ADD COLUMN → ③ 不 backfill
-- (schedule_change_logs 沒含 period_id、無法精準回推、新動作起算)

-- ═══ ① VERIFY(prod 跑前確認欄位狀態)═══
-- 期望:approved_by 已存在(legacy)、approved_at 已存在(batch_b)、
--       published_by / published_at 不存在
SELECT column_name FROM information_schema.columns
 WHERE table_name = 'schedule_periods'
   AND column_name IN ('approved_by','approved_at','published_by','published_at');
-- 統計現況 status 分布
SELECT status, COUNT(*) AS row_count FROM schedule_periods GROUP BY status ORDER BY status;

-- ═══ ② ALTER ADD COLUMN ═══
BEGIN;
-- published_by 新加(approve.js / publish.js Phase 2.x.3 寫入 caller.id)
ALTER TABLE schedule_periods
  ADD COLUMN IF NOT EXISTS published_by TEXT REFERENCES employees(id),
  ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ;
COMMIT;

-- ═══ ③ 不 backfill ═══
-- schedule_change_logs.change_type='manager_approve' / 'manager_publish' 雖有 changed_by,
-- 但 logs schema 沒含 period_id / period_year / period_month、employee_id 同人多月份 row
-- 無法精準對齊。新動作起算、歷史 row approved_by / published_by 維持 NULL。
--
-- 若稽核時要回推、走 schedule_change_logs 查 employee_id + changed_at 範圍、
-- 不寫進 schedule_periods row。

-- ═══ ④ PostgREST schema cache reload ═══
NOTIFY pgrst, 'reload schema';
