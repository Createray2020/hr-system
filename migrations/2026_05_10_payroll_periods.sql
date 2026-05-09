-- 階段 1.2: 新表 payroll_periods(薪資期間 + 狀態機)+ FK 串 salary_records
-- 對應驗證: migrations-verify/verify_payroll_periods.sql

BEGIN;

-- ====================================================================
-- §1. payroll_periods 表
-- ====================================================================

CREATE TABLE IF NOT EXISTS payroll_periods (
  id                       TEXT PRIMARY KEY,
  year                     INTEGER NOT NULL,
  month                    INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),

  -- 期間定義
  period_start             DATE NOT NULL,
  period_end               DATE NOT NULL,
  attendance_cutoff_date   DATE,
  pay_date                 DATE,

  -- 狀態機(對齊 lib/schedule/period-state.js 風格)
  status                   TEXT NOT NULL DEFAULT 'draft'
                           CHECK (status IN ('draft','calculating','pending_review',
                                             'approved','paid','locked')),

  -- 統計 cache(由 calculator 跑完寫入、display 用)
  employee_count           INTEGER NOT NULL DEFAULT 0,
  gross_total              NUMERIC(15,2) NOT NULL DEFAULT 0,
  net_total                NUMERIC(15,2) NOT NULL DEFAULT 0,
  employer_cost_total      NUMERIC(15,2) NOT NULL DEFAULT 0,

  -- audit
  created_by               TEXT REFERENCES employees(id),
  created_at               TIMESTAMPTZ DEFAULT NOW(),
  calculated_at            TIMESTAMPTZ,
  reviewed_by              TEXT REFERENCES employees(id),
  reviewed_at              TIMESTAMPTZ,
  approved_by              TEXT REFERENCES employees(id),
  approved_at              TIMESTAMPTZ,
  paid_at                  TIMESTAMPTZ,
  locked_at                TIMESTAMPTZ,

  note                     TEXT
);

DO $$ BEGIN
  ALTER TABLE payroll_periods
    ADD CONSTRAINT payroll_periods_year_month_key UNIQUE (year, month);
EXCEPTION WHEN duplicate_object OR duplicate_table THEN null;
END $$;

COMMENT ON TABLE  payroll_periods IS '薪資期間狀態機(每月一筆、HR 開新月份 → calculator 跑 → 老闆審 → 標發放 → 月底自動 lock)';
COMMENT ON COLUMN payroll_periods.id                     IS '例 PP_2026_05';
COMMENT ON COLUMN payroll_periods.attendance_cutoff_date IS '出勤截止日(通常該月最後一天)';
COMMENT ON COLUMN payroll_periods.pay_date               IS '預定發薪日(通常下月 5/10/15 號)';
COMMENT ON COLUMN payroll_periods.status                 IS '狀態機:draft → calculating → pending_review → approved → paid → locked';
COMMENT ON COLUMN payroll_periods.employee_count         IS '統計 cache:該期間 salary_records 員工數';
COMMENT ON COLUMN payroll_periods.gross_total            IS '統計 cache:應發合計';
COMMENT ON COLUMN payroll_periods.net_total              IS '統計 cache:實發合計';
COMMENT ON COLUMN payroll_periods.employer_cost_total    IS '統計 cache:雇主成本合計';

-- ====================================================================
-- §2. salary_records 加 payroll_period_id FK(1.1 已先 ADD COLUMN、本步加 FK)
-- ====================================================================

DO $$ BEGIN
  ALTER TABLE salary_records
    ADD CONSTRAINT salary_records_payroll_period_id_fkey
    FOREIGN KEY (payroll_period_id) REFERENCES payroll_periods(id);
EXCEPTION WHEN duplicate_object OR duplicate_table THEN null;
END $$;

-- ====================================================================
-- §3. index
-- ====================================================================

CREATE INDEX IF NOT EXISTS idx_salary_records_payroll_period_id
  ON salary_records(payroll_period_id);

-- 工作流 hot path:撈未完成的期間(draft/calculating/pending_review/approved)
CREATE INDEX IF NOT EXISTS idx_payroll_periods_status_active
  ON payroll_periods(status)
  WHERE status NOT IN ('paid','locked');

-- 月份查詢 hot path
CREATE INDEX IF NOT EXISTS idx_payroll_periods_year_month
  ON payroll_periods(year DESC, month DESC);

-- ====================================================================
-- §4. RLS — HR-only(payroll 期間是設定 / 工作流資料、不分員工)
-- ====================================================================

ALTER TABLE payroll_periods ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "payroll_periods_select" ON payroll_periods
    FOR SELECT TO public USING (auth_is_hr_admin());
EXCEPTION WHEN duplicate_object OR duplicate_table THEN null;
END $$;

DO $$ BEGIN
  CREATE POLICY "payroll_periods_insert" ON payroll_periods
    FOR INSERT TO public WITH CHECK (auth_is_hr_admin());
EXCEPTION WHEN duplicate_object OR duplicate_table THEN null;
END $$;

DO $$ BEGIN
  CREATE POLICY "payroll_periods_update" ON payroll_periods
    FOR UPDATE TO public USING (auth_is_hr_admin()) WITH CHECK (auth_is_hr_admin());
EXCEPTION WHEN duplicate_object OR duplicate_table THEN null;
END $$;

DO $$ BEGIN
  CREATE POLICY "payroll_periods_delete" ON payroll_periods
    FOR DELETE TO public USING (auth_is_hr_admin());
EXCEPTION WHEN duplicate_object OR duplicate_table THEN null;
END $$;

COMMIT;
