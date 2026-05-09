-- 驗證 1.2: payroll_periods 表 + FK + index + RLS

-- §1. payroll_periods 表存在
SELECT table_name FROM information_schema.tables
WHERE table_schema='public' AND table_name='payroll_periods';
-- expect: 1 row

-- §2. payroll_periods 18 欄(id + year + month + period_start/end + cutoff + pay_date + status + 4 個統計 cache + 8 個 audit + note)
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_name='payroll_periods'
ORDER BY ordinal_position;
-- expect: 18 rows

-- §3. status CHECK 包含 6 個 status
SELECT pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conrelid='payroll_periods'::regclass
  AND contype='c'
  AND conname LIKE '%status%';
-- expect: 1 row、含 'draft','calculating','pending_review','approved','paid','locked'

-- §4. month CHECK + UNIQUE(year, month)
SELECT conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid='payroll_periods'::regclass
  AND contype IN ('c','u')
ORDER BY conname;
-- expect: 含 month CHECK (BETWEEN 1 AND 12) 和 UNIQUE (year, month)

-- §5. salary_records.payroll_period_id FK 建好
SELECT conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid='salary_records'::regclass
  AND conname='salary_records_payroll_period_id_fkey';
-- expect: 1 row、FOREIGN KEY (payroll_period_id) REFERENCES payroll_periods(id)

-- §6. 3 個 index
SELECT indexname FROM pg_indexes
WHERE indexname IN (
  'idx_salary_records_payroll_period_id',
  'idx_payroll_periods_status_active',
  'idx_payroll_periods_year_month'
)
ORDER BY indexname;
-- expect: 3 rows

-- §7. RLS enabled
SELECT rowsecurity FROM pg_tables WHERE tablename='payroll_periods';
-- expect: t

-- §8. 4 個 policy
SELECT policyname, cmd FROM pg_policies
WHERE tablename='payroll_periods'
ORDER BY policyname;
-- expect: 4 rows(select / insert / update / delete、全 auth_is_hr_admin())

-- §9. created_by / reviewed_by / approved_by 3 個 FK 建好
SELECT conname FROM pg_constraint
WHERE conrelid='payroll_periods'::regclass
  AND contype='f'
ORDER BY conname;
-- expect: 3 rows
