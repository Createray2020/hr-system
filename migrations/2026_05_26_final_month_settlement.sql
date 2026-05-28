-- 2026-05-26 B26 批次 1:離職月薪資 pro-rata 結算 schema
--
-- 背景:柯郁含案發現「離職員工最後月薪結算」缺整套設計。
-- 主要設計決定(Ray 拍板):
--   1. pro_rata_mode='calendar_day':base × (worked_days / total_days_in_month)
--   2. daily_wage_settlement = base / 30(§38 法定特休折現公式、不同於既有
--      daily_wage_snapshot = base / workdaysInMonth)
--   3. is_final_month boolean 旗標、calculator 走 pro-rata 分支
--   4. backfill 既有員工 hourly_rate=0(init bug、未來薪資調整自動 recalc)
--
-- 新 schema:
--   salary_records 加 5 欄位:worked_days / total_days_in_month / pro_rata_mode
--                            / is_final_month / daily_wage_settlement
--
-- 三段式:① VERIFY pre(含 hourly_rate dry-run)→ ② ALTER + backfill → ③ VERIFY post


-- ═══════════════════════════════════════════
-- ① VERIFY PRE — 跑前確認 + dry-run hourly_rate backfill 影響面
-- ═══════════════════════════════════════════

-- Q1.1 5 新欄位都不存在
SELECT column_name FROM information_schema.columns
 WHERE table_schema='public' AND table_name='salary_records'
   AND column_name IN (
     'worked_days', 'total_days_in_month', 'pro_rata_mode',
     'is_final_month', 'daily_wage_settlement'
   );
-- 預期:0 row(5 欄位都還沒加)

-- Q1.2 ⚠ DRY-RUN hourly_rate backfill 影響面
--   跑此 SELECT 後 Ray 確認受影響員工數合理、薪資範圍正常,再進 ② 跑 UPDATE
SELECT COUNT(*) AS hourly_zero_count,
       MIN(base_salary) AS min_base,
       MAX(base_salary) AS max_base,
       AVG(base_salary)::INTEGER AS avg_base
FROM employees
WHERE (hourly_rate IS NULL OR hourly_rate = 0)
  AND base_salary > 0
  AND status = 'active';
-- 預期回 1 row、count = 受影響員工數
-- ⚠ 若 count 異常大(>50)或 base_salary 範圍可疑(min<10000 或 max>500000)
-- → 停下、檢查資料、不直接跑 ②

-- Q1.3 dry-run 抽樣前 5 筆受影響員工 + 計算後預期 hourly_rate
SELECT id, name, base_salary,
       hourly_rate AS old_hourly,
       ROUND(base_salary / 240.0, 2) AS new_hourly
FROM employees
WHERE (hourly_rate IS NULL OR hourly_rate = 0)
  AND base_salary > 0
  AND status = 'active'
ORDER BY id LIMIT 5;
-- 確認計算結果合理(例:30000 / 240 = 125、看起來像時薪)


-- ═══════════════════════════════════════════
-- ② ALTER TABLE + BACKFILL
-- ⚠ 跑此區前確認 Q1.2 / Q1.3 結果合理(員工數可控、base_salary 範圍正常)
-- ═══════════════════════════════════════════

BEGIN;

-- 1. salary_records 加 5 欄位

ALTER TABLE salary_records ADD COLUMN IF NOT EXISTS
  worked_days INTEGER;
COMMENT ON COLUMN salary_records.worked_days IS
  'B26:離職月實際在職曆日(月初到 resigned_at、含當天);非離職月為 NULL';

ALTER TABLE salary_records ADD COLUMN IF NOT EXISTS
  total_days_in_month INTEGER;
COMMENT ON COLUMN salary_records.total_days_in_month IS
  'B26:當月曆日數(28/29/30/31);非離職月為 NULL';

ALTER TABLE salary_records ADD COLUMN IF NOT EXISTS
  pro_rata_mode TEXT DEFAULT 'calendar_day'
    CHECK (pro_rata_mode IN ('calendar_day', 'workday', 'actual_clock'));
COMMENT ON COLUMN salary_records.pro_rata_mode IS
  'B26:離職月 pro-rata 計算模式;預設 calendar_day(按曆日)、workday(按工作日)
   、actual_clock(按實際打卡)。非離職月此欄位語意不適用、calculator 不讀。';

ALTER TABLE salary_records ADD COLUMN IF NOT EXISTS
  is_final_month BOOLEAN DEFAULT false;
COMMENT ON COLUMN salary_records.is_final_month IS
  'B26:離職月旗標;true 觸發 calculator pro-rata 整鏈路、預設 false 不影響既有行為。';

ALTER TABLE salary_records ADD COLUMN IF NOT EXISTS
  daily_wage_settlement NUMERIC(10, 2);
COMMENT ON COLUMN salary_records.daily_wage_settlement IS
  'B26:§38 法定結算日薪 = base_salary / 30(用於特休折現等法定金額);
   不同於 daily_wage_snapshot(= base / workdaysInMonth、用於月內缺勤扣薪)。';

-- 2. backfill hourly_rate=0 員工(init bug 修)
--    formula:base_salary / monthly_work_hours_base(預設 240)
--    對齊 api/salary/_repo.js findEmployeeHourlyRate

UPDATE employees
SET hourly_rate = ROUND(base_salary / 240.0, 2)
WHERE (hourly_rate IS NULL OR hourly_rate = 0)
  AND base_salary > 0
  AND status = 'active';
-- 預期更新 row 數 = Q1.2 count

COMMIT;


-- ═══════════════════════════════════════════
-- ③ VERIFY POST — 跑後確認生效
-- ═══════════════════════════════════════════

-- Q3.1 5 新欄位都加好 + 型別 + nullable + default 對
SELECT column_name, data_type, is_nullable, column_default
  FROM information_schema.columns
 WHERE table_schema='public' AND table_name='salary_records'
   AND column_name IN (
     'worked_days', 'total_days_in_month', 'pro_rata_mode',
     'is_final_month', 'daily_wage_settlement'
   )
 ORDER BY column_name;
-- 預期 5 row:
--   daily_wage_settlement  numeric                  YES  NULL
--   is_final_month         boolean                  YES  false
--   pro_rata_mode          text                     YES  'calendar_day'::text
--   total_days_in_month    integer                  YES  NULL
--   worked_days            integer                  YES  NULL

-- Q3.2 pro_rata_mode CHECK constraint 已加
SELECT conname, pg_get_constraintdef(oid)
  FROM pg_constraint
 WHERE conrelid='salary_records'::regclass
   AND contype='c'
   AND pg_get_constraintdef(oid) LIKE '%pro_rata_mode%';
-- 預期:CHECK (pro_rata_mode IN ('calendar_day','workday','actual_clock'))

-- Q3.3 hourly_rate=0 employees 已清空
SELECT COUNT(*) AS remaining_zero
FROM employees
WHERE (hourly_rate IS NULL OR hourly_rate = 0)
  AND base_salary > 0
  AND status = 'active';
-- 預期:0

-- Q3.4 抽樣驗算對的 active 員工 hourly_rate
SELECT id, name, base_salary, hourly_rate,
       ROUND(base_salary / 240.0, 2) AS expected_hourly,
       (hourly_rate = ROUND(base_salary / 240.0, 2)) AS match
FROM employees
WHERE status='active' AND base_salary > 0
ORDER BY id LIMIT 5;
-- 預期 5 row、match=true

-- Q3.5 既有 salary_records row 預設值正確(is_final_month=false)
SELECT COUNT(*) AS total_records,
       COUNT(*) FILTER (WHERE is_final_month = true) AS final_month_count,
       COUNT(*) FILTER (WHERE pro_rata_mode = 'calendar_day') AS calendar_day_count
FROM salary_records;
-- 預期:total_records > 0(看 prod 有多少)、final_month_count = 0、
-- calendar_day_count = total_records(DEFAULT 套用)

-- 重新載 PostgREST schema cache(讓 supabase-js client 看到新欄位)
NOTIFY pgrst, 'reload schema';
