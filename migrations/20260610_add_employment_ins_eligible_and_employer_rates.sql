-- ============================================================
-- Commit 2: 中央費率表補就保等 2026 缺漏費率 + insurance_settings 加就保適格欄
-- 已於 prod Supabase SQL Editor 執行,本檔為歷史紀錄
-- (重跑時 INSERT 會撞 unique 約束 category+parameter_name+effective_from,屬正常)
-- ============================================================
BEGIN;

SELECT * FROM salary_parameter_definitions ORDER BY id;

ALTER TABLE insurance_settings
  ADD COLUMN IF NOT EXISTS employment_ins_eligible BOOLEAN NOT NULL DEFAULT true;

INSERT INTO salary_parameter_definitions
  (category, parameter_name, label_zh, parameter_value, unit, regulation_basis, effective_from) VALUES
  ('employment_insurance','employee_rate','就業保險-被保險人負擔(1%×20%)',0.002,'rate','就業保險法§41','2026-01-01'),
  ('employment_insurance','employer_rate','就業保險-投保單位負擔(1%×70%)',0.007,'rate','就業保險法§41','2026-01-01'),
  ('labor_insurance','employer_rate','勞保普通事故-投保單位負擔(11.5%×70%)',0.0805,'rate','勞工保險條例§13','2026-01-01'),
  ('health_insurance','employer_rate','健保-投保單位負擔比率(5.17%×60%)',0.03102,'rate','全民健康保險法§27','2026-01-01'),
  ('health_insurance','avg_dependents','健保平均眷口數(雇主負擔乘數,合計1.56)',0.56,'person','健保署115年公告','2026-01-01'),
  ('occupational_accident','employer_rate','職災保險費率(待依繳款單行業別填)',0,'rate','勞工職業災害保險及保護法','2026-01-01');

SELECT category,parameter_name,parameter_value,unit FROM salary_parameter_definitions
 WHERE category IN ('employment_insurance','occupational_accident')
    OR parameter_name IN ('employer_rate','avg_dependents')
 ORDER BY category,parameter_name;

COMMIT;
