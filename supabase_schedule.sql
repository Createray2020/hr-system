-- ══════════════════════════════════════════════
--  排班管理系統 — 在 Supabase SQL Editor 執行
-- ══════════════════════════════════════════════

-- 班別設定表
-- 2026-05-05: 加 break_start / break_end TIME 欄位（fixed break window）、
-- ST001 backfill 13:00-14:00、ST003/ST004 break_minutes 清為 0
-- 詳見 migrations/2026_05_05_shift_types_break_window.sql
CREATE TABLE IF NOT EXISTS shift_types (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  start_time  TEXT,
  end_time    TEXT,
  is_flexible BOOLEAN DEFAULT FALSE,
  is_off      BOOLEAN DEFAULT FALSE,
  color       TEXT DEFAULT '#5B8DEF',
  break_start TIME,    -- 2026-05-05 加：固定午休開始（NULL=用 break_minutes 攤算）
  break_end   TIME,    -- 2026-05-05 加：固定午休結束
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
-- 注意：break_minutes / is_active 由 supabase_attendance_v2_batch_b.sql ALTER 加上
ALTER TABLE shift_types ENABLE ROW LEVEL SECURITY;
CREATE POLICY "allow_all" ON shift_types FOR ALL USING (true) WITH CHECK (true);

INSERT INTO shift_types (id, name, start_time, end_time, is_flexible, is_off, color, break_start, break_end) VALUES
('ST001', '早班',   '09:00', '18:00', false, false, '#5B8DEF', '13:00', '14:00'),
('ST002', '晚班',   NULL,    NULL,    true,  false, '#C084FC', NULL,    NULL),
('ST003', '休假日', NULL,    NULL,    false, true,  '#4ADE80', NULL,    NULL),
('ST004', '例假日', NULL,    NULL,    false, true,  '#7A85A0', NULL,    NULL)
ON CONFLICT (id) DO NOTHING;

-- 2026-05-05: is_off=true 的 shift 不應有 break (batch_b 預設 break_minutes=60、覆蓋為 0)
UPDATE shift_types SET break_minutes = 0 WHERE id IN ('ST003', 'ST004');

-- 班表（每筆代表一個員工某天的班別）
CREATE TABLE IF NOT EXISTS schedules (
  id            TEXT PRIMARY KEY,
  employee_id   TEXT NOT NULL REFERENCES employees(id),
  work_date     DATE NOT NULL,
  shift_type_id TEXT NOT NULL REFERENCES shift_types(id),
  start_time    TEXT,
  end_time      TEXT,
  dept          TEXT,
  note          TEXT DEFAULT '',
  status        TEXT DEFAULT 'draft' CHECK (status IN ('draft','confirmed','locked')),
  created_by    TEXT,
  updated_by    TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(employee_id, work_date)
);
ALTER TABLE schedules ENABLE ROW LEVEL SECURITY;
CREATE POLICY "allow_all" ON schedules FOR ALL USING (true) WITH CHECK (true);

-- 換班申請
CREATE TABLE IF NOT EXISTS shift_swap_requests (
  id              TEXT PRIMARY KEY,
  requester_id    TEXT NOT NULL REFERENCES employees(id),
  target_id       TEXT REFERENCES employees(id),
  requester_date  DATE NOT NULL,
  target_date     DATE,
  reason          TEXT,
  status          TEXT DEFAULT 'pending' CHECK (status IN ('pending','target_approved','approved','rejected')),
  target_note     TEXT DEFAULT '',
  manager_note    TEXT DEFAULT '',
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  handled_at      TIMESTAMPTZ
);
ALTER TABLE shift_swap_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY "allow_all" ON shift_swap_requests FOR ALL USING (true) WITH CHECK (true);

-- 四週排班週期
CREATE TABLE IF NOT EXISTS schedule_periods (
  id          TEXT PRIMARY KEY,
  start_date  DATE NOT NULL,
  end_date    DATE NOT NULL,
  dept        TEXT,
  status      TEXT DEFAULT 'draft' CHECK (status IN ('draft','submitted','approved','locked')),
  created_by  TEXT,
  approved_by TEXT,
  -- 2026-05-07 Phase 2.x.3: 加 published_by / published_at audit 欄位
  -- 詳見 migrations/2026_05_07_schedule_periods_audit.sql
  published_by TEXT REFERENCES employees(id),
  published_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE schedule_periods ENABLE ROW LEVEL SECURITY;
CREATE POLICY "allow_all" ON schedule_periods FOR ALL USING (true) WITH CHECK (true);
