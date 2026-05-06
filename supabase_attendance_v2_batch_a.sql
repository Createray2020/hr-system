-- =====================================================
-- supabase_attendance_v2_batch_a.sql
-- 出勤核心系統 v2.0 - Batch A：純新增表（零風險）
-- 對應設計文件：docs/attendance-system-design-v1.md §4 (commit 8721a2f)
-- 執行時機：在跑 Batch B 之前
-- 回滾方式：DROP TABLE 即可（見 README）
-- =====================================================

-- ========== holidays ==========
CREATE TABLE holidays (
  id            BIGSERIAL PRIMARY KEY,
  date          DATE NOT NULL,
  holiday_type  TEXT NOT NULL CHECK (holiday_type IN (
                  'national',
                  'makeup_workday',
                  'company',
                  'flexible'
                )),
  name          TEXT NOT NULL,
  description   TEXT,
  pay_multiplier NUMERIC(4,2) DEFAULT 2.00,
  source        TEXT NOT NULL CHECK (source IN ('manual', 'imported')),
  imported_from TEXT,
  imported_at   TIMESTAMPTZ,
  created_by    TEXT REFERENCES employees(id),
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (date, holiday_type)
);

CREATE INDEX idx_holidays_date ON holidays(date);
CREATE INDEX idx_holidays_year ON holidays(EXTRACT(YEAR FROM date));


-- ========== leave_types ==========
-- 2026-05-05: Phase 1.1 加 advance_hours / advance_rule / requires_proof / proof_grace_days
-- 詳見 migrations/2026_05_05_leave_phase1_schema.sql
CREATE TABLE leave_types (
  code            TEXT PRIMARY KEY,
  name_zh         TEXT NOT NULL,
  is_paid         BOOLEAN NOT NULL DEFAULT true,
  pay_rate        NUMERIC(4,2) NOT NULL DEFAULT 1.00,
  affects_attendance_bonus BOOLEAN NOT NULL DEFAULT true,
  affects_attendance_rate  BOOLEAN NOT NULL DEFAULT true,
  has_balance     BOOLEAN NOT NULL DEFAULT false,
  legal_max_days_per_year INT,
  is_active       BOOLEAN NOT NULL DEFAULT true,
  display_order   INT NOT NULL DEFAULT 0,
  description     TEXT,
  legal_reference TEXT,
  -- 2026-05-05 Phase 1.1: 前置時間 / 證明
  advance_hours    INTEGER NOT NULL DEFAULT 0,
  advance_rule     TEXT    NOT NULL DEFAULT 'soft' CHECK (advance_rule IN ('hard','soft')),
  requires_proof   BOOLEAN NOT NULL DEFAULT false,
  proof_grace_days INTEGER NOT NULL DEFAULT 0,
  -- 2026-05-06 Phase 1.5 升級: 證明過期分流動作
  --   convert      — 過期自動轉事假(短假、員工該負責補:sick / hospital_unpaid)
  --   mark_expired — 過期只標 proof_status=expired、leave_type 不動、HR 個案處理(法定假)
  -- 詳見 migrations/2026_05_06_leave_proof_expiry_action.sql
  proof_expiry_action TEXT NOT NULL DEFAULT 'convert'
    CHECK (proof_expiry_action IN ('convert','mark_expired')),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- batch_a 原有 8 種假別、含 Phase 1.1 backfill 後的 advance_* / requires_proof / proof_grace_days
-- ON CONFLICT DO UPDATE 是讓重跑時把 4 個 Phase 1.1 欄位更新到位（其他欄位保留原 row 的）
INSERT INTO leave_types (
  code, name_zh, is_paid, pay_rate, affects_attendance_bonus, affects_attendance_rate,
  has_balance, legal_max_days_per_year, legal_reference,
  advance_hours, advance_rule, requires_proof, proof_grace_days, proof_expiry_action
) VALUES
  ('annual',    '特休',    true,  1.00, false, false, true,  NULL, '勞基法 §38',          72,  'hard', false, 0, 'convert'),
  ('sick',      '病假',    true,  0.50, true,  true,  false, 30,   '勞工請假規則 §4',     0,   'soft', true,  5, 'convert'),
  ('personal',  '事假',    false, 0.00, true,  true,  false, 14,   '勞工請假規則 §7',     24,  'hard', false, 0, 'convert'),
  ('maternity', '產假',    true,  1.00, false, false, false, NULL, '勞基法 §50',          336, 'hard', true,  0, 'mark_expired'),
  ('funeral',   '喪假',    true,  1.00, false, false, false, 8,    '勞工請假規則 §3',     0,   'soft', true,  5, 'mark_expired'),
  ('marriage',  '婚假',    true,  1.00, false, false, false, 8,    '勞工請假規則 §2',     168, 'hard', true,  0, 'mark_expired'),
  ('comp',      '補休',    true,  1.00, false, false, true,  NULL, '勞基法 §32-1',        72,  'hard', false, 0, 'convert'),
  ('public',    '公假',    true,  1.00, false, false, false, NULL, '勞工請假規則 §8',     120, 'hard', true,  0, 'mark_expired')
ON CONFLICT (code) DO UPDATE SET
  advance_hours       = EXCLUDED.advance_hours,
  advance_rule        = EXCLUDED.advance_rule,
  requires_proof      = EXCLUDED.requires_proof,
  proof_grace_days    = EXCLUDED.proof_grace_days,
  proof_expiry_action = EXCLUDED.proof_expiry_action;

-- 2026-05-05 Phase 1.1: 新增 5 種假別（產檢 / 陪產 / 流產 / 安胎 / 育嬰）
-- 來源：migrations/2026_05_05_leave_phase1_schema.sql C 段
INSERT INTO leave_types (
  code, name_zh, is_paid, pay_rate, has_balance,
  legal_max_days_per_year, is_active, display_order,
  advance_hours, advance_rule, requires_proof, proof_grace_days, proof_expiry_action
) VALUES
  ('paternity_prenatal', '產檢假',       true,  1.00, false, 7,    true, 81, 24,  'hard', false, 0, 'convert'),
  ('paternity',          '陪產假',       true,  1.00, false, 7,    true, 82, 0,   'soft', true,  5, 'mark_expired'),
  ('miscarriage',        '流產假',       true,  1.00, false, NULL, true, 83, 0,   'soft', true,  5, 'mark_expired'),
  ('pregnancy_rest',     '安胎假',       true,  0.50, false, NULL, true, 84, 0,   'soft', true,  5, 'mark_expired'),
  ('parental',           '育嬰留職停薪', false, 0.00, false, NULL, true, 85, 240, 'hard', true,  0, 'mark_expired')
ON CONFLICT (code) DO NOTHING;

-- 2026-05-05: prod 才有的 7 種假別（在 batch_a 之後手動於 prod 加入）
-- 注意：本 INSERT 只覆蓋 code / name_zh / display_order / 4 個 Phase 1.1 欄位、其他欄位
--   (is_paid / pay_rate / affects_* / has_balance / legal_max_days / legal_reference)
--   取 CREATE TABLE 預設值。fresh setup 跑這段後若需要校正、請對照 prod 匯出。
INSERT INTO leave_types (code, name_zh, display_order, advance_hours, advance_rule, requires_proof, proof_grace_days, proof_expiry_action) VALUES
  ('work_injury',      '公傷病假',           50, 0,  'soft', true,  0, 'mark_expired'),
  ('menstrual',        '生理假',             51, 0,  'soft', false, 0, 'convert'),
  ('family_care',      '家庭照顧假',         52, 0,  'soft', false, 0, 'convert'),
  ('typhoon',          '颱風假',             53, 0,  'soft', false, 0, 'convert'),
  ('voting',           '投票日',             54, 24, 'hard', false, 0, 'convert'),
  ('hospital_unpaid',  '住院傷病假(不支薪)', 55, 0,  'soft', true,  5, 'convert'),
  ('job_seeking',      '謀職假',             56, 24, 'hard', false, 0, 'convert')
ON CONFLICT (code) DO NOTHING;


-- ========== annual_leave_records ==========
CREATE TABLE annual_leave_records (
  id              BIGSERIAL PRIMARY KEY,
  employee_id     TEXT NOT NULL REFERENCES employees(id),
  period_start    DATE NOT NULL,
  period_end      DATE NOT NULL,
  seniority_years NUMERIC(4,2) NOT NULL,
  legal_days      NUMERIC(4,1) NOT NULL,
  granted_days    NUMERIC(4,1) NOT NULL,
  used_days       NUMERIC(4,1) NOT NULL DEFAULT 0,
  remaining_days  NUMERIC(4,1) GENERATED ALWAYS AS (granted_days - used_days) STORED,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN (
                    'active',
                    'expired',
                    'paid_out',
                    'rolled_over'
                  )),
  settlement_amount NUMERIC(10,2),
  settled_at      TIMESTAMPTZ,
  settled_by      TEXT REFERENCES employees(id),
  note            TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (employee_id, period_start)
);

CREATE INDEX idx_annual_leave_records_employee
  ON annual_leave_records(employee_id, status);
CREATE INDEX idx_annual_leave_records_active
  ON annual_leave_records(employee_id) WHERE status = 'active';


-- ========== comp_time_balance ==========
-- 注意：source_overtime_request_id 暫不加 FK，等 Batch C overtime_requests 建好後補
CREATE TABLE comp_time_balance (
  id              BIGSERIAL PRIMARY KEY,
  employee_id     TEXT NOT NULL REFERENCES employees(id),
  source_overtime_request_id BIGINT NOT NULL,
  earned_hours    NUMERIC(5,2) NOT NULL,
  earned_at       TIMESTAMPTZ NOT NULL,
  expires_at      DATE NOT NULL,
  used_hours      NUMERIC(5,2) NOT NULL DEFAULT 0,
  remaining_hours NUMERIC(5,2) GENERATED ALWAYS AS (earned_hours - used_hours) STORED,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN (
                    'active',
                    'fully_used',
                    'expired_paid',
                    'expired_void'
                  )),
  expiry_payout_amount NUMERIC(10,2),
  expiry_processed_at  TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_comp_time_balance_employee_active
  ON comp_time_balance(employee_id) WHERE status = 'active';
CREATE INDEX idx_comp_time_balance_expiring
  ON comp_time_balance(expires_at) WHERE status = 'active';


-- ========== leave_balance_logs ==========
-- 注意：leave_request_id 為 TEXT（leave_requests.id 是 TEXT PRIMARY KEY）
CREATE TABLE leave_balance_logs (
  id              BIGSERIAL PRIMARY KEY,
  employee_id     TEXT NOT NULL REFERENCES employees(id),
  balance_type    TEXT NOT NULL CHECK (balance_type IN ('annual', 'comp')),
  annual_record_id BIGINT REFERENCES annual_leave_records(id),
  comp_record_id   BIGINT REFERENCES comp_time_balance(id),
  leave_request_id TEXT REFERENCES leave_requests(id),
  change_type     TEXT NOT NULL CHECK (change_type IN (
                    'grant',
                    'use',
                    'cancel_use',
                    'manual_adjust',
                    'expire',
                    'settle'
                  )),
  hours_delta     NUMERIC(5,2) NOT NULL,
  changed_by      TEXT NOT NULL REFERENCES employees(id),
  changed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reason          TEXT
);

CREATE INDEX idx_leave_balance_logs_employee
  ON leave_balance_logs(employee_id, changed_at);


-- ========== overtime_requests ==========
-- 注意：schedule_id / attendance_id / applied_to_salary_record_id 皆為 TEXT
-- （schedules.id / attendance.id / salary_records.id 都是 TEXT PRIMARY KEY）
CREATE TABLE overtime_requests (
  id              BIGSERIAL PRIMARY KEY,
  employee_id     TEXT NOT NULL REFERENCES employees(id),

  overtime_date   DATE NOT NULL,
  start_at        TIMESTAMPTZ NOT NULL,
  end_at          TIMESTAMPTZ NOT NULL,
  hours           NUMERIC(5,2) NOT NULL,

  schedule_id     TEXT REFERENCES schedules(id),
  attendance_id   TEXT REFERENCES attendance(id),

  request_kind    TEXT NOT NULL CHECK (request_kind IN (
                    'pre_approval',
                    'post_approval'
                  )),

  is_over_limit   BOOLEAN NOT NULL DEFAULT false,
  over_limit_dimensions TEXT[],

  compensation_type TEXT CHECK (compensation_type IN (
                    'comp_leave',
                    'overtime_pay',
                    'undecided'
                  )),

  estimated_pay   NUMERIC(10,2),
  pay_multiplier  NUMERIC(4,2),

  reason          TEXT NOT NULL,

  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
                    'pending',
                    'pending_ceo',
                    'approved',
                    'rejected',
                    'cancelled'
                  )),

  manager_id          TEXT REFERENCES employees(id),
  manager_reviewed_at TIMESTAMPTZ,
  manager_decision    TEXT CHECK (manager_decision IN ('approved', 'rejected')),
  manager_note        TEXT,

  ceo_id              TEXT REFERENCES employees(id),
  ceo_reviewed_at     TIMESTAMPTZ,
  ceo_decision        TEXT CHECK (ceo_decision IN ('approved', 'rejected')),
  ceo_note            TEXT,

  reject_reason       TEXT,

  comp_balance_id     BIGINT REFERENCES comp_time_balance(id),
  applied_to_salary_record_id TEXT,

  applies_to_year     INT NOT NULL,
  applies_to_month    INT NOT NULL CHECK (applies_to_month BETWEEN 1 AND 12),

  submitted_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_overtime_requests_employee_month
  ON overtime_requests(employee_id, applies_to_year, applies_to_month);
CREATE INDEX idx_overtime_requests_status
  ON overtime_requests(status) WHERE status IN ('pending', 'pending_ceo');
CREATE INDEX idx_overtime_requests_pending_ceo
  ON overtime_requests(submitted_at) WHERE status = 'pending_ceo';


-- ========== overtime_limits ==========
CREATE TABLE overtime_limits (
  id              BIGSERIAL PRIMARY KEY,

  scope           TEXT NOT NULL CHECK (scope IN ('company', 'employee')),
  employee_id     TEXT REFERENCES employees(id),

  daily_limit_hours    NUMERIC(5,2),
  weekly_limit_hours   NUMERIC(5,2),
  monthly_limit_hours  NUMERIC(5,2),
  yearly_limit_hours   NUMERIC(6,2),

  monthly_hard_cap_hours NUMERIC(5,2),

  effective_from  DATE NOT NULL DEFAULT CURRENT_DATE,
  effective_to    DATE,

  note            TEXT,

  created_by      TEXT REFERENCES employees(id),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),

  CONSTRAINT chk_employee_scope CHECK (
    (scope = 'company' AND employee_id IS NULL) OR
    (scope = 'employee' AND employee_id IS NOT NULL)
  )
);

CREATE INDEX idx_overtime_limits_company_active
  ON overtime_limits(effective_from, effective_to)
  WHERE scope = 'company';
CREATE INDEX idx_overtime_limits_employee
  ON overtime_limits(employee_id, effective_from)
  WHERE scope = 'employee';

INSERT INTO overtime_limits
  (scope, daily_limit_hours, weekly_limit_hours, monthly_limit_hours, monthly_hard_cap_hours, yearly_limit_hours, note)
VALUES
  ('company', 4, 12, 46, 54, NULL, '勞基法預設：日 4 小時、月 46 小時、經工會同意可至 54 小時');


-- ========== overtime_request_logs ==========
CREATE TABLE overtime_request_logs (
  id              BIGSERIAL PRIMARY KEY,
  request_id      BIGINT NOT NULL REFERENCES overtime_requests(id) ON DELETE CASCADE,

  event_type      TEXT NOT NULL CHECK (event_type IN (
                    'submitted',
                    'manager_approved',
                    'manager_rejected',
                    'ceo_approved',
                    'ceo_rejected',
                    'cancelled',
                    'compensation_changed'
                  )),

  actor_id        TEXT NOT NULL REFERENCES employees(id),
  actor_role      TEXT,

  before_data     JSONB,
  after_data      JSONB,
  note            TEXT,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_overtime_request_logs_request
  ON overtime_request_logs(request_id, created_at);


-- ========== attendance_penalties ==========
CREATE TABLE attendance_penalties (
  id              BIGSERIAL PRIMARY KEY,

  trigger_type    TEXT NOT NULL CHECK (trigger_type IN (
                    'late',
                    'early_leave',
                    'absent',
                    'other'
                  )),
  trigger_label   TEXT NOT NULL,

  threshold_minutes_min INT NOT NULL DEFAULT 0,
  threshold_minutes_max INT,

  monthly_count_threshold INT,

  penalty_type    TEXT NOT NULL CHECK (penalty_type IN (
                    'deduct_money',
                    'deduct_money_per_min',
                    'deduct_attendance_bonus',
                    'deduct_attendance_bonus_pct',
                    'warning',
                    'custom'
                  )),

  penalty_amount  NUMERIC(10,2),
  penalty_cap     NUMERIC(10,2),

  custom_action_note TEXT,

  is_active       BOOLEAN NOT NULL DEFAULT true,
  display_order   INT NOT NULL DEFAULT 0,

  effective_from  DATE NOT NULL DEFAULT CURRENT_DATE,
  effective_to    DATE,

  description     TEXT,

  created_by      TEXT REFERENCES employees(id),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_attendance_penalties_active
  ON attendance_penalties(trigger_type, threshold_minutes_min)
  WHERE is_active = true;

INSERT INTO attendance_penalties
  (trigger_type, trigger_label, threshold_minutes_min, threshold_minutes_max, penalty_type, penalty_amount, description)
VALUES
  ('late', '遲到', 1, NULL, 'deduct_money_per_min', 0, '預設不扣，HR 後台自行設定金額'),
  ('early_leave', '早退', 1, NULL, 'deduct_money_per_min', 0, '預設不扣，HR 後台自行設定金額'),
  ('absent', '曠職一日', 0, NULL, 'deduct_attendance_bonus', 0, '預設不扣，HR 後台自行設定');


-- ========== attendance_penalty_records ==========
-- 注意：attendance_id / salary_record_id 為 TEXT
-- salary_record_id 暫不加 FK，等 Batch C salary_records 改完後補
CREATE TABLE attendance_penalty_records (
  id              BIGSERIAL PRIMARY KEY,
  employee_id     TEXT NOT NULL REFERENCES employees(id),
  attendance_id   TEXT REFERENCES attendance(id),

  penalty_rule_id BIGINT REFERENCES attendance_penalties(id),

  trigger_type    TEXT NOT NULL,
  trigger_minutes INT,

  penalty_type    TEXT NOT NULL,
  penalty_amount  NUMERIC(10,2) NOT NULL,

  applies_to_year  INT NOT NULL,
  applies_to_month INT NOT NULL CHECK (applies_to_month BETWEEN 1 AND 12),

  salary_record_id TEXT,

  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
                    'pending',
                    'applied',
                    'waived'
                  )),
  waived_by       TEXT REFERENCES employees(id),
  waived_at       TIMESTAMPTZ,
  waive_reason    TEXT,

  manual_action_taken TEXT,

  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_penalty_records_employee_month
  ON attendance_penalty_records(employee_id, applies_to_year, applies_to_month);
CREATE INDEX idx_penalty_records_pending
  ON attendance_penalty_records(applies_to_year, applies_to_month)
  WHERE status = 'pending';


-- ========== system_overtime_settings ==========
CREATE TABLE system_overtime_settings (
  id              SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),

  comp_expiry_action TEXT NOT NULL DEFAULT 'auto_payout' CHECK (
    comp_expiry_action IN ('auto_payout', 'manual_review', 'void')
  ),

  comp_expiry_warning_days INT NOT NULL DEFAULT 30,

  weekday_overtime_first_2h_rate  NUMERIC(4,2) NOT NULL DEFAULT 1.34,
  weekday_overtime_after_2h_rate  NUMERIC(4,2) NOT NULL DEFAULT 1.67,
  rest_day_overtime_first_2h_rate NUMERIC(4,2) NOT NULL DEFAULT 1.34,
  rest_day_overtime_after_2h_rate NUMERIC(4,2) NOT NULL DEFAULT 1.67,

  monthly_work_hours_base INT NOT NULL DEFAULT 240,

  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_by      TEXT REFERENCES employees(id)
);

INSERT INTO system_overtime_settings (id) VALUES (1)
  ON CONFLICT DO NOTHING;


-- ========== schedule_change_logs ==========
-- 注意：schedule_id 為 TEXT（schedules.id 是 TEXT PRIMARY KEY）
CREATE TABLE schedule_change_logs (
  id              BIGSERIAL PRIMARY KEY,
  schedule_id     TEXT REFERENCES schedules(id) ON DELETE SET NULL,
  employee_id     TEXT NOT NULL REFERENCES employees(id),
  change_type     TEXT NOT NULL CHECK (change_type IN (
                    'employee_draft',
                    'employee_submit',
                    'manager_adjust',
                    'manager_approve',
                    'system_lock',
                    'late_change'
                  )),
  changed_by      TEXT NOT NULL REFERENCES employees(id),
  changed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  before_data     JSONB,
  after_data      JSONB,
  reason          TEXT,
  notification_sent BOOLEAN NOT NULL DEFAULT false,
  notified_at     TIMESTAMPTZ
);

CREATE INDEX idx_schedule_change_logs_employee
  ON schedule_change_logs(employee_id, changed_at);
CREATE INDEX idx_schedule_change_logs_late_change
  ON schedule_change_logs(change_type, notification_sent)
  WHERE change_type = 'late_change';


-- ========== attendance_monthly_summary VIEW ==========
-- 注意：用 a.work_date（既有 attendance 欄位名）；anomaly_days 改用 is_anomaly 旗標
CREATE OR REPLACE VIEW attendance_monthly_summary AS
SELECT
  e.id AS employee_id,
  e.name,
  EXTRACT(YEAR FROM a.work_date)::INT AS year,
  EXTRACT(MONTH FROM a.work_date)::INT AS month,

  COUNT(DISTINCT a.work_date) FILTER (WHERE a.status = 'normal') AS normal_days,
  COUNT(DISTINCT a.work_date) FILTER (WHERE a.status = 'late') AS late_days,
  COUNT(DISTINCT a.work_date) FILTER (WHERE a.status = 'early_leave') AS early_leave_days,
  COUNT(DISTINCT a.work_date) FILTER (WHERE a.status = 'absent') AS absent_days,
  COUNT(DISTINCT a.work_date) FILTER (WHERE a.is_anomaly = true) AS anomaly_days,

  COALESCE(SUM(a.work_hours), 0) AS total_work_hours,
  COALESCE(SUM(a.overtime_hours), 0) AS total_overtime_hours,
  COALESCE(SUM(a.late_minutes), 0) AS total_late_minutes,
  COALESCE(SUM(a.early_leave_minutes), 0) AS total_early_leave_minutes

FROM employees e
LEFT JOIN attendance a ON a.employee_id = e.id
GROUP BY e.id, e.name, EXTRACT(YEAR FROM a.work_date), EXTRACT(MONTH FROM a.work_date);
