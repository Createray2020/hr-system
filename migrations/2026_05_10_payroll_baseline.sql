-- 階段 0.1: payroll 模組 baseline migration
-- 目的: 補齊 prod-only drift schema、為新薪資模組打基礎
-- 規則: idempotent (可重跑)、不 destructive (不 DROP / 不 TRUNCATE)
-- 對應驗證: migrations-verify/verify_payroll_baseline.sql

BEGIN;

-- ====================================================================
-- §1. employees 補 8 個 prod-only drift 欄位 + schema comment
-- ====================================================================

ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS attendance_bonus  NUMERIC(10,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS grade_allowance   NUMERIC(10,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS manager_allowance NUMERIC(10,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS has_insurance     BOOLEAN       DEFAULT true,
  ADD COLUMN IF NOT EXISTS grade             TEXT,
  ADD COLUMN IF NOT EXISTS grade_level       INTEGER,
  ADD COLUMN IF NOT EXISTS hourly_rate       NUMERIC(10,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS resign_date       DATE;

COMMENT ON COLUMN employees.attendance_bonus  IS '全勤獎金 base 額度(屬經常性給付、列入投保薪資)';
COMMENT ON COLUMN employees.grade_allowance   IS '職等加給(經常性給付、列入投保薪資)';
COMMENT ON COLUMN employees.manager_allowance IS '主管加給(經常性給付、列入投保薪資)';
COMMENT ON COLUMN employees.has_insurance     IS 'false = 不投保(執行長 / 專案合作 / 特殊情況)';
COMMENT ON COLUMN employees.grade             IS '職等(對應 salary_grade.grade,如 一等/二等/三等)';
COMMENT ON COLUMN employees.grade_level       IS '職級(對應 salary_grade.grade_level)';
COMMENT ON COLUMN employees.hourly_rate       IS '時薪(part_time 用)';
COMMENT ON COLUMN employees.resign_date       IS '預計離職日期(planning、由前端表單寫入)';
COMMENT ON COLUMN employees.resigned_at       IS '實際離職時刻(audit / SoT、由 PUT/DELETE status=resigned 時寫入)';

-- ====================================================================
-- §2. labor_insurance_brackets - 勞保投保薪資級距表
-- 依據: 勞工保險條例 §13、§14、政府每年公告
-- ====================================================================

CREATE TABLE IF NOT EXISTS labor_insurance_brackets (
  id               SERIAL PRIMARY KEY,
  bracket_level    INTEGER NOT NULL,
  monthly_wage_min NUMERIC(10,2) NOT NULL,
  monthly_wage_max NUMERIC(10,2),
  insured_salary   NUMERIC(10,2) NOT NULL,
  employee_premium NUMERIC(10,2) NOT NULL,
  company_premium  NUMERIC(10,2) NOT NULL
);

DO $$ BEGIN
  ALTER TABLE labor_insurance_brackets
    ADD CONSTRAINT labor_insurance_brackets_bracket_level_key UNIQUE (bracket_level);
EXCEPTION WHEN duplicate_object OR duplicate_table THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE labor_insurance_brackets
    ADD CONSTRAINT labor_insurance_brackets_level_positive CHECK (bracket_level >= 1);
EXCEPTION WHEN duplicate_object OR duplicate_table THEN null;
END $$;

COMMENT ON TABLE labor_insurance_brackets IS '勞保投保薪資級距表(依勞工保險條例第 13、14 條、政府每年公告)';

-- ====================================================================
-- §3. health_insurance_brackets - 健保投保金額級距表
-- 依據: 全民健康保險法、政府每年公告(與勞保表不同)
-- ====================================================================

CREATE TABLE IF NOT EXISTS health_insurance_brackets (
  id               SERIAL PRIMARY KEY,
  bracket_level    INTEGER NOT NULL,
  monthly_wage_min NUMERIC(10,2) NOT NULL,
  monthly_wage_max NUMERIC(10,2),
  insured_salary   NUMERIC(10,2) NOT NULL,
  employee_premium NUMERIC(10,2) NOT NULL,
  company_premium  NUMERIC(10,2) NOT NULL,
  per_dependent    NUMERIC(10,2) NOT NULL DEFAULT 0
);

DO $$ BEGIN
  ALTER TABLE health_insurance_brackets
    ADD CONSTRAINT health_insurance_brackets_bracket_level_key UNIQUE (bracket_level);
EXCEPTION WHEN duplicate_object OR duplicate_table THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE health_insurance_brackets
    ADD CONSTRAINT health_insurance_brackets_level_positive CHECK (bracket_level >= 1);
EXCEPTION WHEN duplicate_object OR duplicate_table THEN null;
END $$;

COMMENT ON TABLE health_insurance_brackets IS '健保投保金額級距表(每位眷屬另收 per_dependent)';

-- ====================================================================
-- §4. insurance_settings - 員工 × 級距(擴勞退自願 + 補 created_at)
-- ====================================================================

CREATE TABLE IF NOT EXISTS insurance_settings (
  id                       TEXT PRIMARY KEY,
  employee_id              TEXT NOT NULL REFERENCES employees(id),
  has_insurance            BOOLEAN NOT NULL DEFAULT true,
  labor_ins_bracket        NUMERIC DEFAULT 0,
  labor_ins_employee       NUMERIC DEFAULT 0,
  labor_ins_company        NUMERIC DEFAULT 0,
  health_ins_bracket       NUMERIC DEFAULT 0,
  health_ins_employee      NUMERIC DEFAULT 0,
  health_ins_company       NUMERIC DEFAULT 0,
  health_ins_dependents    INTEGER DEFAULT 0,
  pension_rate             NUMERIC DEFAULT 6,
  pension_company          NUMERIC DEFAULT 0,
  updated_at               TIMESTAMPTZ DEFAULT NOW()
);

DO $$ BEGIN
  ALTER TABLE insurance_settings
    ADD CONSTRAINT insurance_settings_employee_id_key UNIQUE (employee_id);
EXCEPTION WHEN duplicate_object OR duplicate_table THEN null;
END $$;

ALTER TABLE insurance_settings
  ADD COLUMN IF NOT EXISTS pension_voluntary_rate   NUMERIC(4,3)  DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pension_voluntary_amount NUMERIC(10,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pension_wage             NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS created_at               TIMESTAMPTZ   DEFAULT NOW();

COMMENT ON COLUMN insurance_settings.pension_rate             IS '雇主強制提繳率(預設 6%、勞退條例 §14 規定下限 6%)';
COMMENT ON COLUMN insurance_settings.pension_voluntary_rate   IS '員工自願提繳率 0~6%(免稅、勞退條例 §14)';
COMMENT ON COLUMN insurance_settings.pension_voluntary_amount IS '員工自願提繳金額(每月從薪資扣)';
COMMENT ON COLUMN insurance_settings.pension_wage             IS '勞退月提繳工資 snapshot(可能跟勞保投保薪資不同)';

-- ====================================================================
-- §5. insurance_change_requests - 級距變動申請(擴 pension 4 欄)
-- ====================================================================

CREATE TABLE IF NOT EXISTS insurance_change_requests (
  id                  TEXT PRIMARY KEY,
  employee_id         TEXT NOT NULL REFERENCES employees(id),
  request_type        TEXT NOT NULL DEFAULT 'bracket_change',
  old_monthly_salary  NUMERIC,
  old_labor_bracket   NUMERIC, old_labor_employee  NUMERIC, old_labor_company  NUMERIC,
  old_health_bracket  NUMERIC, old_health_employee NUMERIC, old_health_company NUMERIC,
  new_monthly_salary  NUMERIC,
  new_labor_bracket   NUMERIC, new_labor_employee  NUMERIC, new_labor_company  NUMERIC,
  new_health_bracket  NUMERIC, new_health_employee NUMERIC, new_health_company NUMERIC,
  status              TEXT NOT NULL DEFAULT 'pending',
  trigger_reason      TEXT DEFAULT '',
  note                TEXT DEFAULT '',
  requested_by        TEXT,
  approved_by         TEXT,
  effective_date      DATE,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  handled_at          TIMESTAMPTZ
);

ALTER TABLE insurance_change_requests
  ADD COLUMN IF NOT EXISTS old_pension_rate    NUMERIC(4,3),
  ADD COLUMN IF NOT EXISTS old_pension_company NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS new_pension_rate    NUMERIC(4,3),
  ADD COLUMN IF NOT EXISTS new_pension_company NUMERIC(10,2);

DO $$ BEGIN
  ALTER TABLE insurance_change_requests
    ADD CONSTRAINT insurance_change_requests_status_check
    CHECK (status IN ('pending','approved','rejected','cancelled'));
EXCEPTION WHEN duplicate_object OR duplicate_table THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE insurance_change_requests
    ADD CONSTRAINT insurance_change_requests_requested_by_fkey
    FOREIGN KEY (requested_by) REFERENCES employees(id);
EXCEPTION WHEN duplicate_object OR duplicate_table THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE insurance_change_requests
    ADD CONSTRAINT insurance_change_requests_approved_by_fkey
    FOREIGN KEY (approved_by) REFERENCES employees(id);
EXCEPTION WHEN duplicate_object OR duplicate_table THEN null;
END $$;

COMMENT ON COLUMN insurance_change_requests.old_pension_rate    IS '變動前的雇主強制提繳率';
COMMENT ON COLUMN insurance_change_requests.old_pension_company IS '變動前的雇主提繳金額';
COMMENT ON COLUMN insurance_change_requests.new_pension_rate    IS '變動後的雇主強制提繳率';
COMMENT ON COLUMN insurance_change_requests.new_pension_company IS '變動後的雇主提繳金額';

-- ====================================================================
-- §6. salary_grade - 職等薪資級距預設表
-- ====================================================================

CREATE TABLE IF NOT EXISTS salary_grade (
  id                SERIAL PRIMARY KEY,
  grade             TEXT NOT NULL,
  grade_level       INTEGER NOT NULL,
  grade_name        TEXT NOT NULL,
  base_salary       NUMERIC DEFAULT 30000,
  attendance_bonus  NUMERIC DEFAULT 0,
  grade_allowance   NUMERIC DEFAULT 0,
  can_be_manager    BOOLEAN DEFAULT false,
  manager_allowance NUMERIC DEFAULT 0,
  monthly_total     NUMERIC
);

DO $$ BEGIN
  ALTER TABLE salary_grade
    ADD CONSTRAINT salary_grade_grade_grade_level_key UNIQUE (grade, grade_level);
EXCEPTION WHEN duplicate_object OR duplicate_table THEN null;
END $$;

COMMENT ON TABLE salary_grade IS '職等薪資級距預設表(HR 設定參考用、不是員工實際月薪)';
COMMENT ON COLUMN salary_grade.monthly_total IS '職等預設月薪 = base + attendance + grade_allowance(不含 manager / extra、員工實際投保薪資以 calcSalary() 5 項合計為準)';

-- ====================================================================
-- §7. insurance_settings_history - 薪資沿革(新表、由 trigger 自動寫)
-- ====================================================================

CREATE TABLE IF NOT EXISTS insurance_settings_history (
  id                BIGSERIAL PRIMARY KEY,
  employee_id       TEXT NOT NULL REFERENCES employees(id),
  snapshot          JSONB NOT NULL,
  change_request_id TEXT REFERENCES insurance_change_requests(id),
  effective_from    DATE NOT NULL,
  effective_to      DATE,
  created_by        TEXT REFERENCES employees(id),
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE insurance_settings_history IS '勞健保 / 勞退設定歷史 snapshot(每次 insurance_settings 變動 trigger 自動寫一筆、不可手動修改)';

CREATE INDEX IF NOT EXISTS idx_ish_employee_effective
  ON insurance_settings_history(employee_id, effective_from DESC);

-- ====================================================================
-- §8. 補 performance index
-- ====================================================================

CREATE INDEX IF NOT EXISTS idx_icr_employee_id
  ON insurance_change_requests(employee_id);

CREATE INDEX IF NOT EXISTS idx_icr_status_created
  ON insurance_change_requests(status, created_at DESC);

-- ====================================================================
-- §9. RLS - 既有 5 張表 prod 已有 policy、新表 history 走 HR-only
-- ====================================================================

ALTER TABLE labor_insurance_brackets   ENABLE ROW LEVEL SECURITY;
ALTER TABLE health_insurance_brackets  ENABLE ROW LEVEL SECURITY;
ALTER TABLE insurance_settings         ENABLE ROW LEVEL SECURITY;
ALTER TABLE insurance_change_requests  ENABLE ROW LEVEL SECURITY;
ALTER TABLE salary_grade               ENABLE ROW LEVEL SECURITY;
ALTER TABLE insurance_settings_history ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "ish_select" ON insurance_settings_history
    FOR SELECT TO public
    USING (auth_is_hr_admin() OR (snapshot->>'employee_id') = auth_employee_id());
EXCEPTION WHEN duplicate_object OR duplicate_table THEN null;
END $$;

DO $$ BEGIN
  CREATE POLICY "ish_insert" ON insurance_settings_history
    FOR INSERT TO public
    WITH CHECK (auth_is_hr_admin());
EXCEPTION WHEN duplicate_object OR duplicate_table THEN null;
END $$;

-- 不允許 UPDATE / DELETE history (immutable audit log)

-- ====================================================================
-- §10. trigger: insurance_settings 變動自動寫 history
-- ====================================================================

CREATE OR REPLACE FUNCTION sync_insurance_settings_history()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  caller_id TEXT;
BEGIN
  BEGIN
    caller_id := auth_employee_id();
  EXCEPTION WHEN OTHERS THEN
    caller_id := NULL;
  END;

  IF TG_OP = 'UPDATE' THEN
    UPDATE insurance_settings_history
       SET effective_to = CURRENT_DATE
     WHERE employee_id = OLD.employee_id
       AND effective_to IS NULL;
  END IF;

  INSERT INTO insurance_settings_history (
    employee_id, snapshot, effective_from, created_by
  ) VALUES (
    NEW.employee_id, to_jsonb(NEW), CURRENT_DATE, caller_id
  );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tg_insurance_settings_history ON insurance_settings;
CREATE TRIGGER tg_insurance_settings_history
  AFTER INSERT OR UPDATE ON insurance_settings
  FOR EACH ROW
  EXECUTE FUNCTION sync_insurance_settings_history();

COMMIT;
