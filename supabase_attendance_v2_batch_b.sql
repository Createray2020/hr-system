-- =====================================================
-- supabase_attendance_v2_batch_b.sql
-- 出勤核心系統 v2.0 - Batch B：既有表新增欄位 + backfill（中風險）
-- 對應設計文件：docs/attendance-system-design-v1.md §4.1.2/§4.1.3/§4.2.1/§4.2.2/§4.2.4/§4.3.2 + §8.2
-- 執行時機：在 Batch A 之後，Batch C 之前
-- 順序：先所有 ALTER → 所有 backfill UPDATE → 最後加 NOT NULL
-- 回滾方式：ALTER TABLE DROP COLUMN（見 README）
-- =====================================================


-- ========== 段 1：所有 ALTER TABLE ADD COLUMN（先 NULLABLE 或有 DEFAULT） ==========

-- ---------- shift_types ----------
ALTER TABLE shift_types ADD COLUMN IF NOT EXISTS
  break_minutes INT NOT NULL DEFAULT 60;

ALTER TABLE shift_types ADD COLUMN IF NOT EXISTS
  is_active BOOLEAN NOT NULL DEFAULT true;


-- ---------- employees ----------
ALTER TABLE employees ADD COLUMN IF NOT EXISTS
  annual_leave_seniority_start DATE;


-- ---------- schedule_periods ----------
ALTER TABLE schedule_periods ADD COLUMN IF NOT EXISTS
  period_year INT NOT NULL;
ALTER TABLE schedule_periods ADD COLUMN IF NOT EXISTS
  period_month INT NOT NULL CHECK (period_month BETWEEN 1 AND 12);

ALTER TABLE schedule_periods ADD COLUMN IF NOT EXISTS
  submitted_at TIMESTAMPTZ;
ALTER TABLE schedule_periods ADD COLUMN IF NOT EXISTS
  approved_at TIMESTAMPTZ;
ALTER TABLE schedule_periods ADD COLUMN IF NOT EXISTS
  locked_at TIMESTAMPTZ;

ALTER TABLE schedule_periods ADD CONSTRAINT
  uq_schedule_periods_employee_month
  UNIQUE (employee_id, period_year, period_month);


-- ---------- schedules ----------
ALTER TABLE schedules ADD COLUMN IF NOT EXISTS
  period_id BIGINT REFERENCES schedule_periods(id);

ALTER TABLE schedules ADD COLUMN IF NOT EXISTS
  start_time TIME;
ALTER TABLE schedules ADD COLUMN IF NOT EXISTS
  end_time TIME;
ALTER TABLE schedules ADD COLUMN IF NOT EXISTS
  crosses_midnight BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE schedules ADD COLUMN IF NOT EXISTS
  scheduled_work_minutes INT;
ALTER TABLE schedules ADD COLUMN IF NOT EXISTS
  segment_no INT NOT NULL DEFAULT 1;

ALTER TABLE schedules DROP CONSTRAINT IF EXISTS uq_schedules_employee_date;
ALTER TABLE schedules ADD CONSTRAINT uq_schedules_employee_date_segment
  UNIQUE (employee_id, date, segment_no);


-- ---------- attendance ----------
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS
  schedule_id BIGINT REFERENCES schedules(id);

ALTER TABLE attendance ADD COLUMN IF NOT EXISTS
  segment_no INT NOT NULL DEFAULT 1;

ALTER TABLE attendance ADD COLUMN IF NOT EXISTS
  late_minutes INT NOT NULL DEFAULT 0;
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS
  early_leave_minutes INT NOT NULL DEFAULT 0;
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS
  is_holiday_work BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS
  holiday_id BIGINT REFERENCES holidays(id);

ALTER TABLE attendance ADD COLUMN IF NOT EXISTS
  is_anomaly BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS
  anomaly_note TEXT;

ALTER TABLE attendance DROP CONSTRAINT IF EXISTS attendance_status_check;
ALTER TABLE attendance ADD CONSTRAINT attendance_status_check
  CHECK (status IN ('normal','late','early_leave','absent','leave','holiday'));


-- ---------- leave_requests ----------
ALTER TABLE leave_requests ADD CONSTRAINT
  fk_leave_requests_type FOREIGN KEY (leave_type)
  REFERENCES leave_types(code);

ALTER TABLE leave_requests DROP CONSTRAINT IF EXISTS leave_requests_status_check;
ALTER TABLE leave_requests ADD CONSTRAINT leave_requests_status_check
  CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled'));

ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS
  reviewed_by TEXT REFERENCES employees(id);
ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS
  reviewed_at TIMESTAMPTZ;
ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS
  reject_reason TEXT;

ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS
  hours NUMERIC(5,2);
ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS
  finalized_hours NUMERIC(5,2);

ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS
  start_at TIMESTAMPTZ;
ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS
  end_at TIMESTAMPTZ;

ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS
  source_overtime_request_id BIGINT;


-- ========== 段 2：所有 backfill UPDATE ==========

-- employees.annual_leave_seniority_start = hire_date
UPDATE employees SET annual_leave_seniority_start = hire_date
WHERE annual_leave_seniority_start IS NULL;

-- schedules.period_id：依 employee_id + date 找對應的 schedule_periods
-- 步驟 1：先建立缺失的 schedule_periods（如果有 schedules 沒對應的週期）
INSERT INTO schedule_periods (employee_id, period_year, period_month, period_start, period_end, status)
SELECT DISTINCT
  s.employee_id,
  EXTRACT(YEAR FROM s.date)::INT,
  EXTRACT(MONTH FROM s.date)::INT,
  DATE_TRUNC('month', s.date)::DATE,
  (DATE_TRUNC('month', s.date) + INTERVAL '1 month' - INTERVAL '1 day')::DATE,
  'locked'
FROM schedules s
WHERE NOT EXISTS (
  SELECT 1 FROM schedule_periods p
  WHERE p.employee_id = s.employee_id
    AND p.period_year = EXTRACT(YEAR FROM s.date)::INT
    AND p.period_month = EXTRACT(MONTH FROM s.date)::INT
)
ON CONFLICT (employee_id, period_year, period_month) DO NOTHING;

-- 步驟 2：backfill schedules.period_id
UPDATE schedules s
SET period_id = p.id
FROM schedule_periods p
WHERE p.employee_id = s.employee_id
  AND p.period_year = EXTRACT(YEAR FROM s.date)::INT
  AND p.period_month = EXTRACT(MONTH FROM s.date)::INT
  AND s.period_id IS NULL;

-- schedules.segment_no = 1（既有資料都是單段）
UPDATE schedules SET segment_no = 1 WHERE segment_no IS NULL;

-- schedules.scheduled_work_minutes：依 shift_type 計算
UPDATE schedules s
SET scheduled_work_minutes = (
  EXTRACT(EPOCH FROM (st.end_time - st.start_time)) / 60 - st.break_minutes
)::INT
FROM shift_types st
WHERE s.shift_type_id = st.id
  AND s.scheduled_work_minutes IS NULL
  AND st.start_time IS NOT NULL
  AND st.end_time IS NOT NULL;


-- ========== 段 3：backfill 完成後加 NOT NULL 約束 ==========

ALTER TABLE employees ALTER COLUMN annual_leave_seniority_start SET NOT NULL;
