-- 驗證 0.1 migration: payroll baseline
-- 在 Supabase Studio SQL Editor 跑、把每段結果回貼確認

-- §1. employees 8 個 drift 欄位都存在
SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_name='employees'
  AND column_name IN (
    'attendance_bonus','grade_allowance','manager_allowance','has_insurance',
    'grade','grade_level','hourly_rate','resign_date'
  )
ORDER BY column_name;
-- expect: 8 rows

-- §2-7. 6 張 table 都存在
SELECT table_name FROM information_schema.tables
WHERE table_schema='public'
  AND table_name IN (
    'labor_insurance_brackets','health_insurance_brackets',
    'insurance_settings','insurance_change_requests','salary_grade',
    'insurance_settings_history'
  )
ORDER BY table_name;
-- expect: 6 rows

-- §4. insurance_settings 擴的 4 欄
SELECT column_name FROM information_schema.columns
WHERE table_name='insurance_settings'
  AND column_name IN (
    'pension_voluntary_rate','pension_voluntary_amount','pension_wage','created_at'
  )
ORDER BY column_name;
-- expect: 4 rows

-- §5. insurance_change_requests 擴的 pension 4 欄
SELECT column_name FROM information_schema.columns
WHERE table_name='insurance_change_requests'
  AND column_name IN (
    'old_pension_rate','old_pension_company','new_pension_rate','new_pension_company'
  )
ORDER BY column_name;
-- expect: 4 rows

-- §5. status CHECK 包含 'cancelled'
SELECT pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conrelid='insurance_change_requests'::regclass
  AND conname='insurance_change_requests_status_check';
-- expect: 1 row、definition 含 'pending','approved','rejected','cancelled'

-- §5. requested_by / approved_by FK 都建好
SELECT conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid='insurance_change_requests'::regclass
  AND contype='f'
ORDER BY conname;
-- expect: 3 rows (employee_id_fkey + requested_by_fkey + approved_by_fkey)

-- §7. insurance_settings_history 8 欄
SELECT column_name, data_type FROM information_schema.columns
WHERE table_name='insurance_settings_history'
ORDER BY ordinal_position;
-- expect: 8 columns

-- §8. 3 個新 index
SELECT indexname FROM pg_indexes
WHERE tablename IN ('insurance_change_requests','insurance_settings_history')
  AND indexname IN ('idx_icr_employee_id','idx_icr_status_created','idx_ish_employee_effective')
ORDER BY indexname;
-- expect: 3 rows

-- §9. RLS enabled on 6 tables
SELECT tablename, rowsecurity
FROM pg_tables
WHERE schemaname='public'
  AND tablename IN (
    'labor_insurance_brackets','health_insurance_brackets',
    'insurance_settings','insurance_change_requests','salary_grade',
    'insurance_settings_history'
  )
ORDER BY tablename;
-- expect: 6 rows、all rowsecurity=true

-- §9. insurance_settings_history 的 policy
SELECT policyname, cmd FROM pg_policies
WHERE tablename='insurance_settings_history'
ORDER BY policyname;
-- expect: 2 rows (ish_insert / ish_select)

-- §9. 既有 5 張表 RLS policy 沒被洗掉
SELECT tablename, count(*) AS policy_count
FROM pg_policies
WHERE tablename IN (
  'labor_insurance_brackets','health_insurance_brackets',
  'insurance_settings','insurance_change_requests','salary_grade'
)
GROUP BY tablename
ORDER BY tablename;
-- expect: 5 rows、each policy_count=4

-- §10. trigger 存在 + active
SELECT tgname, tgenabled FROM pg_trigger
WHERE tgrelid='insurance_settings'::regclass
  AND tgname='tg_insurance_settings_history';
-- expect: 1 row, tgenabled='O'

-- §10. function 存在
SELECT proname FROM pg_proc WHERE proname='sync_insurance_settings_history';
-- expect: 1 row
