# Payroll Audit — hr-system-v2

> 盤點時間:2026-05-09
> 範圍:hr-system-v2 repo（為新薪資模組規劃做前期 audit）
> 規則:read-only,本檔為唯一新增檔,其他檔案未動。

---

## 1. 目錄結構

```
.
├── README.md
├── api
│   ├── admin
│   │   └── cron-trigger.js
│   ├── announcements.js
│   ├── annual-leaves
│   │   ├── [id].js
│   │   └── index.js
│   ├── approvals.js
│   ├── attendance
│   │   ├── [id].js
│   │   ├── anomaly.js
│   │   └── index.js
│   ├── attendance-penalties
│   │   ├── [id].js
│   │   ├── _repo.js
│   │   └── index.js
│   ├── attendance-penalty-records
│   │   ├── [id]
│   │   └── index.js
│   ├── auth.js
│   ├── calendar
│   │   └── index.js
│   ├── comp-time
│   │   └── index.js
│   ├── cron-absence-detection.js
│   ├── cron-annual-leave-rollover.js
│   ├── cron-comp-expiry-warning.js
│   ├── cron-comp-expiry.js
│   ├── cron-leave-proof-expiry.js
│   ├── cron-schedule-lock.js
│   ├── cron-schedule-reminder.js
│   ├── employees
│   │   ├── [id].js
│   │   └── index.js
│   ├── holidays
│   │   ├── [id].js
│   │   ├── import.js
│   │   └── index.js
│   ├── leaves
│   │   ├── [id].js
│   │   ├── _repo.js
│   │   └── index.js
│   ├── office-locations
│   │   ├── [id].js
│   │   └── index.js
│   ├── overtime-limits
│   │   ├── [id].js
│   │   └── index.js
│   ├── overtime-requests
│   │   ├── [id]
│   │   ├── _repo.js
│   │   └── index.js
│   ├── resigned-archive.js
│   ├── salary
│   │   ├── [id].js
│   │   ├── _repo.js
│   │   ├── index.js
│   │   └── recalculate.js
│   ├── salary-grade.js
│   ├── schedule-periods
│   │   ├── [id]
│   │   └── index.js
│   ├── schedule-templates
│   │   ├── [id]
│   │   ├── [id].js
│   │   └── index.js
│   └── schedules
│       ├── [id].js
│       └── index.js
├── docs
│   ├── PHASE_A_GPS.md
│   ├── attendance-system-design-v1.md
│   ├── attendance-system-implementation-plan-v1.md
│   └── rls-and-auth-design-v1.md
├── lib
│   ├── attendance
│   │   ├── absence-sweep.js
│   │   ├── bonus.js
│   │   ├── clock.js
│   │   ├── geo.js
│   │   ├── penalty.js
│   │   ├── rate.js
│   │   └── recompute.js
│   ├── auth-scope.js
│   ├── auth.js
│   ├── comp-time
│   │   ├── balance.js
│   │   ├── expiry-sweep.js
│   │   └── expiry-warning.js
│   ├── cron-auth.js
│   ├── dept-name-mapper.js
│   ├── dept-sync.js
│   ├── employee
│   │   └── change-logger.js
│   ├── holidays
│   │   ├── lookup.js
│   │   └── parser.js
│   ├── leave
│   │   ├── advance-time.js
│   │   ├── annual-rollover.js
│   │   ├── annual.js
│   │   ├── balance.js
│   │   ├── proof-sweep.js
│   │   ├── proof.js
│   │   ├── request-flow.js
│   │   ├── stages.js
│   │   └── types.js
│   ├── overtime
│   │   ├── comp-conversion.js
│   │   ├── limits.js
│   │   ├── pay-calc.js
│   │   └── request-state.js
│   ├── push.js
│   ├── roles.js
│   ├── salary
│   │   ├── attendance-bonus.js
│   │   ├── calculator.js
│   │   ├── overtime-aggregator.js
│   │   ├── penalty-applier.js
│   │   └── settlement.js
│   ├── schedule
│   │   ├── break-overlap.js
│   │   ├── change-logger.js
│   │   ├── lock-sweep.js
│   │   ├── period-state.js
│   │   ├── permissions.js
│   │   ├── reminder.js
│   │   └── work-hours.js
│   ├── shift-types
│   │   └── handler.js
│   └── supabase.js
├── migrations
│   ├── 2026_05_05_attendance_absent_offday_cleanup.sql
│   ├── 2026_05_05_leave_days_to_numeric.sql
│   ├── 2026_05_05_leave_phase1_schema.sql
│   ├── 2026_05_05_shift_types_break_window.sql
│   ├── 2026_05_06_leave_pending_status_cleanup.sql
│   ├── 2026_05_06_leave_proof_expiry_action.sql
│   ├── 2026_05_07_attendance_early_arrival.sql
│   ├── 2026_05_07_attendance_gps_phase_a.sql
│   ├── 2026_05_07_employee_change_logs.sql
│   ├── 2026_05_07_employees_resigned_metadata.sql
│   ├── 2026_05_07_leave_terminated_status.sql
│   └── 2026_05_07_schedule_periods_audit.sql
├── migrations-verify
│   ├── SUMMARY.md
│   ├── verify_attendance_early_arrival.sql
│   ├── verify_attendance_gps_phase_a.sql
│   ├── verify_employee_change_logs.sql
│   ├── verify_employees_resigned_metadata.sql
│   ├── verify_leave_terminated_status.sql
│   └── verify_schedule_periods_audit.sql
├── package-lock.json
├── package.json
├── public
│   ├── announcement-admin.html
│   ├── announcements.html
│   ├── annual-leave-admin.html
│   ├── approvals.html
│   ├── attendance-admin.html
│   ├── attendance-locations-admin.html
│   ├── attendance-penalty-admin.html
│   ├── attendance.html
│   ├── calendar.html
│   ├── comp-time-admin.html
│   ├── comp-time.html
│   ├── css
│   │   └── style.css
│   ├── dashboard.html
│   ├── departments.html
│   ├── employee-app.html
│   ├── employee-approvals.html
│   ├── employee-leave.html
│   ├── employee-profile.html
│   ├── employee-salary.html
│   ├── employee-schedule.html
│   ├── employees.html
│   ├── holidays-admin.html
│   ├── icons
│   │   ├── icon-128.png
│   │   ├── icon-192.png
│   │   ├── icon-512.png
│   │   ├── icon-72.png
│   │   ├── icon-96.png
│   │   └── icon.svg
│   ├── index.html
│   ├── insurance.html
│   ├── js
│   │   ├── excel-tools.js
│   │   ├── layout.js
│   │   ├── pwa.js
│   │   ├── roles.js
│   │   ├── schedule
│   │   └── utils.js
│   ├── leave-admin.html
│   ├── leave.html
│   ├── login.html
│   ├── manifest.json
│   ├── notifications.html
│   ├── orgchart.html
│   ├── overtime-admin.html
│   ├── overtime-review.html
│   ├── overtime.html
│   ├── resigned-archive.html
│   ├── salary.html
│   ├── schedule-templates.html
│   ├── schedule.html
│   ├── shift-types-admin.html
│   └── sw.js
├── scripts
│   ├── create-all-auth.js
│   └── recompute_attendance.mjs
├── supabase_attendance_v2_README.md
├── supabase_attendance_v2_batch_a.sql
├── supabase_attendance_v2_batch_b.sql
├── supabase_attendance_v2_batch_c.sql
├── supabase_extra_allowance.sql
├── supabase_known_drift_2026_05.sql
├── supabase_role_split_migration.sql
├── supabase_roles_update.sql
├── supabase_schedule.sql
├── supabase_setup.sql
├── tests
│   ├── api-annual-leaves-adjust.test.js
│   ├── api-approvals.test.js
│   ├── api-attendance-handle-new-punch-geo.test.js
│   ├── api-attendance-routing.test.js
│   ├── api-leaves-manager-name.test.js
│   ├── api-office-locations.test.js
│   ├── api-overtime-ceo-review.test.js
│   ├── api-overtime-manager-review.test.js
│   ├── api-penalty-waive.test.js
│   ├── api-resigned-archive.test.js
│   ├── api-schedule-period-approve.test.js
│   ├── api-schedule-period-publish.test.js
│   ├── api-schedules-routing.test.js
│   ├── api-scope-integration.test.js
│   ├── attendance-absence-sweep.test.js
│   ├── attendance-bonus.test.js
│   ├── attendance-clock.test.js
│   ├── attendance-penalty.test.js
│   ├── attendance-rate.test.js
│   ├── attendance-recompute.test.js
│   ├── auth-scope.test.js
│   ├── comp-time-balance.test.js
│   ├── comp-time-expiry.test.js
│   ├── cron-absence-detection.test.js
│   ├── cron-leave-proof-expiry.test.js
│   ├── dept-manager-sync.test.js
│   ├── dept-name-mapper.test.js
│   ├── dept-sync.test.js
│   ├── holidays-lookup.test.js
│   ├── holidays-parser.test.js
│   ├── leave-advance-time.test.js
│   ├── leave-annual-rollover.test.js
│   ├── leave-annual.test.js
│   ├── leave-balance.test.js
│   ├── leave-multi-stage.test.js
│   ├── leave-proof-sweep.test.js
│   ├── leave-proof.test.js
│   ├── leave-request-flow.test.js
│   ├── leave-stages.test.js
│   ├── lib-attendance-clock-geo.test.js
│   ├── lib-attendance-geo.test.js
│   ├── lib-employee-change-logger.test.js
│   ├── lib-schedule-excel.test.js
│   ├── lib-shift-types-handler.test.js
│   ├── overtime-comp-conversion.test.js
│   ├── overtime-limits.test.js
│   ├── overtime-pay-calc.test.js
│   ├── overtime-request-state.test.js
│   ├── roles.test.js
│   ├── salary-attendance-bonus.test.js
│   ├── salary-calculator.test.js
│   ├── salary-overtime-aggregator.test.js
│   ├── salary-penalty-applier.test.js
│   ├── salary-settlement.test.js
│   ├── schedule-change-logger.test.js
│   ├── schedule-period-state.test.js
│   ├── schedule-periods-publish.test.js
│   ├── schedule-periods-wish-deadline.test.js
│   ├── schedule-permissions.test.js
│   ├── schedule-templates-apply.test.js
│   ├── schedule-templates.test.js
│   ├── schedule-work-hours.test.js
│   └── utils-fmtTaipeiTime.test.js
└── vercel.json

43 directories, 246 files
```

> ※ 系統無 `tree` 命令、本次跑時 `brew install tree` 後產生。

---

## 2. Supabase Schema

### 2.1 Schema 來源(repo 內)

| 來源 | 角色 |
|---|---|
| `supabase_setup.sql` | 原始 v1 建表(departments / employees / leave_requests / employee_change_logs / attendance / **salary_records** / system_settings + RLS allow_all) |
| `supabase_schedule.sql` | shift_types / schedules / shift_swap_requests / schedule_periods |
| `supabase_attendance_v2_batch_a.sql` | Attendance v2 純新增表(holidays / **leave_types** / annual_leave_records / comp_time_balance / leave_balance_logs / overtime_requests / overtime_limits / overtime_request_logs / **attendance_penalties** / **attendance_penalty_records** / system_overtime_settings / schedule_change_logs + attendance_monthly_summary view) |
| `supabase_attendance_v2_batch_b.sql` | 既有表 ALTER + backfill(employees / shift_types / schedules / schedule_periods / attendance / leave_requests) |
| `supabase_attendance_v2_batch_c.sql` | **salary_records 大改** —— 加 _auto/_manual 欄位 + DROP/ADD GENERATED gross_salary / net_salary |
| `supabase_extra_allowance.sql` | employees + salary_records 加 `extra_allowance` 欄位 |
| `supabase_role_split_migration.sql` | employees.role 收斂為 5 值 + is_manager 拆分 |
| `supabase_roles_update.sql` | employees 加 `employment_type` (full_time/part_time) |
| `supabase_known_drift_2026_05.sql` | **drift snapshot 文件**(全註解、不執行)。記錄 prod 與 SQL 檔之間 12 條 known drift(C1-C12) |
| `migrations/2026_05_05_*.sql`(6 條) | leave Phase 1.1-1.5 / shift_types break_window / leave days NUMERIC / 出勤 absent off-day cleanup |
| `migrations/2026_05_06_*.sql`(2 條) | leave 'pending' status cleanup / proof_expiry_action |
| `migrations/2026_05_07_*.sql`(6 條) | attendance early_arrival / GPS Phase A / employee_change_logs / employees resigned_metadata / leave_terminated_status / schedule_periods_audit |
| `migrations-verify/*.sql` | 三段式 migration 的 verify SQL(② post-ALTER 檢查 prod 套用無誤) |

### 2.2 所有 table(repo 中可確認的)

從 `CREATE TABLE` 抓:
1. `departments`
2. `employees`
3. `leave_requests`
4. `employee_change_logs`
5. `attendance`
6. `salary_records`
7. `system_settings`
8. `holidays`
9. `leave_types`
10. `annual_leave_records`
11. `comp_time_balance`
12. `leave_balance_logs`
13. `overtime_requests`
14. `overtime_limits`
15. `overtime_request_logs`
16. `attendance_penalties`
17. `attendance_penalty_records`
18. `system_overtime_settings`
19. `schedule_change_logs`
20. `shift_types`
21. `schedules`
22. `shift_swap_requests`
23. `schedule_periods`
24. `office_locations`(GPS Phase A)

**Repo 沒對應 SQL、但 prod 必有的 table**(從 code 反推、屬 known drift):
- `labor_insurance_brackets` — `api/salary-grade.js:20` SELECT
- `health_insurance_brackets` — `api/salary-grade.js:26` SELECT
- `insurance_settings` — `api/salary-grade.js:42` SELECT/upsert
- `insurance_change_requests` — `api/salary-grade.js:32` / `api/employees/[id].js:126` insert
- `salary_grade` — `api/salary-grade.js:110` SELECT
- `push_subscriptions` — `api/employees/index.js:62` upsert
- `notifications` — `public/js/layout.js:169` SELECT

> 這些 table 在 `supabase_known_drift_2026_05.sql` 沒列入(該檔只記 schema/欄位 drift、不記「整張 table 缺 SQL」),要起新薪資模組時必須先把它們補進 repo SQL。

### 2.3 員工(`employees`)欄位定義

#### 2.3.1 SQL 中的定義(supabase_setup.sql + 後續 ALTER)

```sql
-- supabase_setup.sql:15-41(原始 CREATE TABLE)
CREATE TABLE IF NOT EXISTS employees (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT UNIQUE,
  phone         TEXT,
  dept_id       TEXT REFERENCES departments(id),
  dept          TEXT NOT NULL,                        -- legacy(C0 cleanup 已停用、保留欄位)
  position      TEXT NOT NULL,
  role          TEXT DEFAULT 'employee'
                CHECK (role IN ('employee','hr','ceo','chairman','admin')),
  is_manager    BOOLEAN NOT NULL DEFAULT false,
  manager_id    TEXT,
  avatar        TEXT,
  hire_date     DATE,
  birth_date    DATE,
  id_number     TEXT,
  address       TEXT,
  bank_account  TEXT,
  base_salary   NUMERIC(12,2) DEFAULT 0,              -- ★ 薪資欄位
  status        TEXT DEFAULT 'active'
                CHECK (status IN ('active','inactive','resigned')),
  resigned_at     TIMESTAMPTZ,                         -- 2026-05-07 加
  resigned_reason TEXT,                                -- 2026-05-07 加
  auth_user_id  UUID REFERENCES auth.users(id),
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- supabase_extra_allowance.sql:6-7
ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS extra_allowance      NUMERIC(10,2) DEFAULT 0,  -- ★ 薪資欄位
  ADD COLUMN IF NOT EXISTS extra_allowance_note TEXT          DEFAULT '';

-- supabase_roles_update.sql:4-6
ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS employment_type TEXT DEFAULT 'full_time'
  CHECK (employment_type IN ('full_time', 'part_time'));

-- supabase_attendance_v2_batch_b.sql:28-29
ALTER TABLE employees ADD COLUMN IF NOT EXISTS
  annual_leave_seniority_start DATE;                   -- 後 SET NOT NULL(段 3)

-- supabase_role_split_migration.sql:50-54
ALTER TABLE employees DROP CONSTRAINT IF EXISTS employees_role_check;
ALTER TABLE employees ADD CONSTRAINT employees_role_check
  CHECK (role IN ('employee','hr','ceo','chairman','admin'));
```

#### 2.3.2 Code 引用、但 SQL 沒定義的欄位(prod-only drift)

從 `api/employees/[id].js:93` 及 `api/salary-grade.js:42`、`lib/salary/calculator.js:165-173` 反推:

| 欄位 | 用途 | 在哪被引用 |
|---|---|---|
| `emp_no` | 員工編號(`02YYMMDD` 兼職 / `01YYMMDD` 正職) | `api/employees/index.js:228, 261-282`、`api/employees/[id].js:45` |
| `attendance_bonus` | 全勤獎金 base 額度 | `lib/salary/calculator.js`、`api/salary/_repo.js:15`、`api/employees/[id].js:93` |
| `grade_allowance` | 職等加給 | `api/salary-grade.js:42`、`api/employees/[id].js:93,102` |
| `manager_allowance` | 主管加給 | 同上 |
| `has_insurance` | 是否投保(false=執行長 / 專案合作 / 特殊情況) | `api/employees/[id].js:100,108`、`api/salary-grade.js:42` |

⚠ **這些欄位都是 prod schema 已存在、但 repo SQL 沒對應 ALTER**。寫新薪資模組前要先補成 migration、否則 fresh dev DB 無法重建。

### 2.4 attendance / 排班 / 假別 schema(薪資相依)

#### 2.4.1 `attendance`

```sql
-- supabase_setup.sql:89-105 + 多次 ALTER
CREATE TABLE IF NOT EXISTS attendance (
  id             TEXT PRIMARY KEY,
  employee_id    TEXT NOT NULL REFERENCES employees(id),
  work_date      DATE NOT NULL,
  clock_in       TIMESTAMPTZ,
  clock_out      TIMESTAMPTZ,
  work_hours     NUMERIC(4,2),
  overtime_hours NUMERIC(4,2) DEFAULT 0,
  early_arrival_minutes INT NOT NULL DEFAULT 0,        -- 2026-05-07
  status         TEXT DEFAULT 'normal'
                 CHECK (status IN ('normal','late','early_leave','absent','leave','holiday')),
  note           TEXT DEFAULT '',
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(employee_id, work_date)
);

-- batch_b ALTER:加 schedule_id / segment_no / late_minutes / early_leave_minutes /
-- is_holiday_work / holiday_id / is_anomaly / anomaly_note
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS schedule_id TEXT REFERENCES schedules(id);
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS segment_no INT NOT NULL DEFAULT 1;
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS late_minutes INT NOT NULL DEFAULT 0;
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS early_leave_minutes INT NOT NULL DEFAULT 0;
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS is_holiday_work BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS holiday_id BIGINT REFERENCES holidays(id);
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS is_anomaly BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS anomaly_note TEXT;

-- GPS Phase A(11 columns)
ALTER TABLE attendance
  ADD COLUMN IF NOT EXISTS clock_in_lat / clock_in_lng / clock_in_accuracy / clock_in_distance_m /
                           clock_in_location_id / clock_out_lat / clock_out_lng /
                           clock_out_accuracy / clock_out_distance_m / clock_out_location_id /
                           gps_flag;
```

#### 2.4.2 `schedules`

```sql
-- supabase_schedule.sql:36-51 + batch_b ALTER
CREATE TABLE IF NOT EXISTS schedules (
  id            TEXT PRIMARY KEY,
  employee_id   TEXT NOT NULL REFERENCES employees(id),
  work_date     DATE NOT NULL,
  shift_type_id TEXT NOT NULL REFERENCES shift_types(id),    -- prod 已 DROP NOT NULL(C5 drift)
  start_time    TEXT,                                          -- batch_b ALTER → TIME
  end_time      TEXT,                                          -- batch_b ALTER → TIME
  dept          TEXT,
  note          TEXT DEFAULT '',
  status        TEXT DEFAULT 'draft' CHECK (status IN ('draft','confirmed','locked')),
  created_by    TEXT,
  updated_by    TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(employee_id, work_date)                                -- prod 已改 (employee_id, work_date, segment_no)
);

-- batch_b 加:period_id / start_time TIME / end_time TIME / crosses_midnight /
-- scheduled_work_minutes / segment_no
```

#### 2.4.3 `schedule_periods`

```sql
-- supabase_schedule.sql:73-86 + batch_b ALTER + 2026-05-07 audit
CREATE TABLE IF NOT EXISTS schedule_periods (
  id          TEXT PRIMARY KEY,
  start_date  DATE NOT NULL,
  end_date    DATE NOT NULL,
  dept        TEXT,                                              -- legacy
  status      TEXT DEFAULT 'draft'
              CHECK (status IN ('draft','submitted','approved','locked')),  -- prod 已加 'published'(C1 drift)
  created_by  TEXT,
  approved_by TEXT,
  published_by TEXT REFERENCES employees(id),                     -- 2026-05-07
  published_at TIMESTAMPTZ,                                       -- 2026-05-07
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- batch_b 加:employee_id / period_year / period_month / period_start / period_end /
-- submitted_at / approved_at / locked_at + UNIQUE (employee_id, period_year, period_month)
```

#### 2.4.4 `leave_requests`

```sql
-- supabase_setup.sql:44-66 + Phase 1.1 D 段(18 欄位)+ Phase 1.6(terminated)
CREATE TABLE IF NOT EXISTS leave_requests (
  id            TEXT PRIMARY KEY,
  employee_id   TEXT NOT NULL REFERENCES employees(id),
  leave_type    TEXT NOT NULL REFERENCES leave_types(code),    -- batch_b FK
  start_date    DATE NOT NULL,
  end_date      DATE NOT NULL,
  days          NUMERIC(5,2) NOT NULL,                          -- 2026-05-05 INTEGER → NUMERIC
  reason        TEXT,
  status        TEXT DEFAULT 'pending_mgr'
                CHECK (status IN ('pending_mgr','pending_ceo','approved','archived',
                                  'rejected','cancelled','terminated')),
  applied_at    TIMESTAMPTZ DEFAULT NOW(),
  handler_note  TEXT DEFAULT '',
  handled_at    TIMESTAMPTZ,
  handled_by    TEXT REFERENCES employees(id),
  terminated_by TEXT REFERENCES employees(id),                   -- 2026-05-07
  terminated_at TIMESTAMPTZ                                      -- 2026-05-07
);

-- Phase 1.1 加 18 欄位:
--   多階審核:mgr_reviewed_by / mgr_reviewed_at / mgr_decision / mgr_reject_reason
--             ceo_reviewed_by / ceo_reviewed_at / ceo_decision / ceo_reject_reason
--             archived_at / archived_by
--   前置時間:late_application(BOOLEAN)/ late_reason
--   證明文件:proof_url / proof_due_at / proof_status
--             CHECK ('not_required','required','submitted','expired','converted_to_personal')
--   Override:override_by / override_at / override_reason
--   時數:reviewed_by / reviewed_at / reject_reason / hours / finalized_hours / start_at / end_at
--   source_overtime_request_id BIGINT REFERENCES overtime_requests(id)
```

#### 2.4.5 `leave_types`

```sql
-- supabase_attendance_v2_batch_a.sql:38-64
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
  advance_hours    INTEGER NOT NULL DEFAULT 0,
  advance_rule     TEXT    NOT NULL DEFAULT 'soft' CHECK (advance_rule IN ('hard','soft')),
  requires_proof   BOOLEAN NOT NULL DEFAULT false,
  proof_grace_days INTEGER NOT NULL DEFAULT 0,
  proof_expiry_action TEXT NOT NULL DEFAULT 'convert'
    CHECK (proof_expiry_action IN ('convert','mark_expired')),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);
-- 含 15 種假別:annual / sick / personal / maternity / funeral / marriage / comp / public /
--   paternity_prenatal / paternity / miscarriage / pregnancy_rest / parental /
--   work_injury / menstrual / family_care / typhoon / voting / hospital_unpaid / job_seeking
```

#### 2.4.6 `shift_types`

```sql
-- supabase_schedule.sql:9-20 + batch_b ALTER + 2026-05-05 break_window
CREATE TABLE IF NOT EXISTS shift_types (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  start_time  TEXT,                                       -- batch_b ALTER → TIME
  end_time    TEXT,                                       -- batch_b ALTER → TIME
  is_flexible BOOLEAN DEFAULT FALSE,
  is_off      BOOLEAN DEFAULT FALSE,
  color       TEXT DEFAULT '#5B8DEF',
  break_start TIME,                                       -- 2026-05-05
  break_end   TIME,                                       -- 2026-05-05
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
-- batch_b 加:break_minutes INT NOT NULL DEFAULT 60、is_active BOOLEAN NOT NULL DEFAULT true
-- prod-only drift(C4):is_system / sort_order / crosses_midnight / updated_at
-- prod 已加 ST005-ST008(C2 drift)、ST002 設 is_active=false(C3 drift)
```

#### 2.4.7 `departments`

```sql
-- supabase_setup.sql:7-12
CREATE TABLE IF NOT EXISTS departments (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  manager_id  TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
-- code 中還用 description / color 欄位(api/employees/index.js:148, 154-156),
-- repo SQL 沒見到 ALTER ADD COLUMN、屬 prod-only drift
```

### 2.5 薪資相關 table

#### 2.5.1 `salary_records` —— v2 重構後

```sql
-- 原始(supabase_setup.sql:108-132)
CREATE TABLE IF NOT EXISTS salary_records (
  id               TEXT PRIMARY KEY,
  employee_id      TEXT NOT NULL REFERENCES employees(id),
  year             INTEGER NOT NULL,
  month            INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),
  base_salary      NUMERIC(12,2) DEFAULT 0,
  overtime_pay     NUMERIC(12,2) DEFAULT 0,                 -- legacy(batch_c 後改用 _auto + _manual)
  bonus            NUMERIC(12,2) DEFAULT 0,                  -- legacy(batch_c 後 attendance_bonus_*)
  allowance        NUMERIC(12,2) DEFAULT 0,
  deduct_absence   NUMERIC(12,2) DEFAULT 0,
  deduct_labor_ins NUMERIC(12,2) DEFAULT 0,
  deduct_health_ins NUMERIC(12,2) DEFAULT 0,
  deduct_tax       NUMERIC(12,2) DEFAULT 0,
  status           TEXT DEFAULT 'draft' CHECK (status IN ('draft','confirmed','paid')),
  pay_date         DATE,
  note             TEXT DEFAULT '',
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(employee_id, year, month)
);

-- supabase_extra_allowance.sql 加 extra_allowance / extra_allowance_note

-- batch_c 大改(2.5.2 新欄位 + DROP/ADD GENERATED)
```

#### 2.5.2 `salary_records` v2 新欄位(batch_c.sql:27-60)

```sql
ALTER TABLE salary_records
  ADD overtime_pay_auto         NUMERIC(10,2) NOT NULL DEFAULT 0;    -- 系統算
  ADD overtime_pay_manual       NUMERIC(10,2) NOT NULL DEFAULT 0;    -- HR 改
  ADD overtime_pay_note         TEXT;
  ADD comp_expiry_payout        NUMERIC(10,2) NOT NULL DEFAULT 0;    -- 補休失效 cash payout
  ADD attendance_penalty_total  NUMERIC(10,2) NOT NULL DEFAULT 0;    -- 出勤懲處扣款
  ADD attendance_bonus_base     NUMERIC(10,2) NOT NULL DEFAULT 0;    -- 全勤底額
  ADD attendance_bonus_deduction_rate NUMERIC(4,3) NOT NULL DEFAULT 0;  -- 扣除比例 0~1
  ADD attendance_bonus_actual   NUMERIC(10,2);                         -- 全勤實領
  ADD absence_days              NUMERIC(4,1) NOT NULL DEFAULT 0;
  ADD daily_wage_snapshot       NUMERIC(10,2);                         -- base/工作日
  ADD holiday_work_pay          NUMERIC(10,2) NOT NULL DEFAULT 0;
  ADD settlement_amount         NUMERIC(10,2) NOT NULL DEFAULT 0;       -- 特休結算 cash
  ADD settlement_note           TEXT;

-- DROP 既有 GENERATED gross_salary / net_salary、改用新公式:
ALTER TABLE salary_records ADD COLUMN gross_salary NUMERIC(12,2)
  GENERATED ALWAYS AS (
    base_salary
    + COALESCE(attendance_bonus_actual, 0)
    + COALESCE(allowance, 0)
    + COALESCE(extra_allowance, 0)
    + COALESCE(overtime_pay_auto + overtime_pay_manual, 0)
    + COALESCE(comp_expiry_payout, 0)
    + COALESCE(holiday_work_pay, 0)
    + COALESCE(settlement_amount, 0)
  ) STORED;

ALTER TABLE salary_records ADD COLUMN net_salary NUMERIC(12,2)
  GENERATED ALWAYS AS (
    base_salary + COALESCE(attendance_bonus_actual,0) + COALESCE(allowance,0)
    + COALESCE(extra_allowance,0)
    + COALESCE(overtime_pay_auto + overtime_pay_manual,0)
    + COALESCE(comp_expiry_payout,0) + COALESCE(holiday_work_pay,0)
    + COALESCE(settlement_amount,0)
    - COALESCE(deduct_absence,0) - COALESCE(deduct_labor_ins,0)
    - COALESCE(deduct_health_ins,0) - COALESCE(deduct_tax,0)
    - COALESCE(attendance_penalty_total,0)
  ) STORED;

-- 反向 FK:
ALTER TABLE attendance_penalty_records ADD CONSTRAINT fk_penalty_records_salary
  FOREIGN KEY (salary_record_id) REFERENCES salary_records(id);
ALTER TABLE overtime_requests ADD CONSTRAINT fk_overtime_requests_salary
  FOREIGN KEY (applied_to_salary_record_id) REFERENCES salary_records(id);
ALTER TABLE leave_requests ADD CONSTRAINT fk_leave_requests_overtime
  FOREIGN KEY (source_overtime_request_id) REFERENCES overtime_requests(id);
ALTER TABLE comp_time_balance ADD CONSTRAINT fk_comp_time_balance_overtime
  FOREIGN KEY (source_overtime_request_id) REFERENCES overtime_requests(id);
```

#### 2.5.3 其他薪資相依 table(其他段已展開,此處為對照表)

| Table | 在哪建立 | 角色 |
|---|---|---|
| `attendance_penalties` | batch_a:350-402 | 出勤獎懲規則(HR 設定) |
| `attendance_penalty_records` | batch_a:408-446 | 觸發後產生的個別記錄、status='applied' 後寫到 salary_records.attendance_penalty_total |
| `overtime_requests` | batch_a:208-275 | 加班申請、approved + compensation_type='overtime_pay' 才寫 salary_records.overtime_pay_auto |
| `comp_time_balance` | batch_a:151-176 | 補休餘額;失效時寫到 salary_records.comp_expiry_payout(由 cron-comp-expiry.js 提前算) |
| `annual_leave_records` | batch_a:118-146 | 特休 grant/used;月結算金額 = remaining_days × daily_wage、寫 salary_records.settlement_amount |
| `holidays` | batch_a:10-32 | 國定假日 + pay_multiplier(預設 2.00) |
| `system_overtime_settings` | batch_a:449-470 | 加班費率(weekday/rest_day 前 2h / 後 2h) + monthly_work_hours_base(預設 240) |

**Repo 沒對應 SQL、但 prod 一定要有的薪資相關 table**(從 `api/salary-grade.js` + `api/employees/[id].js` 反推):
- `labor_insurance_brackets` —— 勞保級距表(`bracket_level / monthly_wage_min / monthly_wage_max / insured_salary / employee_premium / company_premium`)
- `health_insurance_brackets` —— 健保級距表(同上 + `per_dependent`)
- `insurance_settings` —— 員工 × 級距(`employee_id / labor_ins_bracket / labor_ins_employee / labor_ins_company / health_ins_bracket / health_ins_employee / health_ins_company / health_ins_dependents / has_insurance`)
- `insurance_change_requests` —— 級距變動申請(薪資調整時自動觸發、HR 審後 upsert insurance_settings)
- `salary_grade` —— 職等薪資級距表(grade / grade_level)

### 2.6 RLS Policy

從 SQL 檔抓到的全部都是 **demo allow-all**:

```sql
-- supabase_setup.sql:142-155
ALTER TABLE departments     ENABLE ROW LEVEL SECURITY;
ALTER TABLE employees       ENABLE ROW LEVEL SECURITY;
ALTER TABLE leave_requests  ENABLE ROW LEVEL SECURITY;
ALTER TABLE attendance      ENABLE ROW LEVEL SECURITY;
ALTER TABLE salary_records  ENABLE ROW LEVEL SECURITY;
ALTER TABLE system_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "allow_all" ON departments     FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "allow_all" ON employees       FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "allow_all" ON leave_requests  FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "allow_all" ON attendance      FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "allow_all" ON salary_records  FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "allow_all" ON system_settings FOR ALL USING (true) WITH CHECK (true);

-- supabase_schedule.sql 中的 shift_types / schedules / shift_swap_requests / schedule_periods
-- 也都是 ENABLE RLS + allow_all。
-- supabase_attendance_v2_batch_a/b/c.sql 沒寫 RLS(預設沿用 prod 設定 / 既存的 allow_all)。
```

> RLS 安全模型實際上**寫在 application layer**(`lib/auth.js` requireAuth/requireRole + `lib/auth-scope.js` resolveAuthScopeWithDeptIds + `lib/roles.js` BACKOFFICE_ROLES)、不是 DB 層級。設計理由見 `docs/rls-and-auth-design-v1.md`。

---

## 3. 既有薪資相關檔案盤點

### 3.1 後端(api/lib)

| 檔案 | 行數 | 摘要 |
|---|---|---|
| `api/salary/index.js` | 198 | 雙路徑:legacy GET/POST(client-side 算 gross/net、舊欄位 bonus/overtime_pay)+ 新路徑 `?v=2` / `action=batch_v2`(用 lib/salary/calculator 完整重算) |
| `api/salary/[id].js` | 73 | PUT 白名單更新(_manual 欄位) + `?action=confirm` 轉 confirmed + `?action=pay` 轉 paid |
| `api/salary/_repo.js` | 250 | Supabase 注入式 repo(供 lib/salary/* 用):findEmployeeForSalary / listSalaryRecords / resetOvertimeMarkers / findApprovedOvertimePayRequests / markOvertimeRequestApplied / findPendingPenaltyRecords / markPenaltyRecordApplied / findAnnualRecordsForSettlement / findCompBalancesForSettlement / 等 22 個 method |
| `api/salary/recalculate.js` | 31 | POST 觸發單筆完整重算(走 lib/salary/calculator) |
| `api/salary-grade.js` | 115 | `/api/salary-grade` 職等級距 + `?_resource=insurance` 員工勞健保 settings + `&brackets=labor/health/pending` 級距表 / 待處理變動 |
| `lib/salary/calculator.js` | 251 | 月度薪資計算主流程(11 步)+ `computeGrossSalary` / `computeNetSalary` 雙向綁定 batch_c GENERATED 公式 |
| `lib/salary/attendance-bonus.js` | 45 | 全勤獎金套用(委派給 lib/attendance/bonus.js 算 deduction_rate) |
| `lib/salary/overtime-aggregator.js` | 55 | 撈 status='approved' + compensation_type='overtime_pay' 加總 estimated_pay、mark applied_to_salary_record_id |
| `lib/salary/penalty-applier.js` | 63 | 撈 pending penalty_records、只算 deduct_money / deduct_money_per_min,改 status='applied' |
| `lib/salary/settlement.js` | 99 | annual settlement 重算 + UPDATE annual_leave_records.settlement_amount;comp_expiry_payout 只讀(由 cron-comp-expiry.js 寫入) |
| `lib/attendance/bonus.js` | 116 | 三層加總全勤扣比:absent_days × per_day_rate + 影響全勤的請假 × per_day_rate + deduct_attendance_bonus_pct 累計;cap 1.0 |
| `lib/attendance/penalty.js` | 168 | 把 attendance event(late/early_leave/absent)套規則,生 attendance_penalty_records |
| `lib/overtime/pay-calc.js` | 113 | 加班費純函式:weekday / rest_day 前 2h × first_2h_rate + 後 2h × after_2h_rate;national_holiday 整段 × pay_multiplier;`getHourlyRate(monthly, base=240)` |
| `lib/leave/annual-rollover.js` | (TODO) | 既有「結算金額暫填 0、留 TODO Batch 9 由 lib/salary/settlement.js 算實際金額」(`L74`) |
| `api/annual-leaves/[id].js` | (TODO) | 同上、HR 手動 settle 時 reason 含 `(TODO Batch 9 amount)` |

### 3.2 前端

| 檔案 | 行數 | 摘要 |
|---|---|---|
| `public/salary.html` | 333 | HR 後台桌面版:月份選 + 18 欄薪資表(含 _auto / _manual 顏色區分)+ 編輯 modal(自動唯讀 + 手動可改 + 即時試算)+ 完整重算 / confirm / pay 按鈕 |
| `public/employee-salary.html` | 232 | 員工手機版薪資單:slip 形式列出收入項目 / 扣除項目 / 應發 / 實發,加班 / 補休失效 / 結算 / 懲處有 details 摺疊明細;走 `?v=2&employee_id=` 打 API |
| `public/insurance.html` | 837 | HR 勞健保管理:列表 + 單筆 modal(勞 / 健 / 勞退三 block)+ 批次 modal(auto / manual mode)+ 待確認的級距變動申請區塊 |
| `public/dashboard.html` | 498 | 總覽頁,有「薪資管理」quick card + 「本月薪資」stat 卡 + 「本月薪資概況」big card(下節貼) |

### 3.3 dashboard.html 中「薪資」相關 section(完整)

`public/dashboard.html` L91-95(quick card):
```html
<a class="quick-card" id="qc-salary" href="/salary.html">
  <div class="quick-icon">💰</div>
  <div class="quick-label">薪資管理</div>
  <div class="quick-sub"><span id="ql-salary-draft">—</span> 份待確認</div>
</a>
```

L103(stat 卡):
```html
<div class="stat-card purple" id="stat-salary-card">
  <div class="stat-label">本月薪資</div>
  <div class="stat-value" id="st-salary" style="font-size:20px">—</div>
  <div class="stat-hint">實發總額</div>
</div>
```

L121-125(本月薪資概況卡):
```html
<div class="card" id="card-salary-overview">
  <div class="section-title">本月薪資概況</div>
  <div id="salary-overview"><div style="color:var(--text-dim);font-size:13px">載入中…</div></div>
</div>
```

L222-232(applyRoleFilter — 非 HR 隱藏薪資 widget):
```js
async function applyRoleFilter() {
  const u = await waitForCurrentUser();
  const isHR = !!u && window.Roles?.isBackofficeRole(u);
  if (isHR) return;
  ['qc-leave', 'qc-employees', 'qc-salary', 'stat-salary-card', 'card-salary-overview']
    .forEach(id => {
      const el = document.getElementById(id);
      if (el) el.style.display = 'none';
    });
}
```

L249-275(loadDashboard 中 salaryData 拉取與 stat 計算):
```js
const [leaveStats, employeesAll, salaryData, todayAttAll] = await Promise.all([
  api('/api/leaves?stats=true'),
  api('/api/employees?status=active'),
  api(`/api/salary?v=2&year=${now.getFullYear()}&month=${now.getMonth()+1}`)
    .then(r => r.records || [])
    .catch(()=>[]),
  api(`/api/attendance?month=${ym}`).catch(()=>[]),
]);

// ...
const netTotal = salaryData.reduce((s,r)=>s+(r.net_salary||0),0);
const draftCount = salaryData.filter(r=>r.status==='draft').length;
document.getElementById('st-salary').textContent = netTotal > 0 ? '$'+netTotal.toLocaleString() : '—';
document.getElementById('ql-salary-draft').textContent = draftCount;
```

L329-349(本月薪資概況 render):
```js
const salEl = document.getElementById('salary-overview');
if (!salaryData.length) {
  salEl.innerHTML = `<div style="color:var(--text-dim);font-size:13px">本月尚無薪資資料<br><a href="/salary.html" style="color:var(--accent);font-size:13px">前往批次產生 →</a></div>`;
} else {
  const gross = salaryData.reduce((s,r)=>s+(r.gross_salary||0),0);
  const net   = salaryData.reduce((s,r)=>s+(r.net_salary||0),0);
  const paid  = salaryData.filter(r=>r.status==='paid').length;
  const confirmed = salaryData.filter(r=>r.status==='confirmed').length;
  const draft = salaryData.filter(r=>r.status==='draft').length;
  salEl.innerHTML = `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:14px">
      <div><div style="font-size:11px;color:var(--text-dim);margin-bottom:4px">應發總額</div><div style="font-family:'DM Mono',monospace;font-size:18px;font-weight:700;color:var(--text)">$${gross.toLocaleString()}</div></div>
      <div><div style="font-size:11px;color:var(--text-dim);margin-bottom:4px">實發總額</div><div style="font-family:'DM Mono',monospace;font-size:18px;font-weight:700;color:var(--accent2)">$${net.toLocaleString()}</div></div>
    </div>
    <div style="display:flex;gap:12px;font-size:13px">
      <span style="color:var(--text-dim)">草稿 <b style="color:var(--text)">${draft}</b></span>
      <span style="color:var(--text-dim)">已確認 <b style="color:var(--orange)">${confirmed}</b></span>
      <span style="color:var(--text-dim)">已發放 <b style="color:var(--green)">${paid}</b></span>
    </div>`;
}
```

`public/js/layout.js` L97-104(sidebar 薪資管理 group):
```js
{
  title: '薪資管理',
  items: [
    { page:'employee-salary', icon:'💵', label:'我的薪資', href:'/employee-salary.html' },
    { page:'salary',          icon:'💰', label:'薪資管理', href:'/salary.html', gate: isHRish },
    { page:'insurance',       icon:'🏥', label:'勞健保',   href:'/insurance.html', gate: isHRish },
  ]
},
```

---

## 4. 代表 Pattern 樣本

### 4.1 `api/employees/index.js`(複合 endpoint:多 resource 路由 + 部門合併 + auth scope)

```js
// api/employees/index.js — GET all / POST new
// Also handles: GET|POST|PUT|DELETE /api/departments (via ?_resource=departments)
// Also handles: POST /api/push (via ?_resource=push)
import { createClient } from '@supabase/supabase-js';
import { supabaseAdmin } from '../../lib/supabase.js';
import { requireAuth, requireRole } from '../../lib/auth.js';
import { BACKOFFICE_ROLES, isBackofficeRole } from '../../lib/roles.js';
import { syncDeptFields } from '../../lib/dept-sync.js';
import { addDeptName } from '../../lib/dept-name-mapper.js';
import { resolveAuthScopeWithDeptIds, makeDeptEmpIdsRepo } from '../../lib/auth-scope.js';

const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

// 同步 employees.is_manager。在 departments 表變動「之後」呼叫。
// oldManagerId / newManagerId 可為 null。
// Exported for testability; handler 內部使用 supabaseAdmin 預設值。
export async function syncDeptManagerFlag({ oldManagerId, newManagerId }, sb = supabaseAdmin) {
  if (oldManagerId === newManagerId) return;

  if (newManagerId) {
    await sb.from('employees')
      .update({ is_manager: true }).eq('id', newManagerId);
  }

  if (oldManagerId) {
    // 若原主管已無其他部門在帶,降級為一般員工
    const { count } = await sb.from('departments')
      .select('id', { count: 'exact', head: true })
      .eq('manager_id', oldManagerId);
    if (!count) {
      await sb.from('employees')
        .update({ is_manager: false }).eq('id', oldManagerId);
    }
  }
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── Web Push 推播(合併自 api/push.js)──────────────────────────────────
  if (req.query._resource === 'push') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const caller = await requireAuth(req, res);
    if (!caller) return;

    const { action } = req.body || {};
    if (action !== 'subscribe') {
      return res.status(400).json({ error: 'Only subscribe action is supported via HTTP' });
    }

    const { employee_id, subscription } = req.body;
    if (!employee_id || !subscription) {
      return res.status(400).json({ error: 'employee_id and subscription required' });
    }

    if (caller.id !== employee_id) {
      return res.status(403).json({ error: 'Cannot subscribe for another employee' });
    }

    const { error } = await supabaseAdmin.from('push_subscriptions').upsert([{
      id: 'PUSH_' + employee_id,
      employee_id,
      subscription: typeof subscription === 'string' ? subscription : JSON.stringify(subscription),
      updated_at: new Date().toISOString(),
    }], { onConflict: 'employee_id' });

    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ message: '已訂閱推播通知' });
  }

  // ── 組織圖 caller-aware filter ────────────────────────────────────────────
  // GET /api/orgchart(vercel.json rewrite → _resource=orgchart)
  // 角色:
  //   BACKOFFICE (hr/ceo/chairman/admin) → 全公司員工
  //   is_manager === true → chairman + ceo + hr/admin + 全公司主管 + caller 自己部門所有員工
  //   其他(一般員工)→ 403(前端應擋住、後端兜底)
  if (req.query._resource === 'orgchart') {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    const caller = await requireAuth(req, res);
    if (!caller) return;

    const isHR  = isBackofficeRole(caller);
    const isMgr = caller.is_manager === true;
    if (!isHR && !isMgr) return res.status(403).json({ error: 'Forbidden' });

    const ORG_FIELDS = 'id, name, position, avatar, role, dept_id, is_manager';
    const { data: all, error: eErr } = await supabaseAdmin
      .from('employees').select(ORG_FIELDS).eq('status', 'active');
    if (eErr) return res.status(500).json({ error: eErr.message });

    let employees = all || [];
    if (!isHR) {
      // 員工數小、in-memory filter(避免複雜 OR query)
      employees = employees.filter(e =>
        e.role === 'chairman' || e.role === 'ceo' ||
        e.role === 'hr'       || e.role === 'admin' ||
        e.is_manager === true ||
        (caller.dept_id && e.dept_id === caller.dept_id) ||
        e.id === caller.id // 防禦性、確保自己一定在
      );
    }

    const { data: depts, error: dErr } = await supabaseAdmin
      .from('departments').select('id, name, color').order('name');
    if (dErr) return res.status(500).json({ error: dErr.message });

    return res.status(200).json({ employees, departments: depts || [] });
  }

  // ── 部門管理(合併自 api/departments.js)─────────────────────────────────
  if (req.query._resource === 'departments') {
    if (req.method === 'GET') {
      const caller = await requireAuth(req, res);
      if (!caller) return;
      try {
        const { data: depts, error } = await supabaseAdmin
          .from('departments').select('*').order('name');
        if (error) return res.status(500).json({ error: error.message });

        const { data: emps } = await supabaseAdmin
          .from('employees').select('dept_id').eq('status', 'active');
        const countMap = {};
        (emps || []).forEach(e => { if (e.dept_id) countMap[e.dept_id] = (countMap[e.dept_id] || 0) + 1; });

        const managerIds = depts.map(d => d.manager_id).filter(Boolean);
        let managerMap = {};
        if (managerIds.length) {
          const { data: mgrs } = await supabaseAdmin
            .from('employees').select('id, name').in('id', managerIds);
          (mgrs || []).forEach(m => { managerMap[m.id] = m.name; });
        }

        return res.status(200).json(depts.map(d => ({
          ...d,
          emp_count:    countMap[d.id] || 0,
          manager_name: managerMap[d.manager_id] || null,
        })));
      } catch (e) {
        return res.status(500).json({ error: e.message });
      }
    }

    if (req.method === 'POST') {
      const caller = await requireRole(req, res, BACKOFFICE_ROLES);
      if (!caller) return;
      const { name, description, color, manager_id } = req.body;
      if (!name) return res.status(400).json({ error: '缺少部門名稱' });
      const id = 'D' + Date.now();
      const newManagerId = manager_id || null;
      const { error } = await supabaseAdmin.from('departments').insert([{
        id, name,
        description: description || '',
        color:       color || '#5B8DEF',
        manager_id:  newManagerId,
      }]);
      if (error) return res.status(500).json({ error: error.message });
      await syncDeptManagerFlag({ oldManagerId: null, newManagerId });
      return res.status(201).json({ id, message: '部門已建立' });
    }

    if (req.method === 'PUT') {
      const caller = await requireRole(req, res, BACKOFFICE_ROLES);
      if (!caller) return;
      const { id } = req.query;
      if (!id) return res.status(400).json({ error: '缺少 id' });
      const allowed = ['name', 'description', 'color', 'manager_id'];
      const update = {};
      allowed.forEach(k => { if (req.body[k] !== undefined) update[k] = req.body[k]; });

      const managerIdChanging = Object.prototype.hasOwnProperty.call(req.body, 'manager_id');
      let oldManagerId = null;
      if (managerIdChanging) {
        const { data: cur } = await supabaseAdmin.from('departments')
          .select('manager_id').eq('id', id).single();
        oldManagerId = cur?.manager_id || null;
      }

      const { error } = await supabaseAdmin.from('departments').update(update).eq('id', id);
      if (error) return res.status(500).json({ error: error.message });

      if (managerIdChanging) {
        await syncDeptManagerFlag({ oldManagerId, newManagerId: req.body.manager_id || null });
      }
      return res.status(200).json({ message: '已更新' });
    }

    if (req.method === 'DELETE') {
      const caller = await requireRole(req, res, BACKOFFICE_ROLES);
      if (!caller) return;
      const { id } = req.query;
      if (!id) return res.status(400).json({ error: '缺少 id' });

      const { data: dept } = await supabaseAdmin
        .from('departments').select('manager_id').eq('id', id).single();
      if (!dept) return res.status(404).json({ error: '找不到部門' });

      const { data: linked } = await supabaseAdmin
        .from('employees').select('id, status').eq('dept_id', id).limit(5);
      if (linked && linked.length > 0) {
        const activeCnt   = linked.filter(e => e.status === 'active').length;
        const inactiveCnt = linked.filter(e => e.status !== 'active').length;
        const detail = activeCnt > 0
          ? `該部門仍有 ${activeCnt} 位在職員工`
          : `該部門有 ${inactiveCnt} 位歷史員工資料、無法刪除(可改名替代)`;
        return res.status(409).json({ error: detail });
      }

      const { error } = await supabaseAdmin.from('departments').delete().eq('id', id);
      if (error) return res.status(500).json({ error: error.message });
      await syncDeptManagerFlag({ oldManagerId: dept.manager_id || null, newManagerId: null });
      return res.status(200).json({ message: '已刪除' });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ── 員工列表 GET ─────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    const caller = await requireAuth(req, res);
    if (!caller) return;
    const { status, dept, dept_id, search } = req.query;

    // 員工互看用 16 欄位白名單(排除薪資/個資/系統欄位);後台 (hr/admin/ceo/chairman) 看全欄位
    const PUBLIC_FIELDS = 'id, emp_no, name, dept_id, position, role, is_manager, status, avatar, email, phone, hire_date, manager_id, employment_type, birth_date';
    const cols = isBackofficeRole(caller) ? '*' : PUBLIC_FIELDS;

    // C0-5a JOIN departments 補 dept_name
    const colsWithDept = (cols === '*') ? '*, departments(name)' : `${cols}, departments(name)`;
    let q = supabaseAdmin.from('employees').select(colsWithDept).order('name');
    if (status) q = q.eq('status', status);
    if (dept_id) q = q.eq('dept_id', dept_id);
    if (search) q = q.or(`name.ilike.%${search}%,email.ilike.%${search}%`);

    // Phase 2:row-level scope filter(取代既有「無 row filter」、防主管 / 員工看全公司)
    // 員工本人 / 主管本部門 / HR 全部。?_resource=orgchart 已 caller-aware、不走此分支。
    const scope = await resolveAuthScopeWithDeptIds(caller, 'selfOrDept', makeDeptEmpIdsRepo(supabaseAdmin));
    if (scope.mode === 'self') {
      q = q.eq('id', scope.selfId);
    } else if (scope.mode === 'dept') {
      q = q.in('id', [scope.selfId, ...(scope.deptEmpIds || [])]);
    }
    // mode='all' 不加 filter

    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    addDeptName(data);
    return res.status(200).json(data);
  }

  // ── 新增員工 POST ────────────────────────────────────────────────────────
  if (req.method === 'POST') {
    const caller = await requireRole(req, res, BACKOFFICE_ROLES);
    if (!caller) return;
    const body = { ...req.body };
    const id = 'E' + Date.now();

    if (!body.emp_no && body.hire_date) {
      const empType = body.employment_type === 'part_time' ? '02' : '01';
      const d  = new Date(body.hire_date);
      const yy = String(d.getFullYear()).slice(-2);
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      const base = empType + yy + mm + dd;

      const { data: existing } = await supabaseAdmin
        .from('employees').select('emp_no').like('emp_no', base + '%');
      const taken = new Set((existing || []).map(e => e.emp_no));

      if (!taken.has(base)) {
        body.emp_no = base;
      } else {
        let suffix = '';
        for (let i = 0; i < 26; i++) {
          const candidate = base + String.fromCharCode(65 + i);
          if (!taken.has(candidate)) { suffix = String.fromCharCode(65 + i); break; }
        }
        body.emp_no = base + suffix;
      }
    }

    await syncDeptFields(supabaseAdmin, body);
    // 預設 annual_leave_seniority_start = hire_date(跟 migration backfill 邏輯一致)
    if (!body.annual_leave_seniority_start && body.hire_date) {
      body.annual_leave_seniority_start = body.hire_date;
    }
    const { error } = await supabaseAdmin.from('employees').insert([{ id, ...body }]);
    if (error) return res.status(500).json({ error: error.message });

    let authEmail = null;
    if (SUPABASE_SERVICE_KEY) {
      try {
        const adminClient = createClient(process.env.SUPABASE_URL, SUPABASE_SERVICE_KEY);
        authEmail = body.email || `${body.emp_no || id}@chuwa.hr`;
        const { data: authData, error: authError } = await adminClient.auth.admin.createUser({
          email: authEmail,
          password: '123456',
          email_confirm: true,
          user_metadata: { name: body.name, emp_no: body.emp_no || id },
        });
        if (authError) {
          console.warn('[Auth] 建立帳號失敗:', authError.message);
          authEmail = null;
        } else if (authData?.user?.id) {
          await supabaseAdmin.from('employees')
            .update({ auth_user_id: authData.user.id })
            .eq('id', id);
        }
      } catch (e) {
        console.warn('[Auth] 例外錯誤:', e.message);
        authEmail = null;
      }
    }

    return res.status(201).json({ id, emp_no: body.emp_no, auth_email: authEmail, message: '員工已建立' });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
```

### 4.2 `lib/leave/balance.js` 純函式 + `tests/leave-balance.test.js` vitest

#### 4.2.1 lib

```js
// lib/leave/balance.js — 特休餘額查詢與異動(純函式 + repo 注入式)
//
// 對應設計文件:docs/attendance-system-design-v1.md §4.3.3 / §4.3.5
// 對應實作計畫:docs/attendance-system-implementation-plan-v1.md §7.4
//
// 重要單位約定:
//   annual_leave_records 用 days(NUMERIC 4,1)
//   leave_balance_logs.hours_delta 統一存「小時」(NUMERIC 5,2)
//   annual 的 hours_delta 換算規則:days × 8(1 工作日 = 8 工時)
//   呼叫端讀 logs 時若 balance_type='annual' 要除以 8 還原 days
//
// 併發控制:annual_leave_records 不存 version 欄位,改用樂觀鎖
// (UPDATE WHERE used_days = 原值,失敗 → 重試或回 CONCURRENT_UPDATE 錯誤)。
// 對應 supabase repo 在 API handler 內實作 lockAndIncrementUsedDays。

const HOURS_PER_DAY = 8;

/**
 * Repo 介面契約:
 *   findActiveAnnualRecord(employee_id): Promise<row | null>
 *     找該員工 status='active' 的 annual_leave_records(理論上同時只有一筆)
 *   lockAndIncrementUsedDays({ record_id, delta_days, allow_negative })
 *     原子更新 used_days(透過樂觀鎖實作),回 { ok, record? , reason? }
 *     reason: 'INSUFFICIENT_BALANCE' / 'NEGATIVE_BALANCE' / 'CONCURRENT_UPDATE' / 'NOT_FOUND'
 *   insertBalanceLog(row): 寫 leave_balance_logs
 */

export async function getAnnualBalance(repo, employee_id) {
  if (!repo || typeof repo.findActiveAnnualRecord !== 'function') {
    throw new Error('repo.findActiveAnnualRecord is required');
  }
  if (!employee_id) throw new Error('employee_id required');

  const rec = await repo.findActiveAnnualRecord(employee_id);
  if (!rec) {
    return {
      has_record: false,
      legal_days: 0, granted_days: 0, used_days: 0, remaining_days: 0,
      period_start: null, period_end: null,
    };
  }
  const granted = Number(rec.granted_days);
  const used    = Number(rec.used_days);
  return {
    has_record: true,
    record_id: rec.id,
    legal_days:     Number(rec.legal_days),
    granted_days:   granted,
    used_days:      used,
    remaining_days: Math.max(0, granted - used),
    period_start:   rec.period_start,
    period_end:     rec.period_end,
    status:         rec.status,
  };
}

export async function deductAnnualLeave(repo, { employee_id, days, leave_request_id, changed_by, reason }) {
  requireRepo(repo, ['findActiveAnnualRecord', 'lockAndIncrementUsedDays', 'insertBalanceLog']);
  if (!employee_id)            throw new Error('employee_id required');
  if (!changed_by)             throw new Error('changed_by required');
  if (!Number.isFinite(+days) || +days <= 0) throw new Error('days must be positive number');

  const rec = await repo.findActiveAnnualRecord(employee_id);
  if (!rec) {
    return { ok: false, reason: 'NO_ACTIVE_RECORD' };
  }

  const r = await repo.lockAndIncrementUsedDays({
    record_id: rec.id, delta_days: +days, allow_negative: false,
  });
  if (!r.ok) return r;

  await repo.insertBalanceLog({
    employee_id,
    balance_type: 'annual',
    annual_record_id: rec.id,
    comp_record_id: null,
    leave_request_id: leave_request_id || null,
    change_type: 'use',
    hours_delta: -(+days) * HOURS_PER_DAY, // 扣減 → 負值
    changed_by,
    reason: reason || null,
  });
  return { ok: true, record: r.record };
}

// ... refundAnnualLeave / deductCompTime / refundCompTime 同樣 pattern,僅截 export 介面 ...
export { HOURS_PER_DAY };

function requireRepo(repo, methods) {
  if (!repo) throw new Error('repo required');
  for (const m of methods) {
    if (typeof repo[m] !== 'function') throw new Error(`repo.${m} is required`);
  }
}
```

#### 4.2.2 vitest 對應測試

```js
import { describe, it, expect, vi } from 'vitest';
import {
  getAnnualBalance, deductAnnualLeave, refundAnnualLeave,
} from '../lib/leave/balance.js';

function makeRepo(over = {}) {
  return {
    findActiveAnnualRecord: vi.fn().mockResolvedValue(null),
    lockAndIncrementUsedDays: vi.fn().mockResolvedValue({ ok: true, record: { id: 1, used_days: 1 } }),
    insertBalanceLog: vi.fn().mockResolvedValue({ id: 100 }),
    ...over,
  };
}

const activeRec = (over = {}) => ({
  id: 1,
  employee_id: 'E001',
  period_start: '2026-04-01',
  period_end: '2027-03-31',
  legal_days: 14,
  granted_days: 14,
  used_days: 0,
  status: 'active',
  ...over,
});

describe('getAnnualBalance', () => {
  it('沒 active record → has_record:false, all 0', async () => {
    const r = await getAnnualBalance(makeRepo(), 'E001');
    expect(r.has_record).toBe(false);
    expect(r.legal_days).toBe(0);
    expect(r.remaining_days).toBe(0);
  });

  it('有 active record → 計算 remaining', async () => {
    const repo = makeRepo({
      findActiveAnnualRecord: vi.fn().mockResolvedValue(activeRec({ used_days: 3 })),
    });
    const r = await getAnnualBalance(repo, 'E001');
    expect(r.has_record).toBe(true);
    expect(r.legal_days).toBe(14);
    expect(r.granted_days).toBe(14);
    expect(r.used_days).toBe(3);
    expect(r.remaining_days).toBe(11);
  });

  it('used > granted(防呆)→ remaining 取 0', async () => {
    const repo = makeRepo({
      findActiveAnnualRecord: vi.fn().mockResolvedValue(activeRec({ used_days: 99 })),
    });
    const r = await getAnnualBalance(repo, 'E001');
    expect(r.remaining_days).toBe(0);
  });

  it('repo 缺 method → 拒絕', async () => {
    await expect(getAnnualBalance({}, 'E001')).rejects.toThrow(/findActiveAnnualRecord/);
  });

  it('缺 employee_id → 拒絕', async () => {
    await expect(getAnnualBalance(makeRepo(), null)).rejects.toThrow(/employee_id/);
  });
});

describe('deductAnnualLeave', () => {
  it('成功扣減 1 天 → log hours_delta = -8', async () => {
    const repo = makeRepo({
      findActiveAnnualRecord: vi.fn().mockResolvedValue(activeRec()),
    });
    const r = await deductAnnualLeave(repo, {
      employee_id: 'E001', days: 1, leave_request_id: 'L1', changed_by: 'HR1',
    });
    expect(r.ok).toBe(true);
    expect(repo.lockAndIncrementUsedDays).toHaveBeenCalledWith({
      record_id: 1, delta_days: 1, allow_negative: false,
    });
    expect(repo.insertBalanceLog).toHaveBeenCalled();
    const log = repo.insertBalanceLog.mock.calls[0][0];
    expect(log.balance_type).toBe('annual');
    expect(log.change_type).toBe('use');
    expect(log.hours_delta).toBe(-8); // 1 day * 8
    expect(log.annual_record_id).toBe(1);
    expect(log.leave_request_id).toBe('L1');
  });

  it('沒 active record → reason=NO_ACTIVE_RECORD,不寫 log', async () => {
    const repo = makeRepo();
    const r = await deductAnnualLeave(repo, {
      employee_id: 'E001', days: 1, changed_by: 'HR1',
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('NO_ACTIVE_RECORD');
    expect(repo.insertBalanceLog).not.toHaveBeenCalled();
  });

  it('餘額不足 → 不寫 log,回 lock 失敗 reason', async () => {
    const repo = makeRepo({
      findActiveAnnualRecord: vi.fn().mockResolvedValue(activeRec({ granted_days: 5, used_days: 4 })),
      lockAndIncrementUsedDays: vi.fn().mockResolvedValue({ ok: false, reason: 'INSUFFICIENT_BALANCE' }),
    });
    const r = await deductAnnualLeave(repo, {
      employee_id: 'E001', days: 3, changed_by: 'HR1',
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('INSUFFICIENT_BALANCE');
    expect(repo.insertBalanceLog).not.toHaveBeenCalled();
  });

  it('缺 changed_by → throw', async () => {
    await expect(deductAnnualLeave(makeRepo(), { employee_id: 'E001', days: 1 }))
      .rejects.toThrow(/changed_by/);
  });

  it('days 非正數 → throw', async () => {
    await expect(deductAnnualLeave(makeRepo(), { employee_id: 'E001', days: 0, changed_by: 'HR1' }))
      .rejects.toThrow();
    await expect(deductAnnualLeave(makeRepo(), { employee_id: 'E001', days: -1, changed_by: 'HR1' }))
      .rejects.toThrow();
  });
});

describe('refundAnnualLeave', () => {
  it('退還 0.5 天 → log hours_delta = +4', async () => {
    const repo = makeRepo({
      findActiveAnnualRecord: vi.fn().mockResolvedValue(activeRec({ used_days: 3 })),
    });
    const r = await refundAnnualLeave(repo, {
      employee_id: 'E001', days: 0.5, leave_request_id: 'L1', changed_by: 'HR1',
    });
    expect(r.ok).toBe(true);
    const log = repo.insertBalanceLog.mock.calls[0][0];
    expect(log.change_type).toBe('cancel_use');
    expect(log.hours_delta).toBe(4);
  });

  it('lockAndIncrement 傳 negative delta', async () => {
    const repo = makeRepo({
      findActiveAnnualRecord: vi.fn().mockResolvedValue(activeRec({ used_days: 3 })),
    });
    await refundAnnualLeave(repo, {
      employee_id: 'E001', days: 1, changed_by: 'HR1',
    });
    expect(repo.lockAndIncrementUsedDays.mock.calls[0][0]).toEqual({
      record_id: 1, delta_days: -1, allow_negative: false,
    });
  });
});
```

> Pattern 觀察:`lib/*` 全部走「純函式 + repo 注入」 — repo 是 method bag、API handler 在 `_repo.js` 裡 inject supabaseAdmin、test 用 `vi.fn()` mock 整個 repo。`lib/salary/*` 五檔(calculator / attendance-bonus / overtime-aggregator / penalty-applier / settlement)同樣模式、新薪資模組沿用即可。

### 4.3 `public/leave-admin.html`(HR 後台桌面頁、跟 layout.js 整合)

> ⚠ 522 行較長,本檔保留結構摘要 + 關鍵 pattern。完整檔請直接 `cat public/leave-admin.html`。

頁面骨架(L42-86):
- `<body data-page="leave-admin">` 給 sidebar 標 active
- `<aside class="sidebar" id="sidebar"></aside>` 由 `/js/layout.js` 動態注入
- main 區:filter-bar(status / type / search)+ table-wrap + 抽屜 modal

Auth gate(L166-177):
```js
async function load(retries = 0) {
  if (!window.api || !window.currentUser) {
    if (retries < 25) return setTimeout(()=>load(retries+1), 200);
    return;
  }
  const u = window.currentUser;
  const allowed = u && (u.is_manager === true || isElevated(u));
  if (u && !allowed) {
    document.getElementById('main-content').style.display = 'none';
    document.getElementById('gate-blocked').style.display = '';
    return;
  }
  ...
}
```

Dept-scope filter(L138-164,純主管限本部門 stop-gap):
```js
let myDeptEmpIds = null;
async function waitForCurrentUser(maxMs = 5000) {
  const step = 100;
  for (let i = 0; i < maxMs / step; i++) {
    if (window.currentUser) return window.currentUser;
    await new Promise(r => setTimeout(r, step));
  }
  return null;
}
async function loadDeptScope() {
  const u = await waitForCurrentUser();
  if (!u) { myDeptEmpIds = new Set(); return; }
  if (isElevated(u)) { myDeptEmpIds = null; return; }
  const deptId = u.dept_id;
  if (!deptId) { myDeptEmpIds = new Set(); return; }
  try {
    const emps = await window.api('/api/employees?status=active');
    myDeptEmpIds = new Set((emps || []).filter(e => e.dept_id === deptId).map(e => e.id));
  } catch (_) { myDeptEmpIds = new Set(); }
}
function inScope(empId) { return myDeptEmpIds === null || myDeptEmpIds.has(empId); }
```

Stage-aware actor 權限判定(L386-432,Phase 2.x 嚴格 spec):
```js
const isExpiredPending = l.proof_status === 'expired'
                          && (stage === 'pending_mgr' || stage === 'pending_ceo');
const canTerminateNow  = isExpiredPending && isHR(u);

const isSelfReview     = u.id === l.employee_id;
const isSameDeptMgr    = u.is_manager === true && u.dept_id && l.employee_dept_id
                         && u.dept_id === l.employee_dept_id;
const isCeoOrChairman2 = u.role === 'ceo' || u.role === 'chairman';
const canApproveMgr    = stage === 'pending_mgr' && isSameDeptMgr     && !isSelfReview;
const canApproveCeo    = stage === 'pending_ceo' && isCeoOrChairman2  && !isSelfReview;
const canApproveAny    = (canApproveMgr || canApproveCeo) && !isExpiredPending;
const canArchiveNow    = isHR(u) && l.status === 'approved';
```

Decision PUT call(L469-488):
```js
async function onApprove() {
  if (!confirm(...)) return;
  const body = { decision: 'approve' };
  if (overrideRow.style.display !== 'none' && document.getElementById('f-override-check').checked) {
    const reason = document.getElementById('f-override-reason').value.trim();
    if (!reason) { toast('Override 原因必填','error'); return; }
    body.override_reason = reason;
  }
  try {
    const r = await api(`/api/leaves/${encodeURIComponent(currentLeave.id)}`, {
      method: 'PUT', body: JSON.stringify(body),
    });
    if (r && r.ok === false) { toast('核准失敗:'+(r.reason||r.error||'unknown'), 'error'); return; }
    toast('已核准');
    closeModal();
    await load();
  } catch(e) { toast('核准失敗:'+e.message, 'error'); }
}
```

底部 boilerplate(L516-521):
```html
<script src="/js/roles.js"></script>
<script src="/js/utils.js"></script>
<script src="/js/layout.js"></script>
<script src="/js/pwa.js"></script>
<script>PWA.init();</script>
```

### 4.4 `public/employee-leave.html`(員工 mobile self-bootstrap pattern)

整體 952 行,但 self-bootstrap 模式集中在 head(無 `/js/layout.js`)+ 底端 IIFE。

頁面骨架(L1-15):無 sidebar、`<body>` 直接掛 `.mobile-app` 容器(max-width:430px)、不依賴 layout.js。

Self-bootstrap script header(L275-280):
```html
<script>
const SUPABASE_URL      = 'https://scsgqxixmbompnoypuuw.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGc...VgSmDysli7e_w8lvsdp3p_VA8';   // anon key、與 layout.js 同
const _sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

let currentUser = null, API = '';
let allLeaves = [], currentFilter = '';
let selectedFile = null;
```

自帶 `apiFetch` helper(無 `window.api`):
```js
async function apiFetch(path, opts={}) {
  const { data: { session } } = await _sb.auth.getSession();
  const res = await fetch(API + path, {
    headers:{'Content-Type':'application/json',...(session?{'Authorization':`Bearer ${session.access_token}`}:{})},
    ...opts
  });
  if (!res.ok) { const e=await res.json().catch(()=>({})); throw new Error(e.error||`${res.status}`); }
  return res.json();
}
```

底部 IIFE bootstrap(L930-945):
```js
(async () => {
  API = (location.hostname==='localhost'||location.hostname==='127.0.0.1') ? 'http://localhost:3000' : '';
  const { data: { session } } = await _sb.auth.getSession();
  if (!session) { window.location.href = '/login.html'; return; }
  try { currentUser = await apiFetch('/api/employees/me'); }
  catch(e) { window.location.href = '/login.html'; return; }

  const today = new Date().toISOString().split('T')[0];
  document.getElementById('f-start').value = today;
  document.getElementById('f-end').value   = today;

  await Promise.all([loadLeaveTypes(), loadLeaves()]);
})();
</script>

<script src="/js/utils.js"></script>
<script src="/js/pwa.js"></script>
<script>PWA.init();</script>
```

> Pattern 對比:
> - 桌面 HR 頁(salary.html / leave-admin.html / insurance.html / dashboard.html)走 `/js/layout.js` + `window.api` + `window.currentUser`,sidebar 由 layout.js 統一注入。
> - 員工手機頁(employee-app.html / employee-leave.html / **employee-salary.html** / employee-profile.html / employee-approvals.html)走 self-bootstrap、自帶 `apiFetch` + `_sb` + `currentUser` 區域變數,底端 mobile-bottom-nav 自己寫;新薪資模組若要寫員工手機頁,沿用 employee-salary.html 已建立的版型。

### 4.5 `vercel.json`

```json
{
  "version": 2,
  "rewrites": [
    {
      "source": "/api/salary/batch",
      "destination": "/api/salary/index?_action=batch"
    },
    {
      "source": "/api/departments",
      "destination": "/api/employees?_resource=departments"
    },
    {
      "source": "/api/orgchart",
      "destination": "/api/employees?_resource=orgchart"
    },
    {
      "source": "/api/push",
      "destination": "/api/employees?_resource=push"
    },
    {
      "source": "/api/announcements",
      "destination": "/api/announcements"
    },
    {
      "source": "/announcements",
      "destination": "/public/announcements.html"
    },
    {
      "source": "/announcement-admin",
      "destination": "/public/announcement-admin.html"
    },
    {
      "source": "/",
      "destination": "/public/login.html"
    },
    {
      "source": "/dashboard",
      "destination": "/public/dashboard.html"
    },
    {
      "source": "/leave",
      "destination": "/public/leave.html"
    },
    {
      "source": "/attendance",
      "destination": "/public/attendance.html"
    },
    {
      "source": "/employees",
      "destination": "/public/employees.html"
    },
    {
      "source": "/staff-table",
      "destination": "/employees.html"
    },
    {
      "source": "/calendar",
      "destination": "/public/calendar.html"
    },
    {
      "source": "/salary",
      "destination": "/public/salary.html"
    },
    {
      "source": "/api/insurance",
      "destination": "/api/salary-grade?_resource=insurance"
    },
    {
      "source": "/api/salary-grade",
      "destination": "/api/salary-grade"
    },
    {
      "source": "/api/schedules",
      "destination": "/api/schedules/index"
    },
    {
      "source": "/api/shift-types",
      "destination": "/api/schedules/index?_resource=shift_types"
    },
    {
      "source": "/api/shift-types/:id",
      "destination": "/api/schedules/index?_resource=shift_types_item&id=:id"
    },
    {
      "source": "/api/auth",
      "destination": "/api/auth"
    },
    {
      "source": "/api/attendance/today",
      "destination": "/api/attendance/index?_action=today"
    },
    {
      "source": "/api/approvals",
      "destination": "/api/approvals"
    },
    {
      "source": "/api/attendance/manual",
      "destination": "/api/attendance/index"
    },
    {
      "source": "/api/attendance/punch",
      "destination": "/api/attendance/index?_action=punch"
    },
    {
      "source": "/api/calendar",
      "destination": "/api/calendar/index"
    },
    {
      "source": "/((?!api/).*)",
      "destination": "/public/$1"
    }
  ],
  "headers": [
    {
      "source": "/api/(.*)",
      "headers": [
        { "key": "Access-Control-Allow-Origin",  "value": "*" },
        { "key": "Access-Control-Allow-Methods", "value": "GET,POST,PUT,DELETE,OPTIONS" },
        { "key": "Access-Control-Allow-Headers", "value": "Content-Type,Authorization" }
      ]
    },
    {
      "source": "/sw.js",
      "headers": [
        { "key": "Service-Worker-Allowed", "value": "/" },
        { "key": "Cache-Control",          "value": "no-cache" }
      ]
    }
  ],
  "crons": [
    { "path": "/api/cron-absence-detection",     "schedule": "15 16 * * *" },
    { "path": "/api/cron-schedule-lock",         "schedule": "30 16 * * *" },
    { "path": "/api/cron-comp-expiry",           "schedule": "0 17 * * *" },
    { "path": "/api/cron-comp-expiry-warning",   "schedule": "0 18 * * *" },
    { "path": "/api/cron-annual-leave-rollover", "schedule": "0 19 * * *" },
    { "path": "/api/cron-leave-proof-expiry",    "schedule": "0 20 * * *" },
    { "path": "/api/cron-schedule-reminder",     "schedule": "0 1 26 * *" }
  ]
}
```

> Vercel free tier 12 functions limit 已到頂(commit 2036646 「merge to exactly 12 serverless functions」),`api/salary-grade.js` 同時服務 `/api/salary-grade` 與 `/api/insurance`、`api/employees/index.js` 服務 `/api/orgchart` / `/api/departments` / `/api/push`。新薪資 endpoint 要先確認不超過 12 functions、否則要合併或升級方案。

### 4.6 `package.json`

```json
{
  "name": "hr-system",
  "version": "2.0.0",
  "description": "人資管理系統 — 完整版",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vercel dev",
    "build": "echo 'static + serverless, no build step'",
    "test": "vitest",
    "test:run": "vitest run"
  },
  "dependencies": {
    "@supabase/supabase-js": "^2.39.0",
    "web-push": "^3.6.7"
  },
  "engines": {
    "node": "24.x"
  },
  "devDependencies": {
    "sharp": "^0.34.5",
    "vitest": "^4.1.5"
  }
}
```

> Stack:Vercel(serverless / static)+ Supabase(Postgres + Auth)+ vanilla JS frontend(沒打包、沒 build step、沒 framework)。新薪資模組沿用此 stack。

### 4.7 `public/js/roles.js`

```js
// public/js/roles.js — 前端權限判定工具(掛在 window.Roles)
// 與 lib/roles.js 同語意。在會用到的 HTML 頁面於 layout.js 之前載入:
//   <script src="/js/roles.js"></script>
(function () {
  const BACKOFFICE = ['hr', 'ceo', 'chairman', 'admin'];

  window.Roles = {
    canManageAuthAccounts(u) {
      return !!u && ['hr', 'chairman', 'admin'].includes(u.role);
    },

    canAccessBackoffice(u) {
      if (!u) return false;
      if (BACKOFFICE.includes(u.role)) return true;
      return u.is_manager === true;
    },

    isBackofficeRole(u) {
      return !!u && BACKOFFICE.includes(u.role);
    },

    canViewAllApprovals(u) {
      return !!u && BACKOFFICE.includes(u.role);
    },

    canEditApprovalConfig(u) {
      return !!u && ['hr', 'admin'].includes(u.role);
    },

    canManageAnnouncements(u) {
      return !!u && BACKOFFICE.includes(u.role);
    },

    canWriteDepartments(u) {
      return this.canAccessBackoffice(u);
    },

    isDepartmentManager(u) {
      return !!u && u.is_manager === true;
    },

    skipAttendanceBonus(e) {
      if (!e) return false;
      if (['ceo', 'chairman'].includes(e.role)) return true;
      return e.is_manager === true;
    },

    effectiveApprovalRole(u) {
      if (!u) return '';
      if (u.is_manager === true) return 'manager';
      return u.role || '';
    },

    ROLE_LABEL: {
      chairman: '董事長', ceo: '執行長', hr: '人資',
      admin: '管理員', employee: '員工',
    },
    ROLE_LABEL_WITH_MGR: {
      chairman: '董事長', ceo: '執行長', hr: '人資',
      admin: '管理員', employee: '員工', manager: '主管',
    },
  };
})();
```

### 4.8 `public/js/layout.js`

```js
// public/js/layout.js — 動態注入 Sidebar 和初始化 Auth
(async function() {
  const SUPABASE_URL      = 'https://scsgqxixmbompnoypuuw.supabase.co';
  const SUPABASE_ANON_KEY = 'eyJhbGc...VgSmDysli7e_w8lvsdp3p_VA8';
  const _sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  window._supabase = _sb;

  // Auth guard
  const { data: { session } } = await _sb.auth.getSession();
  if (!session) { window.location.href = '/login.html'; return; }

  // API base
  window.API = (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
    ? 'http://localhost:3000' : '';

  // API helper(帶 JWT)
  window.api = async (path, opts = {}) => {
    const { data: { session: s } } = await _sb.auth.getSession();
    const res = await fetch(window.API + path, {
      headers: { 'Content-Type':'application/json', ...(s ? {'Authorization':`Bearer ${s.access_token}`} : {}) },
      ...opts
    });
    if (!res.ok) { const e = await res.json().catch(()=>({})); throw new Error(e.error||`${res.status}`); }
    return res.json();
  };

  window.logout = async () => {
    await _sb.auth.signOut();
    localStorage.removeItem('preferred_version');
    location.href = '/login.html';
  };

  window.switchToMobile = () => {
    localStorage.setItem('preferred_version', 'mobile');
    location.href = '/employee-app.html';
  };

  // 取得目前登入員工資料
  let currentUser = null;
  try {
    const data = await window.api(`/api/employees/me`);
    currentUser = data;
    window.currentUser = data;
  } catch(e) { console.warn('無法取得使用者資料', e); }

  // 注入 Sidebar
  const page = document.body.dataset.page || '';
  const isHRish     = u => !!u && ['hr','admin','ceo','chairman'].includes(u.role);
  const isMgrOrHR   = u => !!u && (u.is_manager === true || ['hr','admin','ceo','chairman'].includes(u.role));
  const isMgrOrCEO  = u => !!u && (u.is_manager === true || ['ceo','chairman'].includes(u.role));
  const navGroups = [
    {
      title: '總覽',
      items: [
        { page:'dashboard',     icon:'🏠', label:'總覽',   href:'/dashboard.html', gate: isMgrOrHR },
        { page:'calendar',      icon:'📅', label:'行事曆', href:'/calendar.html' },
        { page:'announcements', icon:'📢', label:'公告欄', href:'/announcements.html', gate: isMgrOrHR },
      ]
    },
    {
      title: '人員管理',
      items: [
        { page:'employees',          icon:'👥', label:'員工資料',     href:'/employees.html', gate: u => window.Roles?.isBackofficeRole(u) },
        { page:'orgchart',           icon:'🗂️', label:'組織圖',       href:'/orgchart.html', gate: isMgrOrHR },
        { page:'departments',        icon:'🏢', label:'部門管理',     href:'/departments.html', gate: isHRish },
        { page:'resigned-archive',   icon:'📁', label:'離職員工檔案', href:'/resigned-archive.html', gate: isHRish },
        { page:'announcement-admin', icon:'📝', label:'公告管理',     href:'/announcement-admin.html', gate: u => window.Roles?.canManageAnnouncements(u) },
      ]
    },
    {
      title: '我的勤務',
      items: [
        { page:'attendance',        icon:'⏱️', label:'打卡',     href:'/attendance.html' },
        { page:'employee-schedule', icon:'🗓️', label:'我的排班', href:'/employee-schedule.html' },
        { page:'leave',             icon:'📋', label:'請假',     href:'/leave.html' },
        { page:'comp-time',         icon:'🌴', label:'補休',     href:'/comp-time.html' },
        { page:'overtime',          icon:'⏰', label:'加班申請', href:'/overtime.html' },
      ]
    },
    {
      title: '勤務管理',
      items: [
        { page:'leave-admin',              icon:'✅', label:'請假審批',     href:'/leave-admin.html',              gate: isMgrOrHR },
        { page:'schedule',                 icon:'📆', label:'排班管理',     href:'/schedule.html',                  gate: isMgrOrHR },
        { page:'schedule-templates',       icon:'🗓️', label:'班表範本',     href:'/schedule-templates.html',        gate: isMgrOrHR },
        { page:'shift-types-admin',        icon:'🎨', label:'班別管理',     href:'/shift-types-admin.html',         gate: isHRish },
        { page:'overtime-review',          icon:'👔', label:'加班審核',     href:'/overtime-review.html',          gate: isMgrOrCEO },
        { page:'attendance-admin',         icon:'🛠️', label:'打卡管理',     href:'/attendance-admin.html',         gate: isHRish },
        { page:'attendance-locations-admin', icon:'📍', label:'據點管理',   href:'/attendance-locations-admin.html', gate: isHRish },
        { page:'annual-leave-admin',       icon:'🏖️', label:'特休管理',     href:'/annual-leave-admin.html',       gate: isHRish },
        { page:'comp-time-admin',          icon:'🌅', label:'補休管理',     href:'/comp-time-admin.html',          gate: isHRish },
        { page:'overtime-admin',           icon:'⚙️', label:'加班管理',     href:'/overtime-admin.html',           gate: isHRish },
        { page:'attendance-penalty-admin', icon:'⚖️', label:'出勤獎懲後台', href:'/attendance-penalty-admin.html', gate: isHRish },
        { page:'holidays-admin',           icon:'🎌', label:'假日管理',     href:'/holidays-admin.html',           gate: isHRish },
      ]
    },
    {
      title: '薪資管理',
      items: [
        { page:'employee-salary', icon:'💵', label:'我的薪資', href:'/employee-salary.html' },
        { page:'salary',          icon:'💰', label:'薪資管理', href:'/salary.html', gate: isHRish },
        { page:'insurance',       icon:'🏥', label:'勞健保',   href:'/insurance.html', gate: isHRish },
      ]
    },
    {
      title: '行政管理',
      items: [
        { page:'approvals',      icon:'✅', label:'審批管理',  href:'/approvals.html', gate: isHRish },
        { page:'notifications',  icon:'🔔', label:'通知中心',  href:'/notifications.html' },
      ]
    },
  ];

  const sidebar = document.getElementById('sidebar');
  if (!sidebar) return;

  const userName = currentUser?.name || session.user.email.split('@')[0];
  const userRole = currentUser?.role === 'chairman' ? '董事長'
                 : currentUser?.role === 'ceo'      ? '執行長'
                 : currentUser?.role === 'admin'    ? '系統管理員'
                 : currentUser?.role === 'hr'       ? '人資專員'
                 : currentUser?.is_manager          ? '部門主管'
                 : '員工';
  const avatarChar = currentUser?.avatar || userName[0];

  const isAdmin = window.Roles?.canAccessBackoffice(currentUser);
  const visibleItem = n => {
    if (typeof n.gate === 'function') return n.gate(currentUser);
    if (n.adminOnly) return isAdmin;
    return true;
  };
  const navHTML = navGroups.map(g => {
    const visible = g.items.filter(visibleItem);
    if (visible.length === 0) return '';
    return `
    <div class="nav-section">
      <div class="nav-section-title">${g.title}</div>
      ${visible.map(n => `
        <a class="nav-item ${page === n.page ? 'active' : ''}" href="${n.href}">
          <span class="nav-icon">${n.icon}</span> ${n.label}
          ${n.page === 'notifications' ? `<span id="notif-badge" style="display:none;margin-left:auto;background:#F87171;color:#fff;border-radius:10px;min-width:18px;height:18px;font-size:10px;font-weight:700;display:flex;align-items:center;justify-content:center;padding:0 4px"></span>` : ''}
        </a>`).join('')}
    </div>`;
  }).join('');

  sidebar.innerHTML = `... (HTML template)`;

  // 載入未讀通知數量
  if (currentUser?.id) {
    try {
      const { data: unread, error } = await _sb
        .from('notifications')
        .select('id')
        .eq('employee_id', currentUser.id)
        .eq('is_read', false);
      if (!error) window.PWA?.updateBadge(unread?.length || 0);
    } catch(_) {}
  }
})();
```

---

## 5. 補充觀察

### 5.1 員工現有薪資相關欄位(對 employees 表)

從 SQL 與 code 反推、合計 7 個直接相關欄位:

| 欄位 | 型別 | 預設 | 來源 | 在哪用 |
|---|---|---|---|---|
| `base_salary` | NUMERIC(12,2) | 0 | supabase_setup.sql | salary calculator base、insurance bracket lookup |
| `extra_allowance` | NUMERIC(10,2) | 0 | supabase_extra_allowance.sql | salary_records.extra_allowance、insurance bracket lookup |
| `extra_allowance_note` | TEXT | '' | supabase_extra_allowance.sql | (純註記) |
| `attendance_bonus` | (drift) | — | code-only | 全勤獎金 base、salary_records.attendance_bonus_base |
| `grade_allowance` | (drift) | — | code-only | insurance bracket lookup |
| `manager_allowance` | (drift) | — | code-only | insurance bracket lookup |
| `has_insurance` | (drift) | — | code-only | insurance settings 判定(false=不投保) |

加上間接相關的:
- `employment_type` ('full_time'/'part_time')→ part_time 不領全勤、不投保
- `role` / `is_manager` → ceo/chairman 不領全勤(skipAttendanceBonus)
- `annual_leave_seniority_start` → 特休年資起算(影響 settlement 算法)
- `hire_date` → fallback 為年資起算

⚠ **drift 欄位**(repo SQL 沒、prod 一定有):
- 規劃新薪資模組時要先把這 4 個欄位寫進 migration、補成 idempotent ALTER ADD COLUMN IF NOT EXISTS
- 可考慮一併建 `supabase_known_drift_2026_05.sql` 的新版 / 或 supersede 它

### 5.2 git log 中薪資相關 commit

`git log --all --grep='salary|payroll|薪資|獎金|勞保|健保|insurance|allowance' -i` 共 65 筆,挑關鍵:

| Hash | 訊息 | 重要性 |
|---|---|---|
| `bbf525e` | feat(attendance): batch 9 - salary reconciliation | ★ batch 9 = salary v2 大改、calculator + _auto/_manual 上線 |
| `2c9fbea` | feat(attendance): batch 6 - comp-time system | ★ comp-time → comp_expiry_payout 餵 salary |
| `639589f` | fix(security): require auth on legacy GET /api/salary + migrate dashboard | ★ legacy GET 加 BACKOFFICE_ROLES gate |
| `a0c975e` | fix(employees): restrict salary and PII fields from non-backoffice users | ★ employees 16-field 白名單 |
| `c151bcc` | feat(orgchart): 主管視角支援自己分支 + 移除 detail panel 薪資洩漏 | ★ orgchart 不洩漏薪資 |
| `c47b887` | fix(dashboard): 非 HR 角色隱藏薪資 / 員工 / 請假審批入口卡 | dashboard applyRoleFilter |
| `b03ff35` | fix(sidebar): hide 部門管理/審批管理/勞健保 from non-HR roles | sidebar gate |
| `8a3d134` | feat(mobile): employee-salary 改 mobile layout | employee-salary.html mobile 版型 |
| `e790514` | fix: remove generated columns from salary insert | gross/net 不能 INSERT |
| `20b678e` | fix: correct attendance bonus logic and exclude CEO from insurance deduction | skipAttendanceBonus + 執行長無保 |
| `32d2dc8` | fix: remove attendance bonus for managers and part-time, rename bonus labels | 主管 / 兼職不領全勤 |
| `c3a4fdf` | fix: part-time salary calculated by hourly rate | 兼職時薪 |
| `1b56138` | feat: auto-detect insurance bracket change on salary update | employees PUT 自動觸發 insurance_change_request |
| `ae7de30` | feat: batch insurance settings with select all | insurance.html 批次 modal |
| `8d4878e` | feat: insurance management with labor and health insurance brackets | insurance v1 上線 |
| `21673d5` | feat: add extra_allowance field to employees and salary system | extra_allowance 上線 |
| `ebda326` | feat: add grade/level/allowance fields to employee profile | grade_allowance / manager_allowance(drift 起源) |
| `1765402` | feat: JOIN departments + dept_name to salary-grade/salary/approvals (C0-5a-3) | dept 名稱 cleanup |

### 5.3 TODO / FIXME 中提到薪資

| 位置 | 內容 |
|---|---|
| `lib/leave/annual-rollover.js:10` | `// (TODO Batch 9:由 lib/salary/settlement.js 算實際金額)` |
| `lib/leave/annual-rollover.js:74` | `reason: 'annual rollover ${today}: settle remaining ${remainingDays} days (TODO Batch 9 amount)'` |
| `api/annual-leaves/[id].js:7` | `// (TODO Batch 9 由 lib/salary/settlement.js 算)` |
| `api/annual-leaves/[id].js:72` | `reason: 'manual settle by HR (TODO Batch 9 amount)'` |
| `tests/leave-annual-rollover.test.js:67` | `expect(r.payout_total).toBe(0); // TODO Batch 9` |
| `tests/leave-annual-rollover.test.js:71` | `expect(updPatch.settlement_amount).toBe(0); // TODO Batch 9 換實際金額` |
| `public/annual-leave-admin.html:87` | `「⚠ 結算金額暫填 0(TODO Batch 9 由 lib/salary/settlement.js 計算實際金額)」` |
| `docs/attendance-system-implementation-plan-v1.md:781` | 規劃文寫:「結算金額由 lib/salary/settlement.js 計算(Batch 9 才實作)」 |
| `docs/attendance-system-implementation-plan-v1.md:889` | 「annual-rollover 結算金額暫填 0 + TODO(Batch 9 補)」 |
| `lib/attendance/rate.js:14` | `// TODO(績效模組):` (非薪資、但提及「績效模組」) |
| `docs/attendance-system-implementation-plan-v1.md:1312` | `// TODO: 績效模組實作時細部對齊` |

⚠ **觀察**:Batch 9(salary reconciliation)雖已 commit、但 `lib/leave/annual-rollover.js` 與 `api/annual-leaves/[id].js` 的「結算金額暫填 0」**TODO 還沒 close**。Salary calculator 在月度跑 batch_v2 時會由 `lib/salary/settlement.js:35-67` 重新計算 annual_records 的 settlement_amount 並 UPDATE 寫回 — 這條路是通的、但 rollover/manual settle 當下寫的 0 + 後續被 calculator 改寫的時間差,新薪資模組規劃時要確認是否仍是預期行為(commit message 是「Batch 9 - salary reconciliation」、不是「Batch 9 - rollover settlement amount」、可能有意保留 rollover 寫 0)。

---

## 6. 給規劃時的速查重點(自助式 TL;DR)

1. **新薪資模組要寫的 endpoint 不能多**:Vercel 12 functions 已到頂(commit 2036646)、要嘛走 `?_resource=` 子路由(像 `api/salary-grade.js` 同時當 `/api/insurance`)、要嘛先合併現有 endpoint。
2. **lib/salary/* 五檔已是「純函式 + repo 注入」結構**:calculator(主流程)、attendance-bonus、overtime-aggregator、penalty-applier、settlement。新增功能(例如:年終獎、預扣稅率表、二代健保 補充保費、colleagues 互助保險)沿用同模式即可、test 也按 leave-balance.test.js 範本寫。
3. **salary_records 已是 v2、_auto / _manual 雙軌制**:`gross_salary` / `net_salary` 是 GENERATED STORED column,任何 INSERT/UPDATE 都不能寫(repo upsert 會 strip)。新欄位要走「_auto(系統算)+ _manual(HR 改)+ _note」三件組,並更新 batch_c 的 GENERATED 公式 + `lib/salary/calculator.js:207-239` 的 computeGrossSalary / computeNetSalary 雙向綁定 case。
4. **Drift 風險**:employees 表有 4 個 prod-only 欄位(attendance_bonus / grade_allowance / manager_allowance / has_insurance)、加 5 張 prod-only table(labor / health / insurance_settings / insurance_change_requests / salary_grade)。動 schema 前先 dump prod、補成 migration、寫 verify SQL。
5. **權限模型**:後端用 `requireRole(req, res, BACKOFFICE_ROLES)` + `lib/auth-scope.js`;前端用 `window.Roles?.isBackofficeRole(u)` + sidebar gate。員工只能看自己薪資(走 `?employee_id=caller.id` filter、見 `api/salary/index.js:130-133`),HR/admin/ceo/chairman 看全部。
6. **Mobile vs Desktop pattern 不要混用**:HR 後台桌面頁掛 `/js/layout.js` + sidebar、員工手機頁 self-bootstrap 不要 sidebar、用自己的 mobile-bottom-nav。新增員工薪資頁複製 `employee-salary.html` 的 layout 即可。
7. **TODO Batch 9 結算金額尚未 close**:annual-rollover / annual-leaves manual settle 仍寫 0、預期被 calculator 月結時重算。新薪資模組若要動結算流程要確認此假設。

> 完。本檔可隨時刪除/重寫,不影響任何 source。
