-- 2026-05-07 prod drift audit 確認已套用(drift snapshot 對齊、無需重跑)
-- Phase Attendance backlog: early_arrival_minutes audit 欄位
--
-- 背景:既有 lib/attendance/clock.js 對「員工 clock_in 早於 schedule.start_time」
-- 沒任何記錄、calculateLateMinutes 用 max(0, t-s) 把負值吞掉、status 直接走 normal。
-- 但 clockOut 的 overtime_hours 是用 (clock_out - clock_in) - scheduled_minutes 算、
-- 早到 30min 自動產生 0.5h 加班(可能是潛在無授權加班費 bug)。
--
-- 本欄位純 audit、不改 overtime_hours 算法。
-- Phase B 等 prod 累積 1-2 個月數據後評估是否要把 early_arrival 從 overtime 拆出來。
--
-- 三段式:① VERIFY → ② ALTER ADD COLUMN → ③ 無 backfill(歷史 row 維持 0、新打卡起算)

-- ═══ ① VERIFY(prod 跑前確認欄位不存在)═══
SELECT column_name FROM information_schema.columns
 WHERE table_name = 'attendance' AND column_name = 'early_arrival_minutes';

-- ═══ ② ALTER ADD COLUMN ═══
BEGIN;
ALTER TABLE attendance
  ADD COLUMN IF NOT EXISTS early_arrival_minutes INT NOT NULL DEFAULT 0;
COMMIT;

-- ═══ ③ 無 backfill ═══
-- 歷史 row 維持 0(無法回推、且不影響薪資結算)。
-- 新 clockIn / 人工補登起算、clock.js + recompute.js 寫入。

-- ═══ ④ PostgREST schema cache reload ═══
NOTIFY pgrst, 'reload schema';
