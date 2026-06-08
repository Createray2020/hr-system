-- migrations/2026_06_08_add_expense_reimbursement_payroll.sql
-- 請款核准併入隔月薪資 Phase 1 schema only
-- 冪等可重跑;摘要欄預設 0、此階段不接 gross(待產生式確認後另一支 migration)
-- 回滾見檔尾註解區塊

BEGIN;

-- 前置檢查:依賴表存在
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema='public' AND table_name='salary_records') THEN
    RAISE EXCEPTION 'salary_records 不存在,中止';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema='public' AND table_name='approval_requests') THEN
    RAISE EXCEPTION 'approval_requests 不存在,中止';
  END IF;
END $$;

-- 類別清單:is_wage 為 metadata 不影響計算、is_taxable 為計稅槓桿
CREATE TABLE IF NOT EXISTS public.expense_categories (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  is_wage     boolean NOT NULL DEFAULT false,
  is_taxable  boolean NOT NULL DEFAULT true,
  is_active   boolean NOT NULL DEFAULT true,
  sort_order  integer NOT NULL DEFAULT 0,
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.expense_categories IS '請款併薪類別;is_wage 為 metadata,is_taxable 為計稅槓桿';

-- 逐筆併薪請款(子表 = 摘要欄 SoT;旗標寫入時 snapshot,類別日後改設定不回溯已結算)
CREATE TABLE IF NOT EXISTS public.salary_expense_entries (
  id                     text PRIMARY KEY,
  approval_request_id    text,
  employee_id            text NOT NULL,
  salary_record_id       text,
  target_year            integer NOT NULL,
  target_month           integer NOT NULL,
  category_id            text,
  category_name_snapshot text NOT NULL,
  is_wage_snapshot       boolean NOT NULL DEFAULT false,
  is_taxable_snapshot    boolean NOT NULL DEFAULT true,
  amount                 numeric(12,2) NOT NULL DEFAULT 0,
  expense_date           date,
  description            text,
  settlement_mode        text NOT NULL DEFAULT 'defer',
  deferred_from          text,
  status                 text NOT NULL DEFAULT 'active',
  note                   text,
  created_by             text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  deleted_at             timestamptz,
  CONSTRAINT chk_see_settlement_mode CHECK (settlement_mode IN ('defer','force')),
  CONSTRAINT chk_see_status CHECK (status IN ('active','voided')),
  CONSTRAINT chk_see_month CHECK (target_month BETWEEN 1 AND 12),
  CONSTRAINT fk_see_category FOREIGN KEY (category_id)
    REFERENCES public.expense_categories(id) ON DELETE RESTRICT,
  CONSTRAINT fk_see_approval FOREIGN KEY (approval_request_id)
    REFERENCES public.approval_requests(id) ON DELETE SET NULL,
  CONSTRAINT fk_see_salary FOREIGN KEY (salary_record_id)
    REFERENCES public.salary_records(id) ON DELETE SET NULL
);
COMMENT ON TABLE public.salary_expense_entries IS '逐筆併薪請款;(employee_id,target_year,target_month) 為計算機加總來源';

CREATE INDEX IF NOT EXISTS idx_see_period
  ON public.salary_expense_entries (employee_id, target_year, target_month)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_see_salary_record
  ON public.salary_expense_entries (salary_record_id);
CREATE INDEX IF NOT EXISTS idx_see_approval
  ON public.salary_expense_entries (approval_request_id);
-- 同一張簽核單只能併薪一次,防 cascade 重跑重複入帳
CREATE UNIQUE INDEX IF NOT EXISTS uq_see_approval_active
  ON public.salary_expense_entries (approval_request_id)
  WHERE approval_request_id IS NOT NULL AND deleted_at IS NULL AND status = 'active';

-- salary_records 摘要欄(由子表重算重建,batch 安全;此階段尚未接 gross)
ALTER TABLE public.salary_records
  ADD COLUMN IF NOT EXISTS expense_reimbursement_total   numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS expense_reimbursement_taxable numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS expense_reimbursement_note    text;

COMMIT;

-- 回滾(正常不要執行)
-- ALTER TABLE public.salary_records
--   DROP COLUMN IF EXISTS expense_reimbursement_total,
--   DROP COLUMN IF EXISTS expense_reimbursement_taxable,
--   DROP COLUMN IF EXISTS expense_reimbursement_note;
-- DROP TABLE IF EXISTS public.salary_expense_entries;
-- DROP TABLE IF EXISTS public.expense_categories;
