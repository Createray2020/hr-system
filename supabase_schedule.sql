-- ══════════════════════════════════════════════
--  排班管理系統 — 在 Supabase SQL Editor 執行
-- ══════════════════════════════════════════════

-- 班別設定表
CREATE TABLE IF NOT EXISTS shift_types (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  start_time  TEXT,
  end_time    TEXT,
  is_flexible BOOLEAN DEFAULT FALSE,
  is_off      BOOLEAN DEFAULT FALSE,
  color       TEXT DEFAULT '#5B8DEF',
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE shift_types ENABLE ROW LEVEL SECURITY;
CREATE POLICY "allow_all" ON shift_types FOR ALL USING (true) WITH CHECK (true);

INSERT INTO shift_types (id, name, start_time, end_time, is_flexible, is_off, color) VALUES
('ST001', '早班',   '09:00', '18:00', false, false, '#5B8DEF'),
('ST002', '晚班',   NULL,    NULL,    true,  false, '#C084FC'),
('ST003', '休假日', NULL,    NULL,    false, true,  '#4ADE80'),
('ST004', '例假日', NULL,    NULL,    false, true,  '#7A85A0')
ON CONFLICT (id) DO NOTHING;

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
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE schedule_periods ENABLE ROW LEVEL SECURITY;
CREATE POLICY "allow_all" ON schedule_periods FOR ALL USING (true) WITH CHECK (true);
