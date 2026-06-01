-- ============================================================================
-- 2026-06-02: salary_grade 加 hourly_rate 欄(兼職職等帶時薪用)
-- ============================================================================
--
-- 背景:salary_grade 表原本只為正職月薪制設計(base_salary + 加給 + 全勤 +
-- 主管加給,結構由「職等職級」決定)。兼職(employment_type='part_time')目前
-- 沒有對應的時薪欄、HR 無法用「選職等職級」帶出時薪。
--
-- 此 migration 加 hourly_rate 欄(per grade × level 一個時薪值),供 part_time
-- 員工 saveEmployee 時依職等職級寫入 employees.hourly_rate。正職不使用此欄
-- (正職薪資仍走 base_salary=30000 + 加給結構)。
--
-- 兼職分級規格(Ray 公司政策):
--   一等 1 = 200 / hr   專員(新進兼職)
--   一等 2 = 200 / hr   專員(實習轉兼職、保留 1-1 同值,留升等空間)
--   一等 3 = 220 / hr   資深兼職
--   二等以上不設兼職時薪(兼職不會升到二等之後;後續若需要再補 UPDATE)
--
-- 注意:prod 已由 Ray 手動執行、本檔僅為 schema-source-of-truth 對齊版控、
-- 不要再跑一次(IF NOT EXISTS 守門避免 ADD COLUMN 重複報錯,UPDATE
-- idempotent 重複跑同值不影響但避免無謂寫入)。
-- ============================================================================

BEGIN;

ALTER TABLE salary_grade
  ADD COLUMN IF NOT EXISTS hourly_rate NUMERIC(8,2);

COMMENT ON COLUMN salary_grade.hourly_rate IS
  '兼職時薪(part_time 用)、由職等職級決定。正職不使用此欄、走 base_salary 月薪制。NULL 表示該職級不適用兼職。';

-- 一等 1-3:兼職時薪
UPDATE salary_grade SET hourly_rate = 200 WHERE grade = '一等' AND grade_level = 1;
UPDATE salary_grade SET hourly_rate = 200 WHERE grade = '一等' AND grade_level = 2;
UPDATE salary_grade SET hourly_rate = 220 WHERE grade = '一等' AND grade_level = 3;

-- 二等 / 三等:不設兼職時薪、保留 NULL(兼職不會升到此級)

COMMIT;

NOTIFY pgrst, 'reload schema';

-- ─── VERIFY(prod 跑後可選用,本檔不執行)─────────────────────────────────
-- SELECT grade, grade_level, base_salary, hourly_rate FROM salary_grade ORDER BY id;
-- 預期:
--   一等 1: hourly_rate = 200
--   一等 2: hourly_rate = 200
--   一等 3: hourly_rate = 220
--   二等 1-3 / 三等 1-5: hourly_rate = NULL
