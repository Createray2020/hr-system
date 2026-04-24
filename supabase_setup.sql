-- ============================================================
--  HR System v2 — Supabase 完整建表 SQL
--  在 Supabase > SQL Editor 貼上執行
-- ============================================================

-- ── 1. 部門 ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS departments (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  manager_id  TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ── 2. 員工 ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS employees (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT UNIQUE,
  phone         TEXT,
  dept_id       TEXT REFERENCES departments(id),
  dept          TEXT NOT NULL,
  position      TEXT NOT NULL,
  role          TEXT DEFAULT 'employee' CHECK (role IN ('employee','hr','ceo','chairman','admin')),
  is_manager    BOOLEAN NOT NULL DEFAULT false,
  manager_id    TEXT,
  avatar        TEXT,
  hire_date     DATE,
  birth_date    DATE,
  id_number     TEXT,
  address       TEXT,
  bank_account  TEXT,
  base_salary   NUMERIC(12,2) DEFAULT 0,
  status        TEXT DEFAULT 'active' CHECK (status IN ('active','inactive','resigned')),
  auth_user_id  UUID REFERENCES auth.users(id),
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ── 3. 請假申請 ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS leave_requests (
  id            TEXT PRIMARY KEY,
  employee_id   TEXT NOT NULL REFERENCES employees(id),
  leave_type    TEXT NOT NULL,
  start_date    DATE NOT NULL,
  end_date      DATE NOT NULL,
  days          INTEGER NOT NULL,
  reason        TEXT,
  status        TEXT DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  applied_at    TIMESTAMPTZ DEFAULT NOW(),
  handler_note  TEXT DEFAULT '',
  handled_at    TIMESTAMPTZ,
  handled_by    TEXT REFERENCES employees(id)
);

-- ── 4. 出勤紀錄 ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS attendance (
  id             TEXT PRIMARY KEY,
  employee_id    TEXT NOT NULL REFERENCES employees(id),
  work_date      DATE NOT NULL,
  clock_in       TIMESTAMPTZ,
  clock_out      TIMESTAMPTZ,
  work_hours     NUMERIC(4,2),
  overtime_hours NUMERIC(4,2) DEFAULT 0,
  status         TEXT DEFAULT 'normal'
                 CHECK (status IN ('normal','late','early_leave','absent','leave','holiday')),
  note           TEXT DEFAULT '',
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(employee_id, work_date)
);

-- ── 5. 薪資資料 ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS salary_records (
  id               TEXT PRIMARY KEY,
  employee_id      TEXT NOT NULL REFERENCES employees(id),
  year             INTEGER NOT NULL,
  month            INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),
  base_salary      NUMERIC(12,2) DEFAULT 0,
  overtime_pay     NUMERIC(12,2) DEFAULT 0,
  bonus            NUMERIC(12,2) DEFAULT 0,
  allowance        NUMERIC(12,2) DEFAULT 0,
  deduct_absence   NUMERIC(12,2) DEFAULT 0,
  deduct_labor_ins NUMERIC(12,2) DEFAULT 0,
  deduct_health_ins NUMERIC(12,2) DEFAULT 0,
  deduct_tax       NUMERIC(12,2) DEFAULT 0,
  gross_salary     NUMERIC(12,2) GENERATED ALWAYS AS
                   (base_salary + overtime_pay + bonus + allowance) STORED,
  net_salary       NUMERIC(12,2) GENERATED ALWAYS AS
                   (base_salary + overtime_pay + bonus + allowance
                    - deduct_absence - deduct_labor_ins - deduct_health_ins - deduct_tax) STORED,
  status           TEXT DEFAULT 'draft' CHECK (status IN ('draft','confirmed','paid')),
  pay_date         DATE,
  note             TEXT DEFAULT '',
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(employee_id, year, month)
);

-- ── 6. 系統設定 ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS system_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── RLS 設定 ──────────────────────────────────────────────
ALTER TABLE departments     ENABLE ROW LEVEL SECURITY;
ALTER TABLE employees       ENABLE ROW LEVEL SECURITY;
ALTER TABLE leave_requests  ENABLE ROW LEVEL SECURITY;
ALTER TABLE attendance      ENABLE ROW LEVEL SECURITY;
ALTER TABLE salary_records  ENABLE ROW LEVEL SECURITY;
ALTER TABLE system_settings ENABLE ROW LEVEL SECURITY;

-- Demo: 允許 anon 全存取（上線後請依角色設定 RLS policy）
CREATE POLICY "allow_all" ON departments     FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "allow_all" ON employees       FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "allow_all" ON leave_requests  FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "allow_all" ON attendance      FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "allow_all" ON salary_records  FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "allow_all" ON system_settings FOR ALL USING (true) WITH CHECK (true);

-- ── 測試資料 ──────────────────────────────────────────────

INSERT INTO departments (id, name) VALUES
  ('D001','研發部'), ('D002','行銷部'), ('D003','財務部'), ('D004','業務部'), ('D005','人資部')
ON CONFLICT DO NOTHING;

INSERT INTO employees
  (id,name,email,phone,dept_id,dept,position,role,is_manager,manager_id,avatar,hire_date,base_salary,status)
VALUES
  ('M001','李部長','li@hr.com','0912-001001','D001','研發部','部門主管','employee',true, NULL,'李','2018-03-01',120000,'active'),
  ('M002','吳副理','wu@hr.com','0912-002002','D002','行銷部','部門副理','employee',true, NULL,'吳','2019-06-01',95000,'active'),
  ('M003','趙經理','chao@hr.com','0912-003003','D003','財務部','財務經理','employee',true, NULL,'趙','2017-09-01',105000,'active'),
  ('M004','黃總監','huang@hr.com','0912-004004','D004','業務部','業務總監','employee',true, NULL,'黃','2016-01-01',130000,'active'),
  ('E001','陳小明','chen@hr.com','0912-100001','D001','研發部','工程師','employee',false,'M001','陳','2021-07-01',65000,'active'),
  ('E002','林美華','lin@hr.com','0912-100002','D002','行銷部','行銷專員','employee',false,'M002','林','2022-02-01',55000,'active'),
  ('E003','張志遠','chang@hr.com','0912-100003','D001','研發部','資深工程師','employee',false,'M001','張','2020-04-01',80000,'active'),
  ('E004','王雅婷','wang@hr.com','0912-100004','D003','財務部','會計師','employee',false,'M003','王','2021-11-01',60000,'active'),
  ('E005','劉建國','liu@hr.com','0912-100005','D004','業務部','業務代表','employee',false,'M004','劉','2023-01-01',50000,'active')
ON CONFLICT DO NOTHING;

-- 請假資料
INSERT INTO leave_requests (id,employee_id,leave_type,start_date,end_date,days,reason,status,applied_at,handler_note,handled_at) VALUES
  ('L2024001','E001','annual','2024-04-20','2024-04-22',3,'家庭旅遊','pending','2024-04-15 09:30:00+00','',NULL),
  ('L2024002','E002','sick','2024-04-18','2024-04-18',1,'發燒就醫','pending','2024-04-18 08:00:00+00','',NULL),
  ('L2024003','E003','personal','2024-04-25','2024-04-26',2,'處理個人事務','approved','2024-04-10 14:20:00+00','同意','2024-04-11 10:00:00+00'),
  ('L2024004','E005','annual','2024-05-01','2024-05-03',3,'出遊休假','rejected','2024-04-12 11:00:00+00','業務衝刺期','2024-04-13 09:30:00+00'),
  ('L2024005','E004','sick','2024-04-19','2024-04-19',1,'頭痛就診','pending','2024-04-19 07:45:00+00','',NULL)
ON CONFLICT DO NOTHING;

-- 出勤資料（近 5 天）
INSERT INTO attendance (id,employee_id,work_date,clock_in,clock_out,work_hours,overtime_hours,status) VALUES
  ('A001','E001','2024-04-15','2024-04-15 08:55:00+00','2024-04-15 18:10:00+00',9.2,1.2,'normal'),
  ('A002','E001','2024-04-16','2024-04-16 09:30:00+00','2024-04-16 18:00:00+00',8.5,0.5,'late'),
  ('A003','E001','2024-04-17','2024-04-17 08:50:00+00','2024-04-17 17:00:00+00',8.2,0.0,'normal'),
  ('A004','E002','2024-04-15','2024-04-15 09:00:00+00','2024-04-15 18:00:00+00',9.0,1.0,'normal'),
  ('A005','E002','2024-04-16','2024-04-16 09:05:00+00','2024-04-16 17:30:00+00',8.4,0.0,'normal'),
  ('A006','E003','2024-04-15','2024-04-15 08:30:00+00','2024-04-15 20:00:00+00',11.5,3.5,'normal'),
  ('A007','E003','2024-04-16','2024-04-16 08:45:00+00','2024-04-16 19:30:00+00',10.75,2.75,'normal'),
  ('A008','E004','2024-04-15','2024-04-15 09:00:00+00','2024-04-15 18:00:00+00',9.0,1.0,'normal'),
  ('A009','E005','2024-04-15',NULL,NULL,0,0,'absent'),
  ('A010','E005','2024-04-16','2024-04-16 10:00:00+00','2024-04-16 18:00:00+00',8.0,0.0,'late')
ON CONFLICT DO NOTHING;

-- 薪資資料（2024年3月）
INSERT INTO salary_records
  (id,employee_id,year,month,base_salary,overtime_pay,bonus,allowance,deduct_absence,deduct_labor_ins,deduct_health_ins,deduct_tax,status,pay_date)
VALUES
  ('S001','E001',2024,3,65000,3600,0,2000,0,1026,826,3000,'paid','2024-04-05'),
  ('S002','E002',2024,3,55000,0,0,2000,0,869,699,1800,'paid','2024-04-05'),
  ('S003','E003',2024,3,80000,8250,5000,2000,0,1262,1016,6000,'paid','2024-04-05'),
  ('S004','E004',2024,3,60000,0,0,2000,0,947,762,2500,'paid','2024-04-05'),
  ('S005','E005',2024,3,50000,0,0,2000,2500,789,635,1000,'paid','2024-04-05'),
  ('S006','E001',2024,4,65000,1200,0,2000,0,1026,826,2800,'confirmed',NULL),
  ('S007','E002',2024,4,55000,0,0,2000,0,869,699,1800,'draft',NULL),
  ('S008','E003',2024,4,80000,5500,0,2000,0,1262,1016,5500,'draft',NULL)
ON CONFLICT DO NOTHING;
