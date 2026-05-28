# 薪資系統完整設計 — hr-system-v2

> 設計時間:2026-05-10
> 依據:勞基法、勞工保險條例、全民健康保險法、勞工退休金條例、性別工作平等法、所得稅法、各類所得扣繳率標準
> 範圍:基於 `docs/payroll-audit.md` 現況、補齊勞基法完整覆蓋
> 不動既有架構:salary_records v2 _auto/_manual 雙軌、lib/salary/* 純函式 + repo 注入、Vercel `?_resource=` 子路由、layout.js / mobile self-bootstrap 兩套版型

---

## 目錄

- [0. 設計原則](#0-設計原則)
- [1. Schema 設計](#1-schema-設計)
- [2. lib/salary/* 擴充](#2-libsalary-擴充)
- [3. API endpoint 配置](#3-api-endpoint-配置)
- [4. 前端頁](#4-前端頁)
- [5. 完整計算流程(14 步)](#5-完整計算流程14-步)
- [6. 匯入匯出設計](#6-匯入匯出設計)
- [7. 分階段提交計畫](#7-分階段提交計畫)
- [8. 風險清單與決策點](#8-風險清單與決策點)

---

## 0. 設計原則

1. **沿用、不重做**:既有 `salary_records` v2 / `lib/salary/*` 純函式 / `_auto`+`_manual`+`_note` 三件組 / GENERATED gross/net,本設計只**擴**不**改**核心結構。
2. **Vercel 12 functions 上限**:任何新 endpoint 都走 `?_resource=` 子路由、不另立檔。
3. **勞基法完整覆蓋**:本設計以「最完整薪資計算系統」為目標、補齊現況沒看到的所得稅扣繳 / 二代健保補充保費 / 勞退提繳明細 / 獎金分流 / 雇主成本影子計算 / payroll_periods 期間狀態機 / 匯入匯出工作流 / PDF 薪資單。
4. **drift 先補**:動新功能前、4 個 employees 欄位 + 5 張 prod-only table 必須先寫成 idempotent migration。
5. **Batch 9 TODO 先 close**:annual-rollover / manual settle 寫 0 的問題、不靠月結 calculator 重算改寫、當下就算對。
6. **改動前測試覆蓋**:沿用 `tests/leave-balance.test.js` / `tests/salary-calculator.test.js` 既有 vitest pattern。
7. **不 push prod 前 review**:每階段獨立 mergeable、跑 vitest 全綠、user 自己 review。

---

## 1. Schema 設計

### 1.1 補 drift(必做、優先順序最高)

新檔 `migrations/2026_05_10_payroll_drift_alignment.sql`,idempotent。

#### 1.1.1 employees 4 個欄位

```sql
ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS attendance_bonus  NUMERIC(10,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS grade_allowance   NUMERIC(10,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS manager_allowance NUMERIC(10,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS has_insurance     BOOLEAN       DEFAULT true;

COMMENT ON COLUMN employees.attendance_bonus  IS '全勤獎金 base 額度,缺勤按比例扣';
COMMENT ON COLUMN employees.grade_allowance   IS '職等加給,列入投保薪資';
COMMENT ON COLUMN employees.manager_allowance IS '主管加給,列入投保薪資';
COMMENT ON COLUMN employees.has_insurance     IS 'false = 不投保(執行長 / 專案合作 / 特殊情況)';
```

#### 1.1.2 5 張 prod-only table 寫進 repo

> ⚠ **以下 schema 為依 code 反推的「最低限度」結構**。實際 prod 欄位需先以下列指令 dump:
>
> ```bash
> # 從 prod 連線後跑,把結果貼進 migration
> psql $PROD_URL -c "\d labor_insurance_brackets"
> psql $PROD_URL -c "\d health_insurance_brackets"
> psql $PROD_URL -c "\d insurance_settings"
> psql $PROD_URL -c "\d insurance_change_requests"
> psql $PROD_URL -c "\d salary_grade"
> ```
>
> 確認後再寫成正式 migration。下面是合理推測的最小 schema:

```sql
-- 勞保級距表(政府每年公告)
CREATE TABLE IF NOT EXISTS labor_insurance_brackets (
  id                BIGSERIAL PRIMARY KEY,
  year              INTEGER NOT NULL,
  bracket_level     INTEGER NOT NULL,
  monthly_wage_min  NUMERIC(10,2) NOT NULL,
  monthly_wage_max  NUMERIC(10,2),               -- NULL 表「以上」
  insured_salary    NUMERIC(10,2) NOT NULL,      -- 投保薪資
  employee_premium  NUMERIC(10,2) NOT NULL,      -- 員工自付額(已含費率)
  company_premium   NUMERIC(10,2) NOT NULL,      -- 雇主自付額
  effective_from    DATE,
  effective_to      DATE,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(year, bracket_level)
);

-- 健保級距表(與勞保不同)
CREATE TABLE IF NOT EXISTS health_insurance_brackets (
  id                BIGSERIAL PRIMARY KEY,
  year              INTEGER NOT NULL,
  bracket_level     INTEGER NOT NULL,
  monthly_wage_min  NUMERIC(10,2) NOT NULL,
  monthly_wage_max  NUMERIC(10,2),
  insured_salary    NUMERIC(10,2) NOT NULL,
  employee_premium  NUMERIC(10,2) NOT NULL,
  company_premium   NUMERIC(10,2) NOT NULL,
  per_dependent     NUMERIC(10,2) NOT NULL,      -- 每位眷屬加收
  effective_from    DATE,
  effective_to      DATE,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(year, bracket_level)
);

-- 員工 × 級距(每個員工的當前投保狀態)
CREATE TABLE IF NOT EXISTS insurance_settings (
  id                       TEXT PRIMARY KEY,
  employee_id              TEXT NOT NULL UNIQUE REFERENCES employees(id),
  has_insurance            BOOLEAN DEFAULT true,
  -- 勞保
  labor_ins_bracket        INTEGER,
  labor_ins_employee       NUMERIC(10,2) DEFAULT 0,
  labor_ins_company        NUMERIC(10,2) DEFAULT 0,
  -- 健保
  health_ins_bracket       INTEGER,
  health_ins_employee      NUMERIC(10,2) DEFAULT 0,
  health_ins_company       NUMERIC(10,2) DEFAULT 0,
  health_ins_dependents    INTEGER DEFAULT 0,
  -- audit
  effective_from           DATE,
  effective_to             DATE,
  created_at               TIMESTAMPTZ DEFAULT NOW(),
  updated_at               TIMESTAMPTZ DEFAULT NOW()
);

-- 級距變動申請(薪資調整自動觸發)
CREATE TABLE IF NOT EXISTS insurance_change_requests (
  id                      TEXT PRIMARY KEY,
  employee_id             TEXT NOT NULL REFERENCES employees(id),
  reason                  TEXT,
  -- 變動前
  prev_labor_bracket      INTEGER,
  prev_health_bracket     INTEGER,
  -- 建議的新級距
  new_labor_bracket       INTEGER,
  new_health_bracket      INTEGER,
  triggered_by_salary     NUMERIC(10,2),         -- 觸發時的新薪資
  status                  TEXT DEFAULT 'pending'
                          CHECK (status IN ('pending','approved','rejected')),
  reviewed_by             TEXT REFERENCES employees(id),
  reviewed_at             TIMESTAMPTZ,
  created_at              TIMESTAMPTZ DEFAULT NOW()
);

-- 職等薪資級距表(本薪 + 職等加給對照)
CREATE TABLE IF NOT EXISTS salary_grade (
  id              TEXT PRIMARY KEY,
  grade           TEXT NOT NULL,                  -- 例 'A1' 'B2'
  grade_level     INTEGER,
  base_salary     NUMERIC(10,2) NOT NULL,
  grade_allowance NUMERIC(10,2) DEFAULT 0,
  description     TEXT,
  is_active       BOOLEAN DEFAULT true,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(grade, grade_level)
);
```

對應 `migrations-verify/verify_payroll_drift_alignment.sql`(沿用 v2 三段式 verify pattern):

```sql
-- 4 個 employees 欄位都存在
SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_name='employees'
  AND column_name IN ('attendance_bonus','grade_allowance','manager_allowance','has_insurance');
-- expect: 4 rows

-- 5 張 table 都存在
SELECT table_name FROM information_schema.tables
WHERE table_schema='public'
  AND table_name IN ('labor_insurance_brackets','health_insurance_brackets',
                     'insurance_settings','insurance_change_requests','salary_grade');
-- expect: 5 rows
```

### 1.2 close Batch 9 TODO

新檔 `migrations/2026_05_10_close_batch9_settlement.sql`(只是補 comment / 不改結構)+ 改 code:

- `lib/leave/annual-rollover.js:74`:把 `settlement_amount: 0` 改成呼叫 `lib/salary/settlement.js` 直接算
- `api/annual-leaves/[id].js:7-72`:同上、manual settle 當下算對
- `tests/leave-annual-rollover.test.js:67-71`:把 `expect(...).toBe(0)` 改成預期實際金額
- `public/annual-leave-admin.html:87`:刪 TODO 字樣
- `docs/attendance-system-implementation-plan-v1.md:781,889`:刪 TODO

### 1.3 salary_records 擴 19 欄

新檔 `migrations/2026_05_10_salary_records_expansion.sql`:

```sql
-- 獎金分流(取代 extra_allowance 集中存獎金的問題)
ALTER TABLE salary_records
  ADD COLUMN IF NOT EXISTS bonus_yearend          NUMERIC(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS bonus_festival         NUMERIC(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS bonus_performance      NUMERIC(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS bonus_other            NUMERIC(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS bonus_other_note       TEXT;

-- 法定扣項擴充
ALTER TABLE salary_records
  ADD COLUMN IF NOT EXISTS deduct_pension_voluntary    NUMERIC(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS deduct_supplementary_health NUMERIC(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS deduct_welfare_fund         NUMERIC(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS deduct_union_fee            NUMERIC(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS deduct_court_garnishment    NUMERIC(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS deduct_loan_repayment       NUMERIC(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS deduct_other                NUMERIC(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS deduct_other_note           TEXT;

-- snapshot 欄位(避免月中異動造成查表錯)
ALTER TABLE salary_records
  ADD COLUMN IF NOT EXISTS taxable_income_snapshot        NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS insured_salary_labor_snapshot  NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS insured_salary_health_snapshot NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS pension_wage_snapshot          NUMERIC(10,2);

-- 雇主負擔(內部成本、不發給員工)
ALTER TABLE salary_records
  ADD COLUMN IF NOT EXISTS employer_cost_labor        NUMERIC(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS employer_cost_health       NUMERIC(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS employer_cost_pension      NUMERIC(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS employer_cost_occupational NUMERIC(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS employer_cost_employment   NUMERIC(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS employer_cost_welfare      NUMERIC(10,2) NOT NULL DEFAULT 0;

-- 期間關聯
ALTER TABLE salary_records
  ADD COLUMN IF NOT EXISTS payroll_period_id TEXT REFERENCES payroll_periods(id);

-- audit 欄位(試算 / 審核 / 確認 / 發放)
ALTER TABLE salary_records
  ADD COLUMN IF NOT EXISTS calculated_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS calculated_by  TEXT REFERENCES employees(id),
  ADD COLUMN IF NOT EXISTS reviewed_by    TEXT REFERENCES employees(id),
  ADD COLUMN IF NOT EXISTS reviewed_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS finalized_by   TEXT REFERENCES employees(id),
  ADD COLUMN IF NOT EXISTS finalized_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS paid_by        TEXT REFERENCES employees(id),
  ADD COLUMN IF NOT EXISTS paid_at        TIMESTAMPTZ;

-- status 加 'pending_review' / 'locked'
ALTER TABLE salary_records DROP CONSTRAINT IF EXISTS salary_records_status_check;
ALTER TABLE salary_records ADD CONSTRAINT salary_records_status_check
  CHECK (status IN ('draft','calculating','pending_review','confirmed','paid','locked'));
```

#### 1.3.1 GENERATED 公式更新

```sql
-- 必須先 DROP 再 ADD(GENERATED 不能 ALTER)
ALTER TABLE salary_records DROP COLUMN gross_salary;
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
    -- 新加獎金 4 項
    + COALESCE(bonus_yearend, 0)
    + COALESCE(bonus_festival, 0)
    + COALESCE(bonus_performance, 0)
    + COALESCE(bonus_other, 0)
  ) STORED;

ALTER TABLE salary_records DROP COLUMN net_salary;
ALTER TABLE salary_records ADD COLUMN net_salary NUMERIC(12,2)
  GENERATED ALWAYS AS (
    base_salary + COALESCE(attendance_bonus_actual,0) + COALESCE(allowance,0)
    + COALESCE(extra_allowance,0)
    + COALESCE(overtime_pay_auto + overtime_pay_manual,0)
    + COALESCE(comp_expiry_payout,0) + COALESCE(holiday_work_pay,0)
    + COALESCE(settlement_amount,0)
    + COALESCE(bonus_yearend,0) + COALESCE(bonus_festival,0)
    + COALESCE(bonus_performance,0) + COALESCE(bonus_other,0)
    -- 既有扣項
    - COALESCE(deduct_absence,0) - COALESCE(deduct_labor_ins,0)
    - COALESCE(deduct_health_ins,0) - COALESCE(deduct_tax,0)
    - COALESCE(attendance_penalty_total,0)
    -- 新加扣項 7 項
    - COALESCE(deduct_pension_voluntary,0)
    - COALESCE(deduct_supplementary_health,0)
    - COALESCE(deduct_welfare_fund,0)
    - COALESCE(deduct_union_fee,0)
    - COALESCE(deduct_court_garnishment,0)
    - COALESCE(deduct_loan_repayment,0)
    - COALESCE(deduct_other,0)
  ) STORED;
```

> ⚠ DROP gross_salary / net_salary 在 prod 是 destructive。執行前要確認沒有 foreign key 依賴(目前看不到)。建議用三段式 migration:① ALTER 加新欄位 → ② 跑 verify SQL → ③ DROP/ADD GENERATED。

### 1.4 新表:`payroll_periods`

新檔 `migrations/2026_05_10_payroll_periods.sql`:

```sql
CREATE TABLE IF NOT EXISTS payroll_periods (
  id                       TEXT PRIMARY KEY,         -- 例 PP_2026_05
  year                     INTEGER NOT NULL,
  month                    INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),

  -- 期間定義
  period_start             DATE NOT NULL,
  period_end               DATE NOT NULL,
  attendance_cutoff_date   DATE,                     -- 出勤截止(通常該月最後一天)
  pay_date                 DATE,                     -- 預定發薪日(通常下月 5/10/15 號)

  -- 狀態機
  status                   TEXT NOT NULL DEFAULT 'draft'
                           CHECK (status IN ('draft','calculating','pending_review',
                                             'approved','paid','locked')),

  -- 統計 cache
  employee_count           INTEGER NOT NULL DEFAULT 0,
  gross_total              NUMERIC(15,2) NOT NULL DEFAULT 0,
  net_total                NUMERIC(15,2) NOT NULL DEFAULT 0,
  employer_cost_total      NUMERIC(15,2) NOT NULL DEFAULT 0,

  -- audit
  created_by               TEXT REFERENCES employees(id),
  created_at               TIMESTAMPTZ DEFAULT NOW(),
  calculated_at            TIMESTAMPTZ,
  reviewed_by              TEXT REFERENCES employees(id),
  reviewed_at              TIMESTAMPTZ,
  approved_by              TEXT REFERENCES employees(id),
  approved_at              TIMESTAMPTZ,
  paid_at                  TIMESTAMPTZ,
  locked_at                TIMESTAMPTZ,

  note                     TEXT,
  UNIQUE(year, month)
);

ALTER TABLE payroll_periods ENABLE ROW LEVEL SECURITY;
CREATE POLICY "allow_all" ON payroll_periods FOR ALL USING (true) WITH CHECK (true);
```

#### 1.4.1 狀態機 transition 規則

```
draft
  ↓ HR 按「跑試算」
calculating
  ↓ calculator batch 跑完(或失敗回 draft)
pending_review
  ↓ HR 改了任何 _manual 欄位 → 自動回 calculating
  ↓ 老闆按「審核通過」
approved
  ↓ HR 按「標記發放」
paid
  ↓ 月底 cron 自動 lock(或 HR 手動 lock)
locked  ←(不可再轉)
```

允許的回退:`approved → calculating`(老闆退回重算、需填 reason)。

### 1.5 新表:`tax_withholding_brackets`

新檔 `migrations/2026_05_10_tax_brackets.sql`:

```sql
CREATE TABLE IF NOT EXISTS tax_withholding_brackets (
  id                  TEXT PRIMARY KEY,
  year                INTEGER NOT NULL,

  -- 三種扣繳方式
  method              TEXT NOT NULL
                      CHECK (method IN ('table','fixed_5pct','non_resident')),

  -- 'table' 用:依扶養人數查級距
  marital_status      TEXT CHECK (marital_status IN ('single','married','any')),
  dependents_count    INTEGER,
  salary_min          NUMERIC(10,2),
  salary_max          NUMERIC(10,2),
  withholding_amount  NUMERIC(10,2),

  -- 'fixed_5pct' 用:薪資 ≥ threshold 改用固定 5%
  threshold_amount    NUMERIC(10,2),
  fixed_rate          NUMERIC(5,4),

  -- 'non_resident' 用:非居住者按 6% 或 18%
  non_resident_rate   NUMERIC(5,4),

  effective_from      DATE,
  effective_to        DATE,
  is_active           BOOLEAN DEFAULT true,
  created_at          TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(year, method, marital_status, dependents_count, salary_min)
);

-- 每個員工的扣繳偏好(多數人是 'table' / 已婚 / 0 扶養)
ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS tax_method        TEXT DEFAULT 'table'
                           CHECK (tax_method IN ('table','fixed_5pct','non_resident')),
  ADD COLUMN IF NOT EXISTS tax_marital       TEXT DEFAULT 'single'
                           CHECK (tax_marital IN ('single','married')),
  ADD COLUMN IF NOT EXISTS tax_dependents    INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tax_is_resident   BOOLEAN DEFAULT true;

ALTER TABLE tax_withholding_brackets ENABLE ROW LEVEL SECURITY;
CREATE POLICY "allow_all" ON tax_withholding_brackets FOR ALL USING (true) WITH CHECK (true);
```

> 級距資料來源:財政部「各類所得扣繳率標準」每年公告、HR 一次匯入。

### 1.6 新表:`pension_settings`

新檔 `migrations/2026_05_10_pension_settings.sql`:

```sql
CREATE TABLE IF NOT EXISTS pension_settings (
  id                TEXT PRIMARY KEY,
  employee_id       TEXT NOT NULL REFERENCES employees(id),

  -- 提繳工資(本工資 + 經常性給付,級距表跟勞保不同,但實務上多數公司用同一張)
  pension_wage      NUMERIC(10,2) NOT NULL,
  pension_grade     TEXT,

  -- 提繳率
  employer_rate     NUMERIC(4,3) NOT NULL DEFAULT 0.060,    -- 雇主強制 6%
  voluntary_rate    NUMERIC(4,3) NOT NULL DEFAULT 0.000,    -- 員工自願 0~6%

  -- cache
  employer_amount   NUMERIC(10,2),
  voluntary_amount  NUMERIC(10,2),

  effective_from    DATE NOT NULL,
  effective_to      DATE,

  created_by        TEXT REFERENCES employees(id),
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(employee_id, effective_from)
);

ALTER TABLE pension_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "allow_all" ON pension_settings FOR ALL USING (true) WITH CHECK (true);
```

> 為什麼獨立表、不塞 insurance_settings:
> - 勞退跟勞健保語意不同(退休金 vs 醫療 / 失業保險)
> - 員工自願率有自選需求、變動頻率不同
> - 投保工資跟勞健保投保薪資的級距表雖類似但法源不同(勞退條例 §14 vs 勞保條例 §13、§14)
> - 獨立表方便日後加入「個人專戶查詢」「累計提繳金額」等延伸功能

### 1.7 新表:`bonus_records`

新檔 `migrations/2026_05_10_bonus_records.sql`:

```sql
CREATE TABLE IF NOT EXISTS bonus_records (
  id                              TEXT PRIMARY KEY,
  employee_id                     TEXT NOT NULL REFERENCES employees(id),

  bonus_type                      TEXT NOT NULL CHECK (bonus_type IN (
    'yearend',           -- 年終獎金
    'festival_dragon',   -- 端午
    'festival_midautumn',-- 中秋
    'festival_lunar',    -- 春節
    'performance',       -- 績效
    'commission',        -- 業績 / 抽成
    'longevity',         -- 久任
    'special',           -- 特殊(如疫情補助、政府補貼分配)
    'wedding',           -- 結婚補助
    'funeral',           -- 喪葬補助(部分免稅)
    'maternity',         -- 生育補助
    'severance',         -- 資遣費
    'retirement',        -- 退休金
    'other'
  )),

  amount                          NUMERIC(10,2) NOT NULL,
  reason                          TEXT,

  -- 該獎金歸入哪個薪資月份
  payroll_year                    INTEGER NOT NULL,
  payroll_month                   INTEGER NOT NULL,

  -- 二代健保補充保費判定
  is_supplementary_health_subject BOOLEAN DEFAULT true,

  -- 課稅判定
  is_taxable                      BOOLEAN DEFAULT true,

  -- 列入 salary_records 的哪一欄(bonus_yearend / festival / performance / other)
  -- 由 lib/salary/bonus-aggregator.js 決定
  applied_column                  TEXT,
  applied_to_salary_record_id     TEXT REFERENCES salary_records(id),

  status                          TEXT DEFAULT 'pending'
                                  CHECK (status IN ('pending','approved','applied','cancelled')),

  created_by                      TEXT REFERENCES employees(id),
  created_at                      TIMESTAMPTZ DEFAULT NOW(),
  approved_by                     TEXT REFERENCES employees(id),
  approved_at                     TIMESTAMPTZ,

  note                            TEXT
);

CREATE INDEX IF NOT EXISTS idx_bonus_records_employee_period
  ON bonus_records(employee_id, payroll_year, payroll_month);
CREATE INDEX IF NOT EXISTS idx_bonus_records_status
  ON bonus_records(status) WHERE status IN ('pending','approved');

ALTER TABLE bonus_records ENABLE ROW LEVEL SECURITY;
CREATE POLICY "allow_all" ON bonus_records FOR ALL USING (true) WITH CHECK (true);
```

#### 1.7.1 bonus_type → salary_records 欄位對應(bonus-aggregator.js 邏輯)

| bonus_type | applied_column | 二代健保 | 課稅 |
|---|---|---|---|
| yearend | bonus_yearend | ✓ | ✓ |
| festival_* | bonus_festival | ✓ | ✓ |
| performance, commission, longevity | bonus_performance | ✓ | ✓ |
| special, severance, retirement | bonus_other | ✓ | 部分(retirement 有上限免稅) |
| wedding, maternity | bonus_other | ✓ | ✓ |
| funeral | bonus_other | ✓ | 部分(NT$10,000 內免稅) |
| other | bonus_other | (依設定) | (依設定) |

### 1.8 新表:`payroll_imports`

新檔 `migrations/2026_05_10_payroll_imports.sql`:

```sql
CREATE TABLE IF NOT EXISTS payroll_imports (
  id                  TEXT PRIMARY KEY,
  payroll_period_id   TEXT REFERENCES payroll_periods(id),

  import_type         TEXT NOT NULL CHECK (import_type IN (
    'attendance_override',   -- 出勤覆蓋(來自打卡機 Excel)
    'bonus',                  -- 獎金匯入
    'adjustment',             -- 一次性調整(扣款 / 補發)
    'salary_profile',         -- 員工薪資設定批量(年度調薪)
    'labor_brackets',         -- 勞保級距表
    'health_brackets',        -- 健保級距表
    'tax_brackets',           -- 稅額表
    'manual_overtime'         -- 加班手填(沒打卡資料時)
  )),

  file_name           TEXT,
  file_size           INTEGER,
  file_hash           TEXT,                          -- 防重複匯入

  status              TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','validating','validated',
                                        'applying','applied','failed','rolled_back')),
  total_rows          INTEGER NOT NULL DEFAULT 0,
  success_rows        INTEGER NOT NULL DEFAULT 0,
  error_rows          INTEGER NOT NULL DEFAULT 0,
  error_log           JSONB,                         -- [{row, field, message}, ...]

  -- 預覽資料(applied 前可看)
  preview_data        JSONB,                         -- 解析後的前 20 row

  uploaded_by         TEXT REFERENCES employees(id),
  uploaded_at         TIMESTAMPTZ DEFAULT NOW(),
  applied_at          TIMESTAMPTZ,
  rolled_back_at      TIMESTAMPTZ,
  rolled_back_by      TEXT REFERENCES employees(id),
  rollback_reason     TEXT
);

ALTER TABLE payroll_imports ENABLE ROW LEVEL SECURITY;
CREATE POLICY "allow_all" ON payroll_imports FOR ALL USING (true) WITH CHECK (true);
```

### 1.9 新表:`payroll_payslips`

新檔 `migrations/2026_05_10_payroll_payslips.sql`:

```sql
CREATE TABLE IF NOT EXISTS payroll_payslips (
  id                  TEXT PRIMARY KEY,
  salary_record_id    TEXT NOT NULL REFERENCES salary_records(id),
  employee_id         TEXT NOT NULL REFERENCES employees(id),
  payroll_period_id   TEXT NOT NULL REFERENCES payroll_periods(id),

  pdf_url             TEXT,                          -- Supabase Storage URL
  pdf_generated_at    TIMESTAMPTZ,
  pdf_hash            TEXT,                          -- 防偽

  delivery_method     TEXT CHECK (delivery_method IN ('email','app','print','none')),
  delivered_at        TIMESTAMPTZ,

  viewed_at           TIMESTAMPTZ,                   -- 員工首次查看
  acknowledged_at     TIMESTAMPTZ,                   -- 員工確認簽收

  created_at          TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(salary_record_id)
);

ALTER TABLE payroll_payslips ENABLE ROW LEVEL SECURITY;
CREATE POLICY "allow_all" ON payroll_payslips FOR ALL USING (true) WITH CHECK (true);
```

### 1.10 employees 補的計薪相關欄位

```sql
-- 食宿 / 交通津貼(現況塞 extra_allowance、未來可拆細;先保留延伸性)
ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS meal_allowance      NUMERIC(10,2) DEFAULT 0,    -- 月 NT$3,000 內免稅
  ADD COLUMN IF NOT EXISTS transport_allowance NUMERIC(10,2) DEFAULT 0;

-- 薪資沿革(未來可改成獨立表 employee_salary_history、目前保留 effective_from snapshot)
ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS salary_effective_from DATE;

-- 福利金扣率(預設 0.5%,部分公司不扣)
ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS welfare_fund_rate NUMERIC(5,4) DEFAULT 0.005;
```

---

## 2. lib/salary/* 擴充

新加 7 個純函式檔。沿用 repo 注入 + vitest mock pattern(對齊 `lib/leave/balance.js` + `tests/leave-balance.test.js` 樣本)。

### 2.1 `lib/salary/tax-withholding.js`(新)

```js
/**
 * 計算薪資所得扣繳稅額
 *
 * 三種方式:
 * 1. 'table' — 依扶養人數查薪資扣繳稅額表
 * 2. 'fixed_5pct' — 月薪 ≥ 88,501(2026 年度)時按全月給付總額 5%
 * 3. 'non_resident' — 非居住者(在台 < 183 天)按 6% 或 18%
 *
 * 注意:
 * - 「薪資總額」= base + 經常性給付 + 加班費 + 績效獎金(年終 / 三節分開另計)
 * - 食宿津貼 NT$3,000 內免稅、超過列入
 * - 二代健保補充保費 不從薪資總額扣
 */
export async function calculateTaxWithholding(repo, {
  taxable_income,         // 課稅基數
  marital_status,         // 'single' / 'married'
  dependents_count,       // 扶養人數
  year,                   // 取對應年度
  is_resident             // boolean
}) {
  // ...
  // 回傳 { amount, method_used, bracket_id, taxable_income_used }
}
```

repo 介面契約:
```
findTaxBracket({ year, method, marital_status, dependents_count, salary }) → row | null
```

### 2.2 `lib/salary/supplementary-health.js`(新)

```js
/**
 * 二代健保補充保費(全民健保法 §31)
 *
 * 雇主對員工每月給付的「薪資以外經常性給付」(獎金、紅利)累計超過該員工
 * 「健保投保金額 × 4 倍」的差額部分、課 2.11%(2026 年度)。
 *
 * 範例:投保 36,300、單月年終 200,000
 *   差額 = 200,000 - 36,300 × 4 = 200,000 - 145,200 = 54,800
 *   補充保費 = 54,800 × 0.0211 = 1,156.28
 */
export async function calculateSupplementaryHealth(repo, {
  employee_id,
  year, month,
  bonus_total,              // 該月非經常性給付合計
  insured_salary_health,    // 健保投保金額 snapshot
  rate                      // 預設 0.0211(年度可變、放 system_settings)
}) {
  // ...
  // 回傳 { amount, threshold_amount, exceeds, taxable_amount }
}
```

### 2.3 `lib/salary/pension-deduction.js`(新)

```js
/**
 * 勞退提繳(勞退條例 §14)
 *
 * 雇主強制 6% — 不從薪資扣、屬雇主成本
 * 員工自願 0~6% — 從薪資扣、免稅(免併入薪資所得)
 *
 * 注意:員工自願提繳免稅、所以「課稅基數 = 薪資總額 - 員工自願提繳」
 */
export async function calculatePensionDeduction(repo, {
  employee_id,
  payroll_period_id,
  effective_date            // 取當期有效的 pension_settings
}) {
  // ...
  // 回傳 {
  //   voluntary_amount,       // 員工自願(從薪資扣)
  //   employer_amount,        // 雇主強制(不從薪資扣、寫到 employer_cost_pension)
  //   pension_wage_used,      // 提繳工資 snapshot
  //   voluntary_rate,
  //   employer_rate
  // }
}
```

### 2.4 `lib/salary/bonus-aggregator.js`(新)

```js
/**
 * 從 bonus_records 撈該月 status='pending'/'approved' 的獎金
 * 按 bonus_type 分流到 bonus_yearend / festival / performance / other
 * 並 mark applied_to_salary_record_id + status='applied'
 */
export async function aggregateBonuses(repo, {
  employee_id,
  payroll_year,
  payroll_month,
  salary_record_id          // 寫回時 mark 用
}) {
  // ...
  // 回傳 {
  //   bonus_yearend, bonus_festival, bonus_performance, bonus_other,
  //   bonus_other_note,             // 'other' 類的 reason 串接
  //   total,                         // 全部加總(供二代健保判定用)
  //   supplementary_health_subject_total,  // 課二代健保的部分
  //   taxable_total,                 // 課稅的部分
  //   applied_record_ids
  // }
}
```

### 2.5 `lib/salary/employer-cost.js`(新)

```js
/**
 * 雇主負擔(影子計算、不影響員工 net、純供成本分析)
 *
 * 包括:
 * - 勞保 70% (insurance_settings.labor_ins_company)
 * - 健保 60% (insurance_settings.health_ins_company)
 * - 勞退 6% (pension_settings.employer_amount)
 * - 職災保險 (依行業別、約 0.06%~0.5%)
 * - 就業保險 (0.7% 內、雇主 70%)
 * - 福利金提撥 (0.05%~0.15% 由雇主決定、若有設職工福利金)
 */
export async function calculateEmployerCost(repo, {
  employee_id,
  payroll_period_id,
  insured_salary_labor,      // snapshot
  insured_salary_health,     // snapshot
  pension_wage,              // snapshot
  occupational_rate,         // 從 company_params
  employment_insurance_rate  // 從 company_params(雇主負擔部分)
}) {
  // 回傳 {
  //   labor, health, pension, occupational, employment, welfare,
  //   total
  // }
}
```

### 2.6 `lib/salary/period-state.js`(新)

```js
/**
 * payroll_periods 狀態機 transition rules
 * 套 lib/schedule/period-state.js pattern
 */
export const ALLOWED_TRANSITIONS = {
  draft:           ['calculating'],
  calculating:     ['draft', 'pending_review'],
  pending_review:  ['calculating', 'approved'],
  approved:        ['calculating', 'paid'],          // 可退回
  paid:            ['locked'],
  locked:          [],                                // 終態
};

export function canTransition(from, to) { /* ... */ }
export function requireRoleForTransition(from, to) {
  // 'calculating' / 'pending_review' / 'paid' → HR
  // 'approved' → CEO / chairman
  // 'locked' → cron 或 admin
}
```

### 2.7 `lib/salary/import-validator.js`(新)

```js
/**
 * Excel 匯入檔欄位 validation、按 import_type 分流
 *
 * 對每個 import_type 定義 schema:
 * - required_columns
 * - column_types(numeric / date / string / enum)
 * - row_validators(employee_id 必須在 employees / 金額 ≥ 0 等)
 *
 * 回傳 { valid_rows, error_rows: [{row_idx, field, message}] }
 */
export function validateImport(import_type, rows) { /* ... */ }
```

### 2.8 既有 `lib/salary/calculator.js` 的更新

11 步擴成 23 步(見 [§5 完整計算流程](#5-完整計算流程14-步))。**舊步驟不動**、新步驟插入既有 pipeline。

### 2.9 既有 `lib/salary/settlement.js` 的更新

關閉 Batch 9 TODO:把 rollover / manual settle 寫 0 的邏輯改成直接呼叫 calculateAnnualSettlement、當下算對。

---

## 3. API endpoint 配置

### 3.1 全部走 `?_resource=` 子路由(避開 12 functions 上限)

#### 3.1.1 `api/salary/index.js` 子分支(現有 + 新增)

```
既有:
  GET    /api/salary?year=2026&month=05         → list(legacy)
  GET    /api/salary?v=2&year=2026&month=05     → list(v2)
  POST   /api/salary?_action=batch              → 開新月份(legacy)
  POST   /api/salary?v=2&_action=batch_v2       → 全員試算

新增子分支:
  GET    /api/salary?_resource=periods                                → 期間 list
  POST   /api/salary?_resource=periods                                → 開新期間
  PUT    /api/salary?_resource=periods&id=PP_2026_05                  → 更新期間 status
  POST   /api/salary?_resource=periods&id=PP_2026_05&_action=calculate → 跑試算
  POST   /api/salary?_resource=periods&id=PP_2026_05&_action=approve   → 老闆審核
  POST   /api/salary?_resource=periods&id=PP_2026_05&_action=pay       → 標記發放
  POST   /api/salary?_resource=periods&id=PP_2026_05&_action=lock      → 鎖定
  POST   /api/salary?_resource=periods&id=PP_2026_05&_action=reject    → 退回(approved → calculating)

  GET    /api/salary?_resource=imports                                → 匯入歷史
  POST   /api/salary?_resource=imports                                → 上傳 + 解析(回 preview)
  POST   /api/salary?_resource=imports&id=IMP_xxx&_action=apply       → 確認入庫
  POST   /api/salary?_resource=imports&id=IMP_xxx&_action=rollback    → rollback

  GET    /api/salary?_resource=bonuses&year=2026&month=05             → 該月獎金 list
  POST   /api/salary?_resource=bonuses                                → 新增單筆
  PUT    /api/salary?_resource=bonuses&id=BNS_xxx                     → 更新
  DELETE /api/salary?_resource=bonuses&id=BNS_xxx                     → 刪除(只能刪 status='pending')

  GET    /api/salary?_resource=payslips&employee_id=E001              → 員工歷月薪資單
  POST   /api/salary?_resource=payslips&id=SAL_xxx&_action=generate   → 生成 PDF
```

#### 3.1.2 `api/salary-grade.js` 子分支(現有 + 新增)

```
既有:
  GET  /api/salary-grade                                  → 職等級距表
  GET  /api/salary-grade?_resource=insurance              → 員工勞健保 settings
  GET  /api/salary-grade?_resource=insurance&brackets=labor   → 勞保級距
  GET  /api/salary-grade?_resource=insurance&brackets=health  → 健保級距
  GET  /api/salary-grade?_resource=insurance&brackets=pending → 待處理變動

新增:
  GET    /api/salary-grade?_resource=tax_brackets&year=2026  → 稅額表
  POST   /api/salary-grade?_resource=tax_brackets            → 匯入新年度
  GET    /api/salary-grade?_resource=pension                 → 員工勞退 settings list
  POST   /api/salary-grade?_resource=pension                 → 設定 / 更新員工勞退
```

### 3.2 vercel.json rewrite 加

```json
{
  "rewrites": [
    { "source": "/api/salary/periods",         "destination": "/api/salary/index?_resource=periods" },
    { "source": "/api/salary/periods/:id",     "destination": "/api/salary/index?_resource=periods&id=:id" },
    { "source": "/api/salary/imports",         "destination": "/api/salary/index?_resource=imports" },
    { "source": "/api/salary/imports/:id",     "destination": "/api/salary/index?_resource=imports&id=:id" },
    { "source": "/api/salary/bonuses",         "destination": "/api/salary/index?_resource=bonuses" },
    { "source": "/api/salary/bonuses/:id",     "destination": "/api/salary/index?_resource=bonuses&id=:id" },
    { "source": "/api/salary/payslips",        "destination": "/api/salary/index?_resource=payslips" },
    { "source": "/api/tax-brackets",           "destination": "/api/salary-grade?_resource=tax_brackets" },
    { "source": "/api/pension-settings",       "destination": "/api/salary-grade?_resource=pension" }
  ]
}
```

### 3.3 cron 加

```json
{ "path": "/api/salary/index?_resource=periods&_action=auto_lock", "schedule": "0 18 5 * *" }
// 每月 5 號 18:00 自動 lock 上上月已 paid 期間
```

---

## 4. 前端頁

### 4.1 新增 5 個 HR 後台桌面頁(走 layout.js)

#### 4.1.1 `public/salary-period.html`

期間管理主頁。
- 期間 list table:年月 / status badge / employee_count / gross_total / net_total / employer_cost_total
- 開新期間按鈕(modal:選年月、自動帶預設 cutoff / pay_date)
- 點期間進詳細頁:
  - 左側 status 進度條(draft → calculating → pending_review → approved → paid → locked)
  - 右上「跑試算」「審核通過」「退回」「標記發放」按鈕(依 status enable)
  - 右側員工試算表(複用 `salary.html` 既有 18 欄表格 + 編輯 modal)
  - 底部統計卡:應發 / 應扣 / 實發 / 雇主負擔 4 個 stat
- 統計變動時更新 payroll_periods 統計 cache(由 calculator 寫)

#### 4.1.2 `public/salary-import.html`

統一的匯入頁。
- 上傳區:拖曳 / 點選檔案
- 匯入類型下拉(8 種、見 §1.8)
- 解析後 preview table(前 20 row、錯誤 row 標紅)
- 「下載錯誤 log」按鈕
- 「確認入庫」按鈕(disable 直到 0 error 或 user 強制覆蓋)
- 已 apply 的歷史 batch list(可 rollback)
- 「下載匯入範本」連結(每種類型一個 .xlsx 範本)

#### 4.1.3 `public/salary-bonus.html`

獎金管理。
- list:type(中文 label)/ amount / 員工 / payroll_year-month / status / created_by
- 篩選:年月 / type / status / 員工
- 新增 modal:選員工 / type / amount / reason / payroll_year-month / 課稅勾選 / 二代健保勾選
- 批次匯入按鈕(連到 salary-import.html?type=bonus)
- 審核(老闆 / HR、依公司流程)

#### 4.1.4 `public/salary-tax-brackets.html`

稅額表維護(年度更新一次)。
- 年度切換 tab
- 三個 sub-tab:依扶養人數查表 / 5% 固定 / 非居住者
- 表格 read-only(主要靠匯入)
- 「匯入新年度」按鈕(連到 salary-import.html?type=tax_brackets)

#### 4.1.5 `public/salary-employer-cost.html`(可選、若需要)

雇主成本分析。
- 期間切換
- 員工 × 成本欄位的大表格
- 部門加總統計
- 年度趨勢圖

### 4.2 改造 1 個既有頁

#### 4.2.1 `public/employee-salary.html` → 加 PDF 下載

員工 mobile self-bootstrap 版型不動。新增:
- 「下載 PDF」按鈕、呼叫 POST `/api/salary/payslips&id=SAL_xxx&_action=generate` 生成 PDF
- 顯示 acknowledged_at(已簽收 / 未簽收)
- 「我已確認」按鈕(寫 acknowledged_at)

### 4.3 dashboard.html 補

非破壞性新增:
- HR 角色看到「本月薪資狀態」卡片(顯示 payroll_periods.status 進度條)
- HR / 老闆角色看到「待審核期間」清單(if any)
- 員工看到「最新薪資單未簽收提示」(if any)

### 4.4 sidebar(layout.js)補

```js
// public/js/layout.js — 薪資管理 group 擴展
{
  title: '薪資管理',
  items: [
    { page:'employee-salary',     icon:'💵', label:'我的薪資',   href:'/employee-salary.html' },
    { page:'salary-period',       icon:'📅', label:'薪資期間',   href:'/salary-period.html',     gate: isHRish },
    { page:'salary',              icon:'💰', label:'薪資管理',   href:'/salary.html',            gate: isHRish },
    { page:'salary-bonus',        icon:'🎁', label:'獎金管理',   href:'/salary-bonus.html',      gate: isHRish },
    { page:'salary-import',       icon:'📥', label:'薪資匯入',   href:'/salary-import.html',     gate: isHRish },
    { page:'insurance',           icon:'🏥', label:'勞健保',     href:'/insurance.html',         gate: isHRish },
    { page:'salary-tax-brackets', icon:'📊', label:'稅額表',     href:'/salary-tax-brackets.html', gate: isHRish },
  ]
},
```

---

## 5. 完整計算流程(14 步 → 23 步)

更新 `lib/salary/calculator.js`。**舊步驟不動**、新步驟插入既有 pipeline。

```
calculatePayroll(employee_id, payroll_period_id):

  ── 載入階段 ───────────────────────────────────────────
  1. 載 employee(含 4 drift 欄位 + tax_* 欄位 + meal/transport_allowance)
  2. 載 attendance_summary(從 attendance + leaves + holidays 聚合,
                          或 payroll_imports 中 attendance_override 覆蓋)
  3. 載 overtime_requests(status=approved + comp_type=overtime_pay,
                          payroll_year/month=該月)
  4. 載 attendance_penalty_records(status=pending,
                                  在該月 work_date 區間)
  5. 載 bonus_records(payroll_year/month=該月、status='pending'/'approved')
  6. 載 monthly_adjustments(暫無獨立表、塞 _manual 欄位)
  7. 載 insurance_settings + pension_settings(取當月有效)

  ── 應發階段(勞基法 §22 經常性 / 非經常性給付)──────────
  8. 算「正常工資」:
     a. base_salary × 出勤比例(月中到 / 離職、無薪假按 §23 比例)
     b. + grade_allowance + manager_allowance
     c. + allowance + extra_allowance + meal_allowance + transport_allowance
     d. - 缺勤扣薪(事假 §43 不給薪、病假 §43 半薪、無薪假按比例)
     e. + 全勤獎金 attendance_bonus_actual(attendance-bonus.js 已有)
  9. 算「加班費」(§24):
     a. 平日延長前 2 小時 × 1.34 倍
     b. 平日延長 3-4 小時 × 1.67 倍
     c. 休息日(七休一)前 2 小時 × 1.34、後 2 小時 × 1.67、超過 8 小時 × 2.67
     d. 例假日 / 國定假日整段 × 2.0(holidays.pay_multiplier)
     e. 寫到 overtime_pay_auto(overtime-aggregator.js 已有)
  10. 算「假日工作」(§39 §40):
      a. 國定假日出勤 → holiday_work_pay = base_daily × pay_multiplier
      b. 例假日出勤(法律上禁止、但實際發生時要加倍給)
  11. 算「補休失效 cash payout」(§32-1):
      a. comp_expiry_payout(由 cron-comp-expiry.js 提前算、calculator 只讀)
  12. 算「特休結算」(§38):
      a. settlement_amount(close Batch 9 TODO 後:settlement.js 直接算對)
  13. 算「獎金分流」:
      a. bonus-aggregator.js → bonus_yearend / festival / performance / other
      b. 同時 mark bonus_records.status='applied'
  14. gross_salary = GENERATED 自動算

  ── 應扣階段 ───────────────────────────────────────────
  15. 計算 taxable_income_snapshot:
      = gross_salary - 免稅項
      免稅項包括:
      - meal_allowance ≤ 3,000 部分(所得稅法 §14)
      - transport_allowance(部分)
      - 員工自願勞退提繳(§14)
      - 法定加班費中超過 §24 標準的部分(罕見)

  16. 法定扣項:
      a. 勞保員工自付(insurance_settings.labor_ins_employee、已有)
      b. 健保員工自付(insurance_settings.health_ins_employee + 眷屬、已有)
      c. 勞退員工自願提繳(pension-deduction.js 新增)
      d. 二代健保補充保費(supplementary-health.js 新增):
         - 對 bonus_yearend / festival / performance / other 累計
         - 累計超過 insured_salary_health × 4 → 超額 × 2.11%
      e. 所得稅扣繳(tax-withholding.js 新增):
         - 依員工 tax_method:'table' 查扣繳稅額表
                              'fixed_5pct' 按 taxable_income × 5%
                              'non_resident' 按 6% 或 18%

  17. 出勤扣項(已有):
      a. attendance_penalty_total(penalty-applier.js)
      b. mark attendance_penalty_records.status='applied'

  18. 缺勤扣薪(在第 8d 步已扣到 base_salary、這裡 deduct_absence 是顯示用):
      - deduct_absence = absence_days × daily_wage_snapshot

  19. 其他扣項(_manual 為主、HR 個案輸入):
      - deduct_welfare_fund = base_salary × welfare_fund_rate(預設 0.5%)
      - deduct_union_fee
      - deduct_court_garnishment
      - deduct_loan_repayment
      - deduct_other(+ note)

  20. net_salary = GENERATED 自動算

  ── 雇主成本(影子)───────────────────────────────────
  21. employer-cost.js:
      a. employer_cost_labor = insurance_settings.labor_ins_company
      b. employer_cost_health = insurance_settings.health_ins_company
      c. employer_cost_pension = pension_settings.employer_amount
      d. employer_cost_occupational = insured_salary × occupational_rate
      e. employer_cost_employment = insured_salary × employment_rate(雇主部分)
      f. employer_cost_welfare = base_salary × employer_welfare_rate

  ── 寫入 ───────────────────────────────────────────
  22. UPSERT salary_records:
      - 所有 _auto 欄位被覆蓋
      - 所有 _manual 欄位保留
      - calculated_at / calculated_by 更新
      - status:draft → calculating → pending_review

  23. 更新 payroll_periods 統計 cache:
      - employee_count / gross_total / net_total / employer_cost_total
```

### 5.1 GENERATED 公式總覽(對應步驟 14、20)

```
gross_salary = base_salary
             + attendance_bonus_actual + allowance + extra_allowance
             + overtime_pay_auto + overtime_pay_manual
             + comp_expiry_payout + holiday_work_pay + settlement_amount
             + bonus_yearend + bonus_festival + bonus_performance + bonus_other

net_salary = gross_salary
           - deduct_absence - deduct_labor_ins - deduct_health_ins
           - deduct_tax - attendance_penalty_total
           - deduct_pension_voluntary - deduct_supplementary_health
           - deduct_welfare_fund - deduct_union_fee
           - deduct_court_garnishment - deduct_loan_repayment - deduct_other

# meal_allowance / transport_allowance 已併入 allowance 或 extra_allowance、不另列
# 雇主成本 employer_cost_* 不影響 net_salary
```

### 5.2 計算順序的設計選擇

- **deduct_pension_voluntary 從應發扣、但是免稅**:課稅基數計算時要先扣它
- **二代健保補充保費**:單筆獎金 ≥ NT$20,000 才扣(舊規)、現行依「累計達投保 4 倍」判定。設計按累計判定、但保留 single-amount 判定的 hook
- **特休結算 settlement_amount**:列入 gross 也課稅、跟年資 × 平均工資算

---

## 6. 匯入匯出設計

### 6.1 匯入機制

統一流程:

```
[使用者] → 拖曳 Excel → POST /api/salary/imports(multipart)
   ↓
[後端] → SheetJS 解析 → import-validator 驗證 → 寫 payroll_imports.preview_data
   ↓
[使用者] → 看 preview → 「確認入庫」按鈕
   ↓
POST /api/salary/imports&id=IMP_xxx&_action=apply
   ↓
[後端] → 按 import_type 分流寫入對應表
   ↓
status='applied' → 顯示成功 / 失敗 row 統計
```

failed 的 batch 可:
- 看 error_log JSONB(row / field / message)
- 下載「失敗 row」.xlsx(原資料 + 錯誤欄位 highlight)
- rollback(已 applied 的可撤回、會 reverse 對應寫入)

### 6.2 匯入類型 × 範本

每種類型一個 .xlsx 範本(放 `public/templates/` 或內建在 import 頁、由 SheetJS 動態生成):

#### 6.2.1 attendance_override(出勤覆蓋)

```
employee_id | work_date  | clock_in | clock_out | work_hours | overtime_hours | status
E001        | 2026-05-01 | 09:00    | 18:00     | 8.0        | 0              | normal
```

入庫:UPDATE attendance WHERE (employee_id, work_date) 匹配。

#### 6.2.2 bonus(獎金)

```
employee_id | bonus_type | amount | payroll_year | payroll_month | reason | is_taxable | is_supplementary_health_subject
E001        | yearend    | 80000  | 2026         | 1             | 2025 年終 | true   | true
```

入庫:INSERT bonus_records,status='pending'(等審核)。

#### 6.2.3 adjustment(一次性調整)

```
employee_id | payroll_year | payroll_month | column | amount | reason
E001        | 2026         | 5             | overtime_pay_manual | 5000 | 手動補加班費
```

入庫:UPDATE salary_records 對應 _manual 欄位。

#### 6.2.4 salary_profile(員工薪資批量、年度調薪用)

```
employee_id | base_salary | attendance_bonus | grade_allowance | manager_allowance |
extra_allowance | meal_allowance | transport_allowance | has_insurance | effective_from
E001        | 45000       | 2000             | 3000            | 0                 |
1000            | 2400          | 1000                | true          | 2026-06-01
```

入庫:UPDATE employees,效期欄位寫到 salary_effective_from。

#### 6.2.5 labor_brackets / health_brackets / tax_brackets

政府公告值匯入。範本欄位對應 §1.1.2 / §1.5。

### 6.3 匯出

#### 6.3.1 個人薪資單 PDF(payroll_payslips)

用 `pdf-lib`(Vercel serverless 友善、不需要 puppeteer)。

模板:A4、含
- 公司抬頭
- 員工姓名 / 員工編號 / 部門
- 薪資期間(payroll_period 年月)
- 應發項目表(分行列出)
- 應扣項目表(分行列出)
- 應發合計 / 應扣合計 / 實發金額(大字)
- 投保薪資 / 課稅所得 / 累計年度所得(右下小字)
- 雇主匯款參考(銀行帳號末 4 碼)
- 簽收區(可選)

存到 Supabase Storage → URL 寫 payroll_payslips.pdf_url。

#### 6.3.2 整月薪資 Excel(會計用)

由 `/api/salary?_resource=periods&id=PP_xxx&_action=export_excel` 產生。
包含所有員工 × 所有 _auto/_manual 欄位 + 雇主成本。

#### 6.3.3 年度扣繳憑單(每年 1 月)

cron 自動產生:`/api/cron-yearly-tax-form`(目前未排上 cron 配額、要新加)。
由全年 salary_records 累計、產生財政部公告格式的 .csv。

#### 6.3.4 勞退提繳對帳單(每月)

由 pension_settings × 該月 salary_records 累計、產生勞退局格式 csv。

#### 6.3.5 勞健保對帳單(每月)

由 insurance_settings × 該月 salary_records 累計、產生勞 / 健保局格式 csv。

### 6.4 套件加裝

`package.json` 新增:

```json
{
  "dependencies": {
    "@supabase/supabase-js": "^2.39.0",
    "web-push": "^3.6.7",
    "xlsx": "^0.18.5",
    "pdf-lib": "^1.17.1"
  }
}
```

> 不裝 puppeteer:Vercel serverless 限制 50MB、puppeteer 加 chromium 超過。pdf-lib 純 JS 約 2MB、夠用。

---

## 7. 分階段提交計畫

按 user 「分階段提交、commit message 結構化中文、改動前測試覆蓋、不 push prod 前 review」風格。

每階段獨立 mergeable、跑 vitest 全綠、push 前 user 自己 review。

### 階段 0 — 對齊現況(必做、純整理)

**目的**:把 prod 跟 repo schema 對齊、close 半成品 TODO。

| commit | 訊息 |
|---|---|
| 0.1 | `chore(schema): 補 4 欄 + 5 表 prod-only drift migration + verify SQL` |
| 0.2 | `fix(salary): close Batch 9 結算金額 TODO、annual-rollover/manual-settle 直接算對` |
| 0.3 | `test(salary): annual-rollover 結算金額測試補實際金額、刪 9 處 TODO 標記` |

⚠ 0.1 動 migration 前必須先以 `psql $PROD_URL -c "\d <table>"` dump 出實際 schema、比對 §1.1.2 的推測結構。

### 階段 1 — salary_records 擴欄 + payroll_periods

**目的**:建立期間框架、擴充薪資 snapshot 欄位。

| commit | 訊息 |
|---|---|
| 1.1 | `feat(schema): salary_records 擴 19 欄(獎金分流 / 法定扣項 / 雇主成本 / period 關聯 / audit)` |
| 1.2 | `feat(schema): 新增 payroll_periods + 狀態機` |
| 1.3 | `feat(salary): 新增 lib/salary/period-state.js + 對應 vitest` |
| 1.4 | `feat(schema): 更新 GENERATED gross_salary / net_salary 公式涵蓋新欄位` |
| 1.5 | `feat(api): /api/salary?_resource=periods endpoint(GET/POST/PUT)` |

### 階段 2 — 補缺的算法(純函式 + 測試)

**目的**:勞基法完整覆蓋、新加 5 個 lib/salary/* 純函式 + 對應 schema。

| commit | 訊息 |
|---|---|
| 2.1 | `feat(schema): 新增 tax_withholding_brackets + employees.tax_*` |
| 2.2 | `feat(salary): 新增 lib/salary/tax-withholding.js + vitest` |
| 2.3 | `feat(schema): 新增 pension_settings + lib/salary/pension-deduction.js + vitest` |
| 2.4 | `feat(salary): 新增 lib/salary/supplementary-health.js + vitest` |
| 2.5 | `feat(schema): 新增 bonus_records + lib/salary/bonus-aggregator.js + vitest` |
| 2.6 | `feat(salary): 新增 lib/salary/employer-cost.js + vitest` |
| 2.7 | `feat(salary): calculator 整合 23 步、寫入新欄位` |
| 2.8 | `feat(api): /api/salary?_resource=bonuses endpoint` |
| 2.9 | `feat(api): /api/salary-grade?_resource=tax_brackets endpoint` |
| 2.10 | `feat(api): /api/salary-grade?_resource=pension endpoint` |

### 階段 3 — 匯入匯出工作流

| commit | 訊息 |
|---|---|
| 3.1 | `chore(deps): add xlsx / pdf-lib` |
| 3.2 | `feat(schema): 新增 payroll_imports + payroll_payslips` |
| 3.3 | `feat(salary): 新增 lib/salary/import-validator.js + vitest` |
| 3.4 | `feat(api): /api/salary?_resource=imports endpoint(upload / preview / apply / rollback)` |
| 3.5 | `feat(salary): 新增 lib/salary/payslip-generator.js(pdf-lib) + vitest` |
| 3.6 | `feat(api): /api/salary?_resource=payslips endpoint` |

### 階段 4 — UI 整合

| commit | 訊息 |
|---|---|
| 4.1 | `feat(public): salary-period.html 期間管理頁 + sidebar 整合` |
| 4.2 | `feat(public): salary-import.html 拖曳匯入頁 + 8 種範本` |
| 4.3 | `feat(public): salary-bonus.html 獎金管理頁` |
| 4.4 | `feat(public): salary-tax-brackets.html 稅額表維護頁` |
| 4.5 | `feat(public): employee-salary.html 加 PDF 下載 + 簽收` |
| 4.6 | `feat(public): dashboard.html 加薪資期間進度條 + 待審核 widget` |

### 階段 5 — 審核 / 鎖定工作流

| commit | 訊息 |
|---|---|
| 5.1 | `feat(salary): 期間 calculate / approve / pay / lock / reject endpoint` |
| 5.2 | `feat(public): salary-period 老闆審核 modal + reject reason` |
| 5.3 | `feat(cron): 月底自動 lock 上上月已 paid 期間` |
| 5.4 | `feat(salary): 期間統計 cache 自動更新` |

### 階段 6 — 年度報表(可緩)

| commit | 訊息 |
|---|---|
| 6.1 | `feat(api): 整月薪資 Excel 匯出` |
| 6.2 | `feat(cron): 年度扣繳憑單(每年 1/15 自動)` |
| 6.3 | `feat(api): 勞退 / 勞健保對帳單匯出` |

---

## 8. 風險清單與決策點

### 8.1 動 migration 前必確認

- **prod schema dump**:5 張 prod-only table 的真實欄位(階段 0.1 要做)
- **DROP/ADD GENERATED gross_salary / net_salary** 是 destructive,要在低流量時段跑、有 rollback 預案
- **既有 salary_records 行的 _manual 欄位**:擴欄後要 backfill、不能讓老資料的 status 卡在不合法 transition

### 8.2 設計決策點(user 看完設計後可挑戰)

| 決策 | 選項 A(本設計選擇) | 選項 B(替代) |
|---|---|---|
| 獎金紀錄表 | 獨立 bonus_records 表 + status 機 | 全部塞 salary_records._manual 欄位 |
| 勞退設定 | 獨立 pension_settings | 合併到 insurance_settings |
| 食宿 / 交通津貼 | employees 加 meal_allowance / transport_allowance | 全塞 extra_allowance(現況) |
| 期間狀態機 | payroll_periods 6 狀態 | 沿用 salary_records.status 三狀態 |
| 薪資沿革 | employees 加 salary_effective_from(snapshot) | 獨立 employee_salary_history 表 |
| PDF 套件 | pdf-lib(輕量) | puppeteer(可塞模板、但 50MB 限制) |

### 8.3 法令更新風險

- 勞保 / 健保 級距表每年 1 月可能調整
- 基本工資每年 1 月可能調整(影響時薪 / 加班費基數)
- 二代健保補充保費率 2.11% 可能調整
- 各類所得扣繳率標準每年公告
- **設計**:全部用 `effective_from / effective_to` 區間、避免硬碼

### 8.4 缺工資調漲歷史

`employee_salary_history` 沒做。如果要查「員工 6 個月前的薪資」、目前只能靠 `employee_change_logs`(audit log)解析、不直觀。階段 6 後可再規劃。

### 8.5 RLS 強化(獨立 backlog)

memory 提過「F12 / curl 仍能拿全資料」。薪資模組更敏感、新表 RLS 仍寫 demo allow_all、安全靠 application layer。獨立 backlog 處理(不在本設計範圍)。

---

## 附錄 A — 對應勞基法條文索引

| 條文 | 內容 | 對應設計 |
|---|---|---|
| §2 | 工資定義 | 經常性給付 → 列入投保薪資、加班費基數 |
| §22 | 工資給付 | gross_salary / net_salary 結構 |
| §23 | 工資計算與離職發放 | base_salary × 出勤比例 |
| §24 | 延長工時加給 | overtime_pay_auto 4 倍率 |
| §32-1 | 補休 | comp_expiry_payout |
| §38 | 特別休假 | settlement_amount |
| §39 | 例假 / 國定假日工資 | holiday_work_pay |
| §40 | 例假日出勤加倍 | holiday_work_pay × 2.0 |
| §43 | 請假 | 病假半薪、事假不給薪 |
| §70 | 工作規則 | 全勤獎金、福利金扣率 |

| 法規 | 對應 |
|---|---|
| 勞工保險條例 §13、§14 | labor_insurance_brackets |
| 全民健康保險法 §31 | supplementary-health.js |
| 勞工退休金條例 §14 | pension_settings、pension-deduction.js |
| 性別工作平等法 §15-§22 | leave_types(產假、陪產、生理、家庭照顧) |
| 所得稅法 §14、§88 | tax-withholding.js |
| 各類所得扣繳率標準 | tax_withholding_brackets |

---

## 附錄 B — 既有 lib/salary/* 改動範圍對照

| 既有檔 | 動哪 |
|---|---|
| `lib/salary/calculator.js` | 11 步 → 23 步、加 6 個新 step、保留所有舊 step |
| `lib/salary/attendance-bonus.js` | 不動 |
| `lib/salary/overtime-aggregator.js` | 不動 |
| `lib/salary/penalty-applier.js` | 不動 |
| `lib/salary/settlement.js` | close Batch 9 TODO,calculator step 12 改呼叫此 |
| `api/salary/_repo.js` | 加 13 個新 method(periods / imports / bonuses / payslips / brackets / pension) |
| `api/salary/index.js` | 加 4 個 _resource 子分支 |
| `api/salary-grade.js` | 加 2 個 _resource 子分支(tax_brackets / pension) |

---

## 附錄 C — 新增檔案清單

### lib/salary/(7 新增、1 改動)
- ➕ `tax-withholding.js`
- ➕ `supplementary-health.js`
- ➕ `pension-deduction.js`
- ➕ `bonus-aggregator.js`
- ➕ `employer-cost.js`
- ➕ `period-state.js`
- ➕ `import-validator.js`
- ➕ `payslip-generator.js`
- 🔧 `calculator.js`(11→23 步)
- 🔧 `settlement.js`(close TODO)

### tests/(8 新增)
對應每個新 lib 檔一個。

### migrations/(8 新增)
- ➕ `2026_05_10_payroll_drift_alignment.sql`
- ➕ `2026_05_10_close_batch9_settlement.sql`
- ➕ `2026_05_10_salary_records_expansion.sql`
- ➕ `2026_05_10_payroll_periods.sql`
- ➕ `2026_05_10_tax_brackets.sql`
- ➕ `2026_05_10_pension_settings.sql`
- ➕ `2026_05_10_bonus_records.sql`
- ➕ `2026_05_10_payroll_imports.sql`
- ➕ `2026_05_10_payroll_payslips.sql`

### migrations-verify/(對應每個新 migration 一個)

### public/(5 新增、3 改動)
- ➕ `salary-period.html`
- ➕ `salary-import.html`
- ➕ `salary-bonus.html`
- ➕ `salary-tax-brackets.html`
- ➕ `salary-employer-cost.html`(可選)
- 🔧 `employee-salary.html`(加 PDF 下載 + 簽收)
- 🔧 `dashboard.html`(加薪資期間進度條)
- 🔧 `js/layout.js`(sidebar 擴展)

### vercel.json
- 🔧 加 9 條 rewrite + 1 條 cron

### package.json
- 🔧 加 xlsx + pdf-lib

---

> 完。設計可隨時依 user review 後修改。
