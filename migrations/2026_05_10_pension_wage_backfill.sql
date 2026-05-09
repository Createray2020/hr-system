-- 階段 2.7: insurance_settings.pension_wage 既有 0 / NULL row 補值
--
-- 背景: 0.1 加 pension_wage 欄位時 default 0、prod 既有 19 row 沒人主動 set 過、
--       導致 calculator employer_cost_pension = 0、法定雇主強制 6% 提繳沒算到。
--
-- 規則: idempotent(可重跑)、整段 transaction 包住
-- 對應驗證: migrations-verify/verify_pension_wage_backfill.sql

BEGIN;

UPDATE insurance_settings
SET    pension_wage = labor_ins_bracket
WHERE (pension_wage IS NULL OR pension_wage = 0)
  AND labor_ins_bracket IS NOT NULL
  AND labor_ins_bracket > 0;

COMMIT;
