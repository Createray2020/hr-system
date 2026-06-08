-- migrations/2026_06_08c_expense_categories_constraints.sql
-- Phase 2:expense_categories 補 created_by(審計)+ UNIQUE(name)(防重複類別)
-- 冪等;表此時為空,加 UNIQUE 無衝突風險

BEGIN;

ALTER TABLE public.expense_categories
  ADD COLUMN IF NOT EXISTS created_by text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='uq_expense_categories_name') THEN
    ALTER TABLE public.expense_categories
      ADD CONSTRAINT uq_expense_categories_name UNIQUE (name);
  END IF;
END $$;

COMMIT;

-- 回滾(正常不要執行)
-- ALTER TABLE public.expense_categories DROP CONSTRAINT IF EXISTS uq_expense_categories_name;
-- ALTER TABLE public.expense_categories DROP COLUMN IF EXISTS created_by;
