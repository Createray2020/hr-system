-- ==========================================
-- Migration:2026_05_07_employee_change_logs.sql
-- Phase:1.7.2
-- 用途:新建 employee_change_logs audit 表(7 欄位白名單變更紀錄)
-- 類型:CREATE TABLE + 2 INDEX(無 row-level data migration)
-- ==========================================

-- ═══════════════════════════════════════════
-- ① VERIFY PRE — 跑前確認現況
-- 預期:
--   Q1.1 to_regclass → NULL(表不存在)
--   Q1.2 columns 0 row(欄位查不到、因表本身不存在)
--   Q1.3 indexes 0 row
-- ═══════════════════════════════════════════

-- Q1.1 表不存在
SELECT to_regclass('public.employee_change_logs');                    -- 預期:NULL

-- Q1.2 columns 0 row(double-check)
SELECT column_name FROM information_schema.columns
 WHERE table_schema='public' AND table_name='employee_change_logs';   -- 預期:0 row

-- Q1.3 index 0 row
SELECT indexname FROM pg_indexes
 WHERE schemaname='public' AND tablename='employee_change_logs';      -- 預期:0 row


-- ═══════════════════════════════════════════
-- ② ALTER — 真正的 migration(直接從原檔複製)
-- ═══════════════════════════════════════════

BEGIN;
CREATE TABLE IF NOT EXISTS employee_change_logs (
  id            BIGSERIAL PRIMARY KEY,
  employee_id   TEXT NOT NULL REFERENCES employees(id),
  changed_field TEXT NOT NULL CHECK (changed_field IN (
    'name', 'dept_id', 'role', 'is_manager',
    'base_salary', 'position', 'manager_id'
  )),
  before_value  TEXT,
  after_value   TEXT,
  changed_by    TEXT REFERENCES employees(id),
  changed_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_employee_change_logs_employee
  ON employee_change_logs(employee_id, changed_at DESC);

CREATE INDEX IF NOT EXISTS idx_employee_change_logs_time
  ON employee_change_logs(changed_at DESC);
COMMIT;

NOTIFY pgrst, 'reload schema';


-- ═══════════════════════════════════════════
-- ③ VERIFY POST — 跑後確認生效
-- 預期:
--   Q3.1 to_regclass → 'employee_change_logs'(表已建立)
--   Q3.2 columns 7 row(id, employee_id, changed_field, before_value, after_value, changed_by, changed_at)
--   Q3.3 CHECK constraint 含 7 個 changed_field 值
--   Q3.4 indexes 3 row(PK + 2 自定 index)
--   Q3.5 row count 0(無 backfill)
-- ═══════════════════════════════════════════

-- Q3.1 表已建立
SELECT to_regclass('public.employee_change_logs');                    -- 預期:public.employee_change_logs

-- Q3.2 columns + types
SELECT column_name, data_type, is_nullable, column_default
  FROM information_schema.columns
 WHERE table_schema='public' AND table_name='employee_change_logs'
 ORDER BY ordinal_position;
-- 預期 7 row:
--   id            bigint    NO   nextval('employee_change_logs_id_seq')
--   employee_id   text      NO   NULL
--   changed_field text      NO   NULL
--   before_value  text      YES  NULL
--   after_value   text      YES  NULL
--   changed_by    text      YES  NULL
--   changed_at    timestamp with time zone  YES  now()

-- Q3.3 CHECK constraint 內容
SELECT conname, pg_get_constraintdef(oid)
  FROM pg_constraint
 WHERE conrelid = 'employee_change_logs'::regclass
   AND contype = 'c';
-- 預期:CHECK (changed_field IN ('name','dept_id','role','is_manager','base_salary','position','manager_id'))

-- Q3.4 indexes(含 PK + 2 自定)
SELECT indexname, indexdef FROM pg_indexes
 WHERE schemaname='public' AND tablename='employee_change_logs'
 ORDER BY indexname;
-- 預期 3 row:
--   employee_change_logs_pkey                  CREATE UNIQUE INDEX ...(id)
--   idx_employee_change_logs_employee          CREATE INDEX ...(employee_id, changed_at DESC)
--   idx_employee_change_logs_time              CREATE INDEX ...(changed_at DESC)

-- Q3.5 row count 0(無 backfill)
SELECT COUNT(*) FROM employee_change_logs;                            -- 預期:0
