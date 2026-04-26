-- =====================================================
-- supabase_attendance_v2_batch_b.sql
-- 出勤核心系統 v2.0 - Batch B：既有表新增欄位 + backfill（中風險）
-- 對應設計文件：docs/attendance-system-design-v1.md §4.1.2/§4.1.3/§4.2.1/§4.2.2/§4.2.4/§4.3.2 + §8.2 (commit 8721a2f)
-- 執行時機：在 Batch A 之後，Batch C 之前
-- 順序：
--   段 1：所有 ALTER（ADD COLUMN / ALTER TYPE / DROP+ADD CHECK / DROP+ADD UNIQUE）
--   段 2：所有 backfill UPDATE / INSERT
--   段 3：backfill 完成後加 NOT NULL
-- 回滾方式：ALTER TABLE DROP COLUMN（見 README）
-- =====================================================


-- ========== 段 1：所有 ALTER ==========

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
  employee_id TEXT REFERENCES employees(id);

ALTER TABLE schedule_periods ADD COLUMN IF NOT EXISTS
  period_year INT;
ALTER TABLE schedule_periods ADD COLUMN IF NOT EXISTS
  period_month INT CHECK (period_month BETWEEN 1 AND 12);

ALTER TABLE schedule_periods ADD COLUMN IF NOT EXISTS
  period_start DATE;
ALTER TABLE schedule_periods ADD COLUMN IF NOT EXISTS
  period_end DATE;

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
-- 注意：period_id 為 TEXT（schedule_periods.id 是 TEXT PRIMARY KEY）
ALTER TABLE schedules ADD COLUMN IF NOT EXISTS
  period_id TEXT REFERENCES schedule_periods(id);

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

-- 既有欄位型別升級：start_time/end_time 從 TEXT 改為 TIME
-- 因為 IF NOT EXISTS 對既有 TEXT 欄位 skip，要明確 ALTER TYPE
ALTER TABLE schedules ALTER COLUMN start_time TYPE TIME USING NULLIF(start_time, '')::TIME;
ALTER TABLE schedules ALTER COLUMN end_time   TYPE TIME USING NULLIF(end_time,   '')::TIME;
ALTER TABLE shift_types ALTER COLUMN start_time TYPE TIME USING NULLIF(start_time, '')::TIME;
ALTER TABLE shift_types ALTER COLUMN end_time   TYPE TIME USING NULLIF(end_time,   '')::TIME;

ALTER TABLE schedules DROP CONSTRAINT IF EXISTS uq_schedules_employee_date;
ALTER TABLE schedules ADD CONSTRAINT uq_schedules_employee_date_segment
  UNIQUE (employee_id, work_date, segment_no);


-- ---------- attendance ----------
-- 注意：schedule_id 為 TEXT（schedules.id 是 TEXT PRIMARY KEY）
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS
  schedule_id TEXT REFERENCES schedules(id);

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
-- 加 FK 前先確認 prod 沒有不在 leave_types.code 的舊值
-- 若有，要先 backfill（將舊值映射到合法 code、或先 INSERT 對應 leave_types row）
-- prod 當前 leave_requests 為空，無此疑慮；若未來有資料先做下列 sanity check：
-- SELECT DISTINCT leave_type FROM leave_requests
-- WHERE leave_type NOT IN (SELECT code FROM leave_types);

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


-- ========== 段 2：所有 backfill UPDATE / INSERT ==========

-- employees.annual_leave_seniority_start = hire_date
UPDATE employees SET annual_leave_seniority_start = hire_date
WHERE annual_leave_seniority_start IS NULL;

-- schedule_periods 既有 row（dept-based legacy）：
-- 從 start_date / end_date 推 period_year / period_month / period_start / period_end
-- 既有 dept 欄位保留為 legacy 不再使用。
-- 若該表非空且需要 employee_id，Batch 10 上 prod 前 HR 必須先決定 legacy row 處理方式。
UPDATE schedule_periods
SET
  period_year   = EXTRACT(YEAR FROM start_date)::INT,
  period_month  = EXTRACT(MONTH FROM start_date)::INT,
  period_start  = start_date,
  period_end    = end_date
WHERE period_year IS NULL AND start_date IS NOT NULL;

-- schedules.period_id：依 employee_id + work_date 找對應的 schedule_periods
-- 步驟 1：先建立缺失的 schedule_periods（如果有 schedules 沒對應的週期）
-- 注意：prod schedule_periods.id 是 TEXT NOT NULL PRIMARY KEY 沒 default，要明確產 id
INSERT INTO schedule_periods (id, employee_id, period_year, period_month, period_start, period_end, status)
SELECT DISTINCT
  's_period_' || s.employee_id || '_' || EXTRACT(YEAR FROM s.work_date) || '_' || LPAD(EXTRACT(MONTH FROM s.work_date)::TEXT, 2, '0'),
  s.employee_id,
  EXTRACT(YEAR FROM s.work_date)::INT,
  EXTRACT(MONTH FROM s.work_date)::INT,
  DATE_TRUNC('month', s.work_date)::DATE,
  (DATE_TRUNC('month', s.work_date) + INTERVAL '1 month' - INTERVAL '1 day')::DATE,
  'locked'
FROM schedules s
WHERE NOT EXISTS (
  SELECT 1 FROM schedule_periods p
  WHERE p.employee_id = s.employee_id
    AND p.period_year = EXTRACT(YEAR FROM s.work_date)::INT
    AND p.period_month = EXTRACT(MONTH FROM s.work_date)::INT
)
ON CONFLICT (employee_id, period_year, period_month) DO NOTHING;

-- 步驟 2：backfill schedules.period_id
UPDATE schedules s
SET period_id = p.id
FROM schedule_periods p
WHERE p.employee_id = s.employee_id
  AND p.period_year = EXTRACT(YEAR FROM s.work_date)::INT
  AND p.period_month = EXTRACT(MONTH FROM s.work_date)::INT
  AND s.period_id IS NULL;

-- schedules.segment_no = 1（既有資料都是單段）
UPDATE schedules SET segment_no = 1 WHERE segment_no IS NULL;

-- schedules.scheduled_work_minutes：依 shift_type 計算
-- 既有 shift_types.start_time/end_time 在段 1 已 ALTER 為 TIME，此時可正常做時間相減
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

-- schedule_periods 5 個 NULLABLE-pattern 欄位
-- 注意：legacy dept-based row 沒 employee_id；若 prod 此表非空，本步驟會 fail
-- prod 當前 schedule_periods 為空，可直接執行
ALTER TABLE schedule_periods ALTER COLUMN employee_id  SET NOT NULL;
ALTER TABLE schedule_periods ALTER COLUMN period_year  SET NOT NULL;
ALTER TABLE schedule_periods ALTER COLUMN period_month SET NOT NULL;
ALTER TABLE schedule_periods ALTER COLUMN period_start SET NOT NULL;
ALTER TABLE schedule_periods ALTER COLUMN period_end   SET NOT NULL;
