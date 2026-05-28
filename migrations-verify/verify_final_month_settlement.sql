-- ==========================================
-- Migration: 2026_05_26_final_month_settlement.sql
-- Phase:     B26 批次 1(離職月薪資 pro-rata 結算 schema)
-- 用途:     salary_records 加 5 新欄位 + employees.hourly_rate=0 backfill
-- 類型:     ALTER TABLE ADD COLUMN(× 5)+ UPDATE backfill
-- ==========================================

-- ═══════════════════════════════════════════
-- ① VERIFY PRE — 跑前確認 + dry-run
-- 預期:
--   Q1.1 columns 0 row(5 欄位都還沒加)
--   Q1.2 hourly_zero_count 合理(<50)、base_salary 範圍正常
--   Q1.3 抽樣計算後 new_hourly = base / 240 看起來合理
-- ═══════════════════════════════════════════

-- Q1.1 5 新欄位不存在
SELECT column_name FROM information_schema.columns
 WHERE table_schema='public' AND table_name='salary_records'
   AND column_name IN (
     'worked_days', 'total_days_in_month', 'pro_rata_mode',
     'is_final_month', 'daily_wage_settlement'
   );
-- 預期:0 row

-- Q1.2 dry-run hourly_rate backfill 影響面
SELECT COUNT(*) AS hourly_zero_count,
       MIN(base_salary) AS min_base,
       MAX(base_salary) AS max_base,
       AVG(base_salary)::INTEGER AS avg_base
FROM employees
WHERE (hourly_rate IS NULL OR hourly_rate = 0)
  AND base_salary > 0
  AND status = 'active';
-- ⚠ Ray 確認:count 合理、base_salary 範圍正常(10000~500000 區間)

-- Q1.3 dry-run 抽樣
SELECT id, name, base_salary,
       hourly_rate AS old_hourly,
       ROUND(base_salary / 240.0, 2) AS new_hourly
FROM employees
WHERE (hourly_rate IS NULL OR hourly_rate = 0)
  AND base_salary > 0
  AND status = 'active'
ORDER BY id LIMIT 5;


-- ═══════════════════════════════════════════
-- ② ALTER + BACKFILL(從原檔複製)
-- ═══════════════════════════════════════════

BEGIN;

ALTER TABLE salary_records ADD COLUMN IF NOT EXISTS
  worked_days INTEGER;
ALTER TABLE salary_records ADD COLUMN IF NOT EXISTS
  total_days_in_month INTEGER;
ALTER TABLE salary_records ADD COLUMN IF NOT EXISTS
  pro_rata_mode TEXT DEFAULT 'calendar_day'
    CHECK (pro_rata_mode IN ('calendar_day', 'workday', 'actual_clock'));
ALTER TABLE salary_records ADD COLUMN IF NOT EXISTS
  is_final_month BOOLEAN DEFAULT false;
ALTER TABLE salary_records ADD COLUMN IF NOT EXISTS
  daily_wage_settlement NUMERIC(10, 2);

UPDATE employees
SET hourly_rate = ROUND(base_salary / 240.0, 2)
WHERE (hourly_rate IS NULL OR hourly_rate = 0)
  AND base_salary > 0
  AND status = 'active';

COMMIT;

NOTIFY pgrst, 'reload schema';


-- ═══════════════════════════════════════════
-- ③ VERIFY POST — 跑後確認生效
-- 預期:
--   Q3.1 5 欄位都加好(types / defaults 對)
--   Q3.2 pro_rata_mode CHECK constraint 套用
--   Q3.3 hourly_rate=0 員工已歸 0(backfill 全完)
--   Q3.4 抽樣驗算 hourly_rate = base / 240
--   Q3.5 既有 salary_records 預設值正確
-- ═══════════════════════════════════════════

-- Q3.1 5 新欄位
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

-- Q3.2 CHECK constraint
SELECT conname, pg_get_constraintdef(oid)
  FROM pg_constraint
 WHERE conrelid='salary_records'::regclass
   AND contype='c'
   AND pg_get_constraintdef(oid) LIKE '%pro_rata_mode%';
-- 預期 1 row:CHECK (pro_rata_mode IN ('calendar_day','workday','actual_clock'))

-- Q3.3 hourly_rate=0 清空
SELECT COUNT(*) AS remaining_zero
FROM employees
WHERE (hourly_rate IS NULL OR hourly_rate = 0)
  AND base_salary > 0
  AND status = 'active';
-- 預期:0

-- Q3.4 抽樣驗算
SELECT id, name, base_salary, hourly_rate,
       ROUND(base_salary / 240.0, 2) AS expected_hourly,
       (hourly_rate = ROUND(base_salary / 240.0, 2)) AS match
FROM employees
WHERE status='active' AND base_salary > 0
ORDER BY id LIMIT 5;
-- 預期 5 row、match=true

-- Q3.5 既有 salary_records 預設值
SELECT COUNT(*) AS total_records,
       COUNT(*) FILTER (WHERE is_final_month = true) AS final_month_count,
       COUNT(*) FILTER (WHERE pro_rata_mode = 'calendar_day') AS calendar_day_count
FROM salary_records;
-- 預期:total_records > 0(看 prod)、final_month_count=0、calendar_day_count=total_records


-- ═══════════════════════════════════════════
-- ④ ROLLBACK plan(若 Q3 任一驗證失敗)
-- ═══════════════════════════════════════════
-- 移除 5 新欄位:
--   ALTER TABLE salary_records DROP COLUMN IF EXISTS worked_days;
--   ALTER TABLE salary_records DROP COLUMN IF EXISTS total_days_in_month;
--   ALTER TABLE salary_records DROP COLUMN IF EXISTS pro_rata_mode;
--   ALTER TABLE salary_records DROP COLUMN IF EXISTS is_final_month;
--   ALTER TABLE salary_records DROP COLUMN IF EXISTS daily_wage_settlement;
--
-- hourly_rate backfill rollback(若需要):
--   無法精準 rollback(原本 0 / NULL 都已 UPDATE 為 base/240、無 trail)
--   若必要、需單獨備份 employees.hourly_rate 跑 UPDATE 前先撈 snapshot:
--   CREATE TABLE _backup_employees_hourly_rate_2026_05_26 AS
--     SELECT id, hourly_rate FROM employees WHERE status='active';
--   (Ray 跑 ② 前可選擇先建 snapshot 表)
