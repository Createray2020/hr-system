# 出勤核心系統設計文件 v1.0

| 項目 | 內容 |
|---|---|
| 版本 | v1.0 |
| 撰寫日期 | 2026-04-25 |
| 來源 | Ray 與 Claude 討論之階段 1 設計（已收斂） |
| 狀態 | 設計階段 — 系統尚未上線，本次規格一次做完整，不分批漸進 |
| 涉及子系統 | 國定假日、排班、打卡、請假/特休、補休、加班、出勤獎懲、薪資 |

---

## 1. 整體目標

1. **薪資 + 出勤全勾稽**：所有薪資欄位必須能追溯到出勤資料來源（打卡、排班、請假、加班、補休），**不允許 HR 手動橋接**。
2. **為績效管理鋪底**：出勤資料結構清晰完整，未來績效模組可直接以本系統的彙總資料為輸入。
3. **一次做完整**：系統尚未上線，沒有遷移既有資料的負擔；本次規格力求一次到位，不分批漸進交付業務功能。

---

## 2. 範疇（六個子系統 + 一個基礎資料層）

| # | 子系統 | 一句話說明 |
|---|---|---|
| 0 | **國定假日** | 全系統共用基礎資料（排班、加班費倍率、補休失效、特休結算等都會引用） |
| 1 | **排班** | 三階段流程：員工自排 → 主管確認 → 主管定案 |
| 2 | **打卡** | 必須對應已定案排班；無對應者異常 |
| 3 | **請假 + 特休完整版** | 餘額、年資、週年制、結算 |
| 4 | **補休** | 1:1 換算、法定 1 年失效、可選擇失效後處理（轉加班費 / 直接清零） |
| 5 | **加班** | 兩段式上限、超時必含 CEO 流程、補休 / 加班費分流 |
| 6 | **出勤獎懲** | 後台可設定遲到、早退、曠職的處置（罰款、扣全勤、口頭警告等） |

---

## 3. 設計原則

1. **業務邏輯放純函式（`lib/`）**：API handler 是 thin wrapper，只負責 HTTP I/O 與權限。所有狀態判定、計算、規則檢查都在 `lib/` 下純函式（無 I/O、可單元測試）。
2. **DB 只做資料完整性**：`CHECK`、`FK`、`GENERATED column`。**不用 trigger 寫狀態機**（難測試、難 reasoning）。
3. **字典類資料用獨立表**：`leave_types`、`shift_types` 等，**不用 enum**（enum 改值需 ALTER TYPE，不易管理）。
4. **設定類資料用獨立表**：`overtime_limits`、`attendance_penalties`、`system_overtime_settings` 等，**不寫死**在程式碼。
5. **所有審批 / 異動有獨立 logs 表**：`schedule_change_logs`、`leave_balance_logs`、`overtime_request_logs`、`attendance_penalty_records` 等，**append-only**（不更新、不刪除）。
6. **API handler 是 thin wrapper**：呼叫 `lib/` 函式取得結果 → 回傳 HTTP；不在 handler 內寫業務判斷。

---

## 4. 完整 schema 設計

### 4.1 基礎資料層

#### 4.1.1 holidays（新建）

**用途：** 全系統共用基礎資料，被排班、打卡、薪資、出勤率、加班費倍率、特休衝突等模組查詢。

```sql
CREATE TABLE holidays (
  id            BIGSERIAL PRIMARY KEY,
  date          DATE NOT NULL,
  holiday_type  TEXT NOT NULL CHECK (holiday_type IN (
                  'national',
                  'makeup_workday',
                  'company',
                  'flexible'
                )),
  name          TEXT NOT NULL,
  description   TEXT,
  pay_multiplier NUMERIC(4,2) DEFAULT 2.00,
  source        TEXT NOT NULL CHECK (source IN ('manual', 'imported')),
  imported_from TEXT,
  imported_at   TIMESTAMPTZ,
  created_by    TEXT REFERENCES employees(id),
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (date, holiday_type)
);

CREATE INDEX idx_holidays_date ON holidays(date);
CREATE INDEX idx_holidays_year ON holidays(EXTRACT(YEAR FROM date));
```

**設計理由：**
- holiday_type 用 CHECK 約束保證類型不亂跑，未來要加新類型只要改 CHECK
- pay_multiplier 倍率不寫死，存在表上每筆假日獨立可調
- source 區分手動建立 vs 匯入，匯入後 HR 改了還是改，但系統知道原本來源
- 一天一類型（國定假日優先於公司休息日，避免薪資倍率衝突）

#### 4.1.2 shift_types（修改）

```sql
ALTER TABLE shift_types ADD COLUMN IF NOT EXISTS
  break_minutes INT NOT NULL DEFAULT 60;

ALTER TABLE shift_types ADD COLUMN IF NOT EXISTS
  is_active BOOLEAN NOT NULL DEFAULT true;
```

**設計理由：**
- break_minutes 集中存班別的休息時間，工時計算 = (end_time - start_time) - break_minutes
- 「9-18 含 1 小時休息 = 8 小時工時」的規則不寫死在 code，每個班別可以有自己的休息時間
- is_active 防止刪除歷史班別把過去的 schedules 搞壞

#### 4.1.3 employees（修改）

```sql
ALTER TABLE employees ADD COLUMN IF NOT EXISTS
  annual_leave_seniority_start DATE;

UPDATE employees SET annual_leave_seniority_start = hire_date
WHERE annual_leave_seniority_start IS NULL;

ALTER TABLE employees ALTER COLUMN annual_leave_seniority_start SET NOT NULL;
```

**設計理由：**
- 特休年資不一定等於 hire_date，HR 可調整（例如轉職員工承認前公司年資）
- 預設等於 hire_date，但獨立欄位讓 HR 後續可改
- 影響特休週年制的計算

---

### 4.2 排班 + 打卡

#### 4.2.1 schedule_periods（修改）

```sql
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

-- Backfill：既有 schedule_periods 用 dept 為單位、無 employee_id；
-- 因 prod 此表為空（0 row）、本系統重新從員工為單位設計，
-- 既有 dept 欄位保留為 legacy 不再使用。
-- 若該表非空，Batch 10 上 prod 前 HR 必須先決定 legacy row 處理方式。

-- 從 start_date / end_date 推 period_year / period_month / period_start / period_end
UPDATE schedule_periods
SET
  period_year   = EXTRACT(YEAR FROM start_date)::INT,
  period_month  = EXTRACT(MONTH FROM start_date)::INT,
  period_start  = start_date,
  period_end    = end_date
WHERE period_year IS NULL AND start_date IS NOT NULL;

-- backfill 完成後加 NOT NULL（以下需要 employee_id 也 backfill 完才能加，見 §8.2）
-- ALTER TABLE schedule_periods ALTER COLUMN period_year SET NOT NULL;
-- ALTER TABLE schedule_periods ALTER COLUMN period_month SET NOT NULL;
-- ALTER TABLE schedule_periods ALTER COLUMN period_start SET NOT NULL;
-- ALTER TABLE schedule_periods ALTER COLUMN period_end SET NOT NULL;

ALTER TABLE schedule_periods ADD CONSTRAINT
  uq_schedule_periods_employee_month
  UNIQUE (employee_id, period_year, period_month);
```

**狀態機規則（業務邏輯層執行）：**
- draft → submitted（員工送出）
- submitted → approved（主管定案）
- approved → locked（月份開始自動觸發，cron job）
- approved → approved（主管調整，留紀錄但狀態不變）
- locked → locked（主管當天調整，留紀錄但狀態不變）

**設計理由：**
- 改用 year + month 為核心識別（員工權限由月份決定，不是 7 天）
- 三個 timestamp 分別記錄狀態轉換時間，未來查報表很需要
- UNIQUE 約束防止同一員工同月份產生兩筆週期
- 狀態機放業務層不放 trigger（trigger 寫狀態機難測試）
- 既有 schedule_periods 用 dept 為單位設計，本次重做改為員工為單位：每個員工每個月一筆 period。dept 欄位保留為 legacy（向後相容）
- prod 既有 schedule_periods 為空，新增的 employee_id 等欄位 NULLABLE 加，backfill 後再 SET NOT NULL（同 §8.2 pattern）
- period_year/month/period_start/end 採 NULLABLE 加 → backfill → SET NOT NULL pattern，即使 prod 此表為空也保留此 pattern，避免未來 dev rehearsal 環境有 seed data 時 fail

#### 4.2.2 schedules（修改）

```sql
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
```

**業務邏輯約束（程式層執行）：**
- 同一員工同一天的多段班，時間不能重疊
- 多段班的總工時加起來不能超過合法上限

**設計理由：**
- period_id FK 讓「該員工該月的所有班次」可一次撈完
- start_time/end_time 獨立於 shift_type，允許主管調整時段（覆蓋班別預設）
- crosses_midnight 旗標讓查詢/計算邏輯有依據
- scheduled_work_minutes 預存避免每次查詢重算
- segment_no 支援一天多段（實務罕見但保留調整空間）
- start_time/end_time 從既有 TEXT 升級為 TIME：既有 schema 用 TEXT 存 "09:00"，但工時計算需要可以做時間運算的 TIME 型別。明確 ALTER TYPE 而非倚賴 ADD COLUMN IF NOT EXISTS

#### 4.2.3 schedule_change_logs（新建）

```sql
CREATE TABLE schedule_change_logs (
  id              BIGSERIAL PRIMARY KEY,
  schedule_id     TEXT REFERENCES schedules(id) ON DELETE SET NULL,
  employee_id     TEXT NOT NULL REFERENCES employees(id),
  change_type     TEXT NOT NULL CHECK (change_type IN (
                    'employee_draft',
                    'employee_submit',
                    'manager_adjust',
                    'manager_approve',
                    'system_lock',
                    'late_change'
                  )),
  changed_by      TEXT NOT NULL REFERENCES employees(id),
  changed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  before_data     JSONB,
  after_data      JSONB,
  reason          TEXT,
  notification_sent BOOLEAN NOT NULL DEFAULT false,
  notified_at     TIMESTAMPTZ
);

CREATE INDEX idx_schedule_change_logs_employee
  ON schedule_change_logs(employee_id, changed_at);
CREATE INDEX idx_schedule_change_logs_late_change
  ON schedule_change_logs(change_type, notification_sent)
  WHERE change_type = 'late_change';
```

**設計理由：**
- append-only，永不修改只新增，任何爭議可追溯
- change_type 列舉每種異動情境，包含「late_change」（工作日當天調整）
- JSONB before/after 避免 schema 改了 log 也要改
- notification_sent 確保通知不漏發、不重發
- partial index 在 late_change 上加速 cron 掃「待通知」

#### 4.2.4 attendance（修改）

```sql
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
```

**設計理由：**
- schedule_id FK 是核心：每筆打卡必須對應一筆排班，沒排班 → 無法打卡（API 層擋）
- late_minutes/early_leave_minutes 把實際分鐘數存起來，後續算扣款用
- is_holiday_work + holiday_id 連動 holidays 表，薪資計算時查倍率
- is_anomaly 旗標獨立於 status：員工真的沒來 = status='absent'（會扣日薪）；有來但有問題（打卡機壞、忘記打卡有證據等）= is_anomaly=true 等 HR 介入。同一筆 attendance 可同時是 absent + is_anomaly=true（先判曠職、待 HR 查證）

---

### 4.3 請假 + 餘額

#### 4.3.1 leave_types（新建，含 seed）

```sql
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
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO leave_types (code, name_zh, is_paid, pay_rate, affects_attendance_bonus, affects_attendance_rate, has_balance, legal_max_days_per_year, legal_reference) VALUES
  ('annual',    '特休',    true,  1.00, false, false, true,  NULL, '勞基法 §38'),
  ('sick',      '病假',    true,  0.50, true,  true,  false, 30,   '勞工請假規則 §4'),
  ('personal',  '事假',    false, 0.00, true,  true,  false, 14,   '勞工請假規則 §7'),
  ('maternity', '產假',    true,  1.00, false, false, false, NULL, '勞基法 §50'),
  ('funeral',   '喪假',    true,  1.00, false, false, false, 8,    '勞工請假規則 §3'),
  ('marriage',  '婚假',    true,  1.00, false, false, false, 8,    '勞工請假規則 §2'),
  ('comp',      '補休',    true,  1.00, false, false, true,  NULL, '勞基法 §32-1'),
  ('public',    '公假',    true,  1.00, false, false, false, NULL, '勞工請假規則 §8');
```

**設計理由：**
- 獨立字典表勝過 enum/CHECK：未來新增類型只要 INSERT
- 屬性獨立成欄：affects_attendance_bonus、affects_attendance_rate、has_balance 把所有「請假類型的特性」明確化，程式碼不寫死
- pay_rate 把「半薪」這種特殊情況納入

#### 4.3.2 leave_requests（修改）

```sql
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
```

**設計理由：**
- hours vs finalized_hours：申請當下計算的預估 vs 批准時鎖定的實扣時數（pending 期間排班可變）
- cancelled 狀態：員工 pending 期間可撤回
- start_at/end_at 用 TIMESTAMPTZ 支援精細時段（「明天 14:00-17:00 病假」）
- source_overtime_request_id 讓補休假可追溯到加班源頭
- 既有 start_date/end_date/days 欄位保留向後相容

#### 4.3.3 annual_leave_records（新建）

```sql
CREATE TABLE annual_leave_records (
  id              BIGSERIAL PRIMARY KEY,
  employee_id     TEXT NOT NULL REFERENCES employees(id),
  period_start    DATE NOT NULL,
  period_end      DATE NOT NULL,
  seniority_years NUMERIC(4,2) NOT NULL,
  legal_days      NUMERIC(4,1) NOT NULL,
  granted_days    NUMERIC(4,1) NOT NULL,
  used_days       NUMERIC(4,1) NOT NULL DEFAULT 0,
  remaining_days  NUMERIC(4,1) GENERATED ALWAYS AS (granted_days - used_days) STORED,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN (
                    'active',
                    'expired',
                    'paid_out',
                    'rolled_over'
                  )),
  settlement_amount NUMERIC(10,2),
  settled_at      TIMESTAMPTZ,
  settled_by      TEXT REFERENCES employees(id),
  note            TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (employee_id, period_start)
);

CREATE INDEX idx_annual_leave_records_employee
  ON annual_leave_records(employee_id, status);
CREATE INDEX idx_annual_leave_records_active
  ON annual_leave_records(employee_id) WHERE status = 'active';
```

**設計理由：**
- 以「週期」為單位每員工每年一筆 record，歷史可追，離職結算可看歷年明細
- legal_days vs granted_days 並存（保留彈性，公司可給優於法定）
- remaining_days GENERATED 自動算
- 四種 status 涵蓋結算所有情境
- partial index on active 加速「該員工現在的特休餘額」高頻查詢

#### 4.3.4 comp_time_balance（新建）

```sql
CREATE TABLE comp_time_balance (
  id              BIGSERIAL PRIMARY KEY,
  employee_id     TEXT NOT NULL REFERENCES employees(id),
  source_overtime_request_id BIGINT NOT NULL,
  earned_hours    NUMERIC(5,2) NOT NULL,
  earned_at       TIMESTAMPTZ NOT NULL,
  expires_at      DATE NOT NULL,
  used_hours      NUMERIC(5,2) NOT NULL DEFAULT 0,
  remaining_hours NUMERIC(5,2) GENERATED ALWAYS AS (earned_hours - used_hours) STORED,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN (
                    'active',
                    'fully_used',
                    'expired_paid',
                    'expired_void'
                  )),
  expiry_payout_amount NUMERIC(10,2),
  expiry_processed_at  TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_comp_time_balance_employee_active
  ON comp_time_balance(employee_id) WHERE status = 'active';
CREATE INDEX idx_comp_time_balance_expiring
  ON comp_time_balance(expires_at) WHERE status = 'active';
```

**設計理由：**
- 每筆加班一筆 record（不彙總）：法定 1 年失效是「每筆獨立計算」
- FIFO 使用：請補休時優先扣最舊的（程式層邏輯）
- used_hours 而非「是否使用」：一筆加班可拆多次補休完
- partial index on active 加速「員工剩多少可用補休」查詢
- partial index on expiring 給 cron 掃即將失效的

#### 4.3.5 leave_balance_logs（新建）

```sql
CREATE TABLE leave_balance_logs (
  id              BIGSERIAL PRIMARY KEY,
  employee_id     TEXT NOT NULL REFERENCES employees(id),
  balance_type    TEXT NOT NULL CHECK (balance_type IN ('annual', 'comp')),
  annual_record_id BIGINT REFERENCES annual_leave_records(id),
  comp_record_id   BIGINT REFERENCES comp_time_balance(id),
  leave_request_id TEXT REFERENCES leave_requests(id),
  change_type     TEXT NOT NULL CHECK (change_type IN (
                    'grant',
                    'use',
                    'cancel_use',
                    'manual_adjust',
                    'expire',
                    'settle'
                  )),
  hours_delta     NUMERIC(5,2) NOT NULL,
  changed_by      TEXT NOT NULL REFERENCES employees(id),
  changed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reason          TEXT
);

CREATE INDEX idx_leave_balance_logs_employee
  ON leave_balance_logs(employee_id, changed_at);
```

**設計理由：**
- append-only 永不修改的稽核軌跡
- 同時支援特休跟補休（balance_type 區分）
- 完整異動類型涵蓋給予/使用/取消/調整/失效/結算

---

### 4.4 加班

#### 4.4.1 overtime_requests（新建）

**用途：** 獨立的加班申請主表，從舊 approval_requests 抽出。原因：加班有自己的業務邏輯（上限檢查、補休/加班費分流、超時 CEO 流程），跟一般通用審批不同，獨立表才好維護。

```sql
CREATE TABLE overtime_requests (
  id              BIGSERIAL PRIMARY KEY,
  employee_id     TEXT NOT NULL REFERENCES employees(id),
  
  overtime_date   DATE NOT NULL,
  start_at        TIMESTAMPTZ NOT NULL,
  end_at          TIMESTAMPTZ NOT NULL,
  hours           NUMERIC(5,2) NOT NULL,
  
  schedule_id     TEXT REFERENCES schedules(id),
  attendance_id   TEXT REFERENCES attendance(id),
  
  request_kind    TEXT NOT NULL CHECK (request_kind IN (
                    'pre_approval',
                    'post_approval'
                  )),
  
  is_over_limit   BOOLEAN NOT NULL DEFAULT false,
  over_limit_dimensions TEXT[],
  
  compensation_type TEXT CHECK (compensation_type IN (
                    'comp_leave',
                    'overtime_pay',
                    'undecided'
                  )),
  
  estimated_pay   NUMERIC(10,2),
  pay_multiplier  NUMERIC(4,2),
  
  reason          TEXT NOT NULL,
  
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
                    'pending',
                    'pending_ceo',
                    'approved',
                    'rejected',
                    'cancelled'
                  )),
  
  manager_id          TEXT REFERENCES employees(id),
  manager_reviewed_at TIMESTAMPTZ,
  manager_decision    TEXT CHECK (manager_decision IN ('approved', 'rejected')),
  manager_note        TEXT,
  
  ceo_id              TEXT REFERENCES employees(id),
  ceo_reviewed_at     TIMESTAMPTZ,
  ceo_decision        TEXT CHECK (ceo_decision IN ('approved', 'rejected')),
  ceo_note            TEXT,
  
  reject_reason       TEXT,
  
  comp_balance_id     BIGINT REFERENCES comp_time_balance(id),
  applied_to_salary_record_id TEXT,
  
  applies_to_year     INT NOT NULL,
  applies_to_month    INT NOT NULL CHECK (applies_to_month BETWEEN 1 AND 12),
  
  submitted_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_overtime_requests_employee_month
  ON overtime_requests(employee_id, applies_to_year, applies_to_month);
CREATE INDEX idx_overtime_requests_status
  ON overtime_requests(status) WHERE status IN ('pending', 'pending_ceo');
CREATE INDEX idx_overtime_requests_pending_ceo
  ON overtime_requests(submitted_at) WHERE status = 'pending_ceo';
```

**設計理由：**
- 狀態機支援兩階段審核：一般加班 pending → approved/rejected；超時加班 pending → pending_ceo → approved/rejected
- compensation_type 在 schema 不寫死誰能改：申請當下可填 undecided，審核時改成 comp_leave/overtime_pay
- is_over_limit + over_limit_dimensions：申請時系統檢查後自動標記，陣列存超了哪些維度
- schedule_id + attendance_id 兩個 FK：建立三軌勾稽。事前申請可只連 schedule、事後申請可連 attendance
- applies_to_year/month 冗餘存儲：「必須當月內申請完，不能跨月」這個規則的核心，讓「該員工某月已申請的加班時數」查詢非常快
- comp_balance_id 連結：approved 且選 comp_leave 時自動產生 comp_time_balance row，FK 連回去
- pay_multiplier 跟著申請走：申請時依當天類型查倍率寫入，後來 holidays 改了也不影響此筆（凍結）

#### 4.4.2 overtime_limits（新建，含 seed）

```sql
CREATE TABLE overtime_limits (
  id              BIGSERIAL PRIMARY KEY,
  
  scope           TEXT NOT NULL CHECK (scope IN ('company', 'employee')),
  employee_id     TEXT REFERENCES employees(id),
  
  daily_limit_hours    NUMERIC(5,2),
  weekly_limit_hours   NUMERIC(5,2),
  monthly_limit_hours  NUMERIC(5,2),
  yearly_limit_hours   NUMERIC(6,2),
  
  monthly_hard_cap_hours NUMERIC(5,2),
  
  effective_from  DATE NOT NULL DEFAULT CURRENT_DATE,
  effective_to    DATE,
  
  note            TEXT,
  
  created_by      TEXT REFERENCES employees(id),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  
  CONSTRAINT chk_employee_scope CHECK (
    (scope = 'company' AND employee_id IS NULL) OR
    (scope = 'employee' AND employee_id IS NOT NULL)
  )
);

CREATE INDEX idx_overtime_limits_company_active
  ON overtime_limits(effective_from, effective_to)
  WHERE scope = 'company';
CREATE INDEX idx_overtime_limits_employee
  ON overtime_limits(employee_id, effective_from)
  WHERE scope = 'employee';

INSERT INTO overtime_limits 
  (scope, daily_limit_hours, weekly_limit_hours, monthly_limit_hours, monthly_hard_cap_hours, yearly_limit_hours, note)
VALUES
  ('company', 4, 12, 46, 54, NULL, '勞基法預設：日 4 小時、月 46 小時、經工會同意可至 54 小時');
```

**設計理由：**
- scope 雙模式：全公司一筆預設、特定員工覆蓋。程式層查找邏輯：先找該員工的 employee scope、找不到 fallback 到 company scope
- 四維度全可選：每個欄位 NULL 表示該維度不限制，HR 後台勾選要啟用哪些維度
- monthly_hard_cap_hours 兩段式設計：不超過 monthly_limit → 一般加班主管批；超過但不超過 hard_cap → 超時加班主管+CEO 批；超過 hard_cap → 系統直接擋
- effective_from/to 支援預設下年度上限。同一 scope 同一時間只有一筆有效

#### 4.4.3 overtime_request_logs（新建）

```sql
CREATE TABLE overtime_request_logs (
  id              BIGSERIAL PRIMARY KEY,
  request_id      BIGINT NOT NULL REFERENCES overtime_requests(id) ON DELETE CASCADE,
  
  event_type      TEXT NOT NULL CHECK (event_type IN (
                    'submitted',
                    'manager_approved',
                    'manager_rejected',
                    'ceo_approved',
                    'ceo_rejected',
                    'cancelled',
                    'compensation_changed'
                  )),
  
  actor_id        TEXT NOT NULL REFERENCES employees(id),
  actor_role      TEXT,
  
  before_data     JSONB,
  after_data      JSONB,
  note            TEXT,
  
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_overtime_request_logs_request
  ON overtime_request_logs(request_id, created_at);
```

**設計理由：**
- 跟 schedule_change_logs 一致的設計風格（append-only、JSONB before/after）
- 不用 approvals_v2 系統管：加班的特殊規則（兩階段、超時 flag、補休/加班費分流）跟 approvals_v2 通用流程不同，獨立 log 表反而清楚

---

### 4.5 出勤獎懲

#### 4.5.1 attendance_penalties（新建，含 seed）

**用途：** 後台設定遲到/早退/曠職的處置。邏輯不寫死，HR 後台調整。

```sql
CREATE TABLE attendance_penalties (
  id              BIGSERIAL PRIMARY KEY,
  
  trigger_type    TEXT NOT NULL CHECK (trigger_type IN (
                    'late',
                    'early_leave',
                    'absent',
                    'other'
                  )),
  trigger_label   TEXT NOT NULL,
  
  threshold_minutes_min INT NOT NULL DEFAULT 0,
  threshold_minutes_max INT,
  
  monthly_count_threshold INT,
  
  penalty_type    TEXT NOT NULL CHECK (penalty_type IN (
                    'deduct_money',
                    'deduct_money_per_min',
                    'deduct_attendance_bonus',
                    'deduct_attendance_bonus_pct',
                    'warning',
                    'custom'
                  )),
  
  penalty_amount  NUMERIC(10,2),
  penalty_cap     NUMERIC(10,2),
  
  custom_action_note TEXT,
  
  is_active       BOOLEAN NOT NULL DEFAULT true,
  display_order   INT NOT NULL DEFAULT 0,
  
  effective_from  DATE NOT NULL DEFAULT CURRENT_DATE,
  effective_to    DATE,
  
  description     TEXT,
  
  created_by      TEXT REFERENCES employees(id),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_attendance_penalties_active
  ON attendance_penalties(trigger_type, threshold_minutes_min)
  WHERE is_active = true;

INSERT INTO attendance_penalties 
  (trigger_type, trigger_label, threshold_minutes_min, threshold_minutes_max, penalty_type, penalty_amount, description) 
VALUES
  ('late', '遲到', 1, NULL, 'deduct_money_per_min', 0, '預設不扣，HR 後台自行設定金額'),
  ('early_leave', '早退', 1, NULL, 'deduct_money_per_min', 0, '預設不扣，HR 後台自行設定金額'),
  ('absent', '曠職一日', 0, NULL, 'deduct_attendance_bonus', 0, '預設不扣，HR 後台自行設定');
```

**設計理由：**
- 觸發條件分級（threshold_minutes_min/max）：可設「遲到 5 分鐘內罰輕、超過罰重」這種階梯規則。每階一筆 row
- penalty_type 六種涵蓋常見處置方式
- monthly_count_threshold：實務常見「該月第 3 次遲到才扣」這種規則
- penalty_cap：避免員工遲到 3 小時被扣 9000 元這種誇張情況
- effective_from/to：HR 可預先設定明年規則、舊規則保留歷史
- Seed 預設不扣：避免裝完就吃到員工錢，HR 上線前要明確設定
- 注意：曠職的「扣日薪」不在此表處理（金額不固定，由薪資模組依當時日薪即時計算），此表只管「遲到/早退/輕微違規」

#### 4.5.2 attendance_penalty_records（新建）

```sql
CREATE TABLE attendance_penalty_records (
  id              BIGSERIAL PRIMARY KEY,
  employee_id     TEXT NOT NULL REFERENCES employees(id),
  attendance_id   TEXT REFERENCES attendance(id),
  
  penalty_rule_id BIGINT REFERENCES attendance_penalties(id),
  
  trigger_type    TEXT NOT NULL,
  trigger_minutes INT,
  
  penalty_type    TEXT NOT NULL,
  penalty_amount  NUMERIC(10,2) NOT NULL,
  
  applies_to_year  INT NOT NULL,
  applies_to_month INT NOT NULL CHECK (applies_to_month BETWEEN 1 AND 12),
  
  salary_record_id TEXT,
  
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
                    'pending',
                    'applied',
                    'waived'
                  )),
  waived_by       TEXT REFERENCES employees(id),
  waived_at       TIMESTAMPTZ,
  waive_reason    TEXT,
  
  manual_action_taken TEXT,
  
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_penalty_records_employee_month
  ON attendance_penalty_records(employee_id, applies_to_year, applies_to_month);
CREATE INDEX idx_penalty_records_pending
  ON attendance_penalty_records(applies_to_year, applies_to_month) 
  WHERE status = 'pending';
```

**設計理由：**
- 快照規則 ID + 實際扣款金額：規則修改後不影響歷史
- waived 狀態：HR 有彈性豁免（員工解釋遲到合理、主管同意取消）
- applies_to_year/month 跟薪資對齊
- status 三段：pending（剛紀錄）→ applied（薪資已扣）。waived 是平行狀態（取消）

#### 4.5.3 attendance_monthly_summary VIEW（新建）

```sql
CREATE OR REPLACE VIEW attendance_monthly_summary AS
SELECT
  e.id AS employee_id,
  e.name,
  EXTRACT(YEAR FROM a.work_date)::INT AS year,
  EXTRACT(MONTH FROM a.work_date)::INT AS month,

  COUNT(DISTINCT a.work_date) FILTER (WHERE a.status = 'normal') AS normal_days,
  COUNT(DISTINCT a.work_date) FILTER (WHERE a.status = 'late') AS late_days,
  COUNT(DISTINCT a.work_date) FILTER (WHERE a.status = 'early_leave') AS early_leave_days,
  COUNT(DISTINCT a.work_date) FILTER (WHERE a.status = 'absent') AS absent_days,
  COUNT(DISTINCT a.work_date) FILTER (WHERE a.is_anomaly = true) AS anomaly_days,

  COALESCE(SUM(a.work_hours), 0) AS total_work_hours,
  COALESCE(SUM(a.overtime_hours), 0) AS total_overtime_hours,
  COALESCE(SUM(a.late_minutes), 0) AS total_late_minutes,
  COALESCE(SUM(a.early_leave_minutes), 0) AS total_early_leave_minutes

FROM employees e
LEFT JOIN attendance a ON a.employee_id = e.id
GROUP BY e.id, e.name, EXTRACT(YEAR FROM a.work_date), EXTRACT(MONTH FROM a.work_date);
```

**設計理由：**
- VIEW 而非 materialized view：即時計算，永遠是最新
- 只統計打卡資料，請假/懲處資料另查
- 未來資料量大效能不夠時，再升級為 materialized view + cron 每天 refresh
- 不建出勤率 VIEW：出勤率公式涉及 leave_types 屬性、holidays 表，邏輯複雜，直接寫純函式 lib/attendance/rate.js 比寫複雜 VIEW 好維護

---

### 4.6 薪資 + 系統設定

#### 4.6.1 salary_records（大改）

```sql
ALTER TABLE salary_records ADD COLUMN IF NOT EXISTS
  overtime_pay_auto NUMERIC(10,2) NOT NULL DEFAULT 0;
ALTER TABLE salary_records ADD COLUMN IF NOT EXISTS
  overtime_pay_manual NUMERIC(10,2) NOT NULL DEFAULT 0;
ALTER TABLE salary_records ADD COLUMN IF NOT EXISTS
  overtime_pay_note TEXT;

ALTER TABLE salary_records ADD COLUMN IF NOT EXISTS
  comp_expiry_payout NUMERIC(10,2) NOT NULL DEFAULT 0;

ALTER TABLE salary_records ADD COLUMN IF NOT EXISTS
  attendance_penalty_total NUMERIC(10,2) NOT NULL DEFAULT 0;

ALTER TABLE salary_records ADD COLUMN IF NOT EXISTS
  attendance_bonus_base NUMERIC(10,2) NOT NULL DEFAULT 0;
ALTER TABLE salary_records ADD COLUMN IF NOT EXISTS
  attendance_bonus_deduction_rate NUMERIC(4,3) NOT NULL DEFAULT 0;
ALTER TABLE salary_records ADD COLUMN IF NOT EXISTS
  attendance_bonus_actual NUMERIC(10,2);

ALTER TABLE salary_records ADD COLUMN IF NOT EXISTS
  absence_days NUMERIC(4,1) NOT NULL DEFAULT 0;
ALTER TABLE salary_records ADD COLUMN IF NOT EXISTS
  daily_wage_snapshot NUMERIC(10,2);

ALTER TABLE salary_records ADD COLUMN IF NOT EXISTS
  holiday_work_pay NUMERIC(10,2) NOT NULL DEFAULT 0;

ALTER TABLE salary_records ADD COLUMN IF NOT EXISTS
  settlement_amount NUMERIC(10,2) NOT NULL DEFAULT 0;
ALTER TABLE salary_records ADD COLUMN IF NOT EXISTS
  settlement_note TEXT;

-- 反向 FK 補上（前面 Section 已宣告）
ALTER TABLE attendance_penalty_records 
  ADD CONSTRAINT fk_penalty_records_salary
  FOREIGN KEY (salary_record_id) REFERENCES salary_records(id);

ALTER TABLE overtime_requests
  ADD CONSTRAINT fk_overtime_requests_salary
  FOREIGN KEY (applied_to_salary_record_id) REFERENCES salary_records(id);

ALTER TABLE leave_requests
  ADD CONSTRAINT fk_leave_requests_overtime
  FOREIGN KEY (source_overtime_request_id) REFERENCES overtime_requests(id);

ALTER TABLE comp_time_balance
  ADD CONSTRAINT fk_comp_time_balance_overtime
  FOREIGN KEY (source_overtime_request_id) REFERENCES overtime_requests(id);

-- 重建 gross_salary / net_salary 為新公式 GENERATED column
-- 注意：實際執行時要先 backfill 才能 DROP/RECREATE
ALTER TABLE salary_records DROP COLUMN gross_salary;
ALTER TABLE salary_records DROP COLUMN net_salary;
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
    base_salary
    + COALESCE(attendance_bonus_actual, 0)
    + COALESCE(allowance, 0)
    + COALESCE(extra_allowance, 0)
    + COALESCE(overtime_pay_auto + overtime_pay_manual, 0)
    + COALESCE(comp_expiry_payout, 0)
    + COALESCE(holiday_work_pay, 0)
    + COALESCE(settlement_amount, 0)
    - COALESCE(deduct_absence, 0)
    - COALESCE(deduct_labor_ins, 0)
    - COALESCE(deduct_health_ins, 0)
    - COALESCE(deduct_tax, 0)
    - COALESCE(attendance_penalty_total, 0)
  ) STORED;
```

**設計理由：**
- overtime_pay 拆兩欄 auto + manual：自動算的 vs HR 手動補的，分開存便於追溯
- GENERATED column 用 STORED 不用 VIRTUAL：Postgres VIRTUAL 不支援查詢用，STORED 寫入時計算、讀取時直接回傳
- daily_wage_snapshot 凍結：曠職扣薪要用「該月當時的日薪」算，月中加薪不溯及
- attendance_bonus_* 三欄拆開：base（員工檔設定）→ deduction_rate（扣除比例）→ actual（最終給的），HR 看薪資單可看到計算過程
- FK 反向接回去：penalty_records、overtime_requests、leave_requests 都連到 salary_records，形成完整勾稽
- comp_time_balance.source_overtime_request_id 的 FK 在這裡才補：comp_time_balance 在 §4.3 建立時 overtime_requests 還沒存在，等 §4.6 才能補 FK

#### 4.6.2 system_overtime_settings（新建）

```sql
CREATE TABLE system_overtime_settings (
  id              SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  
  comp_expiry_action TEXT NOT NULL DEFAULT 'auto_payout' CHECK (
    comp_expiry_action IN ('auto_payout', 'manual_review', 'void')
  ),
  
  comp_expiry_warning_days INT NOT NULL DEFAULT 30,
  
  weekday_overtime_first_2h_rate  NUMERIC(4,2) NOT NULL DEFAULT 1.34,
  weekday_overtime_after_2h_rate  NUMERIC(4,2) NOT NULL DEFAULT 1.67,
  rest_day_overtime_first_2h_rate NUMERIC(4,2) NOT NULL DEFAULT 1.34,
  rest_day_overtime_after_2h_rate NUMERIC(4,2) NOT NULL DEFAULT 1.67,
  
  monthly_work_hours_base INT NOT NULL DEFAULT 240,
  
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_by      TEXT REFERENCES employees(id)
);

INSERT INTO system_overtime_settings (id) VALUES (1) 
  ON CONFLICT DO NOTHING;
```

**設計理由：**
- 單一 row 設計（id = 1）：系統級設定通常只有一筆，用 CHECK 強制
- 倍率不寫死：把所有「金額計算的倍率」集中
- comp_expiry_action 給補休失效彈性選擇：自動轉錢、人工處理、作廢
- 時薪基準 240：勞基法工時上限對應，後台可調

---

## 5. 跨表關聯圖（六個 Section 整合）

```text
┌─────────────────────────────────────────────────────────────────┐
│  基礎資料層 (Section 1)                                          │
│  holidays  shift_types  employees                                │
└─────────────────────────────────────────────────────────────────┘
│
↓
┌─────────────────────────────────────────────────────────────────┐
│  排班 + 打卡 (Section 2)                                         │
│  schedule_periods → schedules → attendance                       │
│                        │                                          │
│                        └─→ schedule_change_logs                  │
└─────────────────────────────────────────────────────────────────┘
│
↓
┌─────────────────────────────────────────────────────────────────┐
│  請假 + 餘額 (Section 3)                                         │
│  leave_types ──→ leave_requests                                  │
│                       │                                           │
│  annual_leave_records ←┴→ comp_time_balance                      │
│            └─────────→ leave_balance_logs ←─────────┘            │
└─────────────────────────────────────────────────────────────────┘
│
↓
┌─────────────────────────────────────────────────────────────────┐
│  加班 (Section 4)                                                │
│  overtime_requests → overtime_request_logs                       │
│       │                                                          │
│       ├─→ schedule_id  (Section 2)                              │
│       ├─→ attendance_id (Section 2)                              │
│       ├─→ comp_balance_id (Section 3)                            │
│       └─→ applied_to_salary_record_id (Section 6)                │
│                                                                   │
│  overtime_limits (後台設定)                                      │
└─────────────────────────────────────────────────────────────────┘
│
↓
┌─────────────────────────────────────────────────────────────────┐
│  獎懲 (Section 5)                                                │
│  attendance_penalties → attendance_penalty_records               │
│                              │                                    │
│                              └─→ salary_record_id (Section 6)    │
└─────────────────────────────────────────────────────────────────┘
│
↓
┌─────────────────────────────────────────────────────────────────┐
│  薪資 (Section 6)                                                │
│  salary_records (gross/net 自動計算)                             │
│       ↑                                                          │
│       ├── overtime_pay_auto       ← overtime_requests            │
│       ├── comp_expiry_payout      ← comp_time_balance            │
│       ├── attendance_penalty_total ← attendance_penalty_records  │
│       ├── attendance_bonus_actual ← lib/attendance/bonus.js      │
│       ├── deduct_absence          ← attendance (status=absent)   │
│       ├── holiday_work_pay        ← attendance (is_holiday_work) │
│       └── settlement_amount      ← annual_leave_records (paid_out)│
│                                                                   │
│  system_overtime_settings (補休失效處理、倍率設定)               │
└─────────────────────────────────────────────────────────────────┘
```

---

## 6. Cron Jobs 清單

| 時機 | 任務 | API 進入點 | lib 純函式模組 |
|---|---|---|---|
| 每日 00:15 | 曠職判定（昨日已 lock 但無打卡） | api/cron-absence-detection.js | lib/attendance/absence-sweep.js |
| 每日 00:30 | 排班自動鎖定（approved → locked） | api/cron-schedule-lock.js | lib/schedule/lock-sweep.js |
| 每日 01:00 | 補休失效處理（依 system_overtime_settings.comp_expiry_action） | api/cron-comp-expiry.js | lib/comp-time/expiry-sweep.js |
| 每日 02:00 | 補休失效預警（即將失效 N 天） | api/cron-comp-expiry-warning.js | lib/comp-time/expiry-warning.js |
| 每日 03:00 | 特休週年滾動（結算上週期 + 建立新週期） | api/cron-annual-leave-rollover.js | lib/leave/annual-rollover.js |
| 每月 26 日 09:00 | 排班送出提醒（下月份 status='draft' 的員工） | api/cron-schedule-reminder.js | lib/schedule/reminder.js |

**架構說明：** 每個 cron 都遵循「API 進入點 = thin wrapper、業務邏輯 = lib/ 純函式」的設計，跟 approvals_v2 同款。lib/ 純函式可單獨單元測試。

**late_change 通知不走 cron：** schedule_change_logs 中 change_type='late_change' 的紀錄（工作日當天的排班調整）由 schedule API 即時觸發推播給 HR + CEO，而非靠 cron sweep。schema 上的 notification_sent 旗標 + partial index 仍保留，供未來查報表 / 補發通知用。

---

## 7. lib/ 模組規劃（純函式架構）

跟 approvals_v2 同樣風格：所有業務邏輯放在 lib/ 純函式，API handler 是 thin wrapper。

```text
lib/
├── holidays/
│   ├── parser.js           # data.gov.tw 匯入 parser
│   └── lookup.js           # 查當天是不是國定假日、回 multiplier
│
├── schedule/
│   ├── period-state.js     # 排班週期狀態機（draft/submitted/approved/locked）
│   ├── permissions.js      # 員工/主管的排班權限規則
│   ├── work-hours.js       # 工時計算（含跨日、含休息扣除）
│   ├── lock-sweep.js       # cron：自動鎖定到期週期
│   └── change-logger.js    # 異動紀錄寫入
│
├── attendance/
│   ├── clock.js            # 打卡邏輯（驗證 schedule、算遲到/早退/加班）
│   ├── bonus.js            # 全勤獎金扣除比例計算
│   ├── rate.js             # 實際出席率計算（給績效用）
│   ├── penalty.js          # 套用獎懲規則
│   └── absence-sweep.js    # cron：曠職判定
│
├── leave/
│   ├── types.js            # 請假類型查詢輔助
│   ├── annual.js           # 特休年資 → 法定天數計算（勞基法 §38）
│   ├── annual-rollover.js  # cron：特休週年滾動
│   ├── balance.js          # 餘額查詢與異動
│   └── request-flow.js     # 請假申請流程
│
├── overtime/
│   ├── limits.js           # 上限查詢與檢查（個人 → 全公司 fallback）
│   ├── request-state.js    # 加班申請狀態機（含超時 CEO 流程）
│   ├── pay-calc.js         # 加班費計算（依倍率）
│   └── comp-conversion.js  # 加班 → 補休轉換
│
├── comp-time/
│   ├── balance.js          # 補休餘額查詢
│   ├── expiry-sweep.js     # cron：失效處理
│   └── expiry-warning.js   # cron：失效預警
│
├── salary/
│   ├── calculator.js       # 薪資計算主流程（聚合所有來源）
│   ├── attendance-bonus.js # 全勤獎金套用
│   ├── overtime-aggregator.js # 加班費聚合
│   ├── penalty-applier.js  # 懲處套用
│   └── settlement.js       # 結算項目（特休結算等）
│
└── roles.js                # （已存在）權限身份判定
```

---

## 8. Migration 三批計畫

### 8.1 Batch A：純新增表（零風險）

**內容：**
- holidays
- leave_types（含 seed）
- annual_leave_records
- comp_time_balance
- leave_balance_logs
- overtime_requests
- overtime_limits（含 seed）
- overtime_request_logs
- attendance_penalties（含 seed）
- attendance_penalty_records
- system_overtime_settings（含 default row）
- schedule_change_logs
- attendance_monthly_summary VIEW

**Prod 影響：** 零（新表，舊系統不引用）

**回滾：** DROP TABLE 即可

### 8.2 Batch B：既有表新增欄位（中風險）

**內容：**
- shift_types：補 break_minutes、is_active
- employees：補 annual_leave_seniority_start
- schedule_periods：補 year/month、三個 timestamp、UNIQUE 約束
- schedules：補 period_id、segment_no、start/end_time、crosses_midnight、scheduled_work_minutes、改 UNIQUE
- attendance：補 schedule_id、segment_no、late_minutes、early_leave_minutes、is_holiday_work、holiday_id、status='anomaly'
- leave_requests：補 hours、finalized_hours、start_at、end_at、reviewed_by、reviewed_at、reject_reason、source_overtime_request_id、status='cancelled'、補 FK to leave_types

**Prod 影響：** 既有 SELECT 不影響（新欄位不出現）；既有 INSERT 不影響（新欄位有 DEFAULT 或 NULLABLE）

**回滾：** ALTER TABLE DROP COLUMN

**Backfill 動作：**

```sql
-- employees.annual_leave_seniority_start = hire_date
UPDATE employees SET annual_leave_seniority_start = hire_date
WHERE annual_leave_seniority_start IS NULL;
ALTER TABLE employees ALTER COLUMN annual_leave_seniority_start SET NOT NULL;

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
-- 既有 shift_types.start_time/end_time 在 §4.2.2 PATCH 1 已 ALTER 為 TIME，此時可正常做時間相減
UPDATE schedules s
SET scheduled_work_minutes = (
  EXTRACT(EPOCH FROM (st.end_time - st.start_time)) / 60 - st.break_minutes
)::INT
FROM shift_types st
WHERE s.shift_type_id = st.id
  AND s.scheduled_work_minutes IS NULL
  AND st.start_time IS NOT NULL
  AND st.end_time IS NOT NULL;
```

### 8.3 Batch C：salary_records 大改（高風險）

**內容：**
- 補大量新欄位（overtime_pay_auto/manual、comp_expiry_payout、attendance_penalty_total、attendance_bonus_*、daily_wage_snapshot、holiday_work_pay、settlement_amount 等）
- DROP gross_salary / net_salary，重建為新公式 GENERATED column
- 補反向 FK（penalty_records、overtime_requests、leave_requests → salary_records）

**Prod 影響：** 大——舊薪資紀錄 gross/net 會重新計算

**回滾：** 困難（GENERATED column 改動很難無痛回滾）

**做法：**

```sql
-- 步驟 1：取既有 gross_salary / net_salary 快照
CREATE TABLE _salary_backup AS 
SELECT id, gross_salary, net_salary FROM salary_records;

-- 步驟 2：補新欄位（先 NULLABLE / DEFAULT 0）
-- 見 §4.6.1 的 ALTER TABLE 區塊

-- 步驟 3：Backfill 既有 salary_records
UPDATE salary_records SET 
  overtime_pay_auto = 0,
  overtime_pay_manual = COALESCE(overtime_pay, 0),
  comp_expiry_payout = 0,
  attendance_penalty_total = 0,
  attendance_bonus_base = COALESCE(bonus, 0),
  attendance_bonus_deduction_rate = 0,
  attendance_bonus_actual = COALESCE(bonus, 0),
  absence_days = 0,
  daily_wage_snapshot = base_salary / 30,
  holiday_work_pay = 0,
  settlement_amount = 0;

-- 步驟 4：DROP / RECREATE gross_salary / net_salary（新公式）
-- 見 §4.6.1 的 ALTER TABLE 區塊

-- 步驟 5：比對驗證
SELECT s.id, b.gross_salary AS old_gross, s.gross_salary AS new_gross,
       b.gross_salary - s.gross_salary AS gross_diff,
       b.net_salary AS old_net, s.net_salary AS new_net,
       b.net_salary - s.net_salary AS net_diff
FROM salary_records s
JOIN _salary_backup b ON b.id = s.id
WHERE b.gross_salary != s.gross_salary
   OR b.net_salary != s.net_salary;
-- 預期 0 row。若有差異要 debug 後修正 backfill。

-- 步驟 6：確認無誤後 DROP backup table
DROP TABLE _salary_backup;
```

### 8.4 執行順序
Batch A (純新增)
→ 驗收：跑完整 vitest suite
Batch B (補欄位 + backfill)
→ 驗收：跑完整 vitest suite + 手測排班/打卡/請假流程
Batch C (薪資改 GENERATED)
→ 驗收：salary 比對 SQL 結果 0 row + 抽查幾筆薪資單

---

## 9. 關鍵決策摘要（rationale）

本節記錄設計取捨的「為什麼」，讓未來看文件的人理解設計意圖、判斷邊界 case 是否屬於原意圖。

### 9.1 為什麼一天可多段班（`segment_no`）
支援臨時調整空間。實務上一天可能拆「上午門市 → 中午午休 → 下午支援倉儲」，每段時間 / 班別 / 部門可不同。`segment_no` 給每段排班一個序號，避免一日 = 一行的限制。

### 9.2 為什麼班別不綁職位
每次排班開放選項。班別字典與職位字典脫鉤，主管排班時可從所有 active 班別中挑選；不會因為員工換職位就被綁死能排哪些班。彈性 > 約束。

### 9.3 為什麼員工送出後不能改
**月份開始即鎖定，責任歸主管。** 員工自排階段送出後即關閉自助修改入口；從該時點起任何異動都走主管手；責任邊界清楚 — 排錯班不是員工事後改的，是主管要負責。

### 9.4 為什麼主管當天可改
實務需求 — 員工臨時請假、突發情況都需要當天動班。**但強制留紀錄通知 HR + CEO**：每筆當天改動寫進 `schedule_change_logs`，並觸發通知。彈性給主管，可追溯交給 HR + CEO。

### 9.5 為什麼特休 `legal_days` 與 `granted_days` 並存
**保留公司彈性給予。** `legal_days` 是勞基法強制給的天數（依年資），`granted_days` 是公司實際授予（可 ≥ legal）。兩者並存讓「公司多給」可被記錄、可被調整，不會把法定下限與公司福利混為一談。

### 9.6 為什麼補休 1:1 不依倍率
**1:1 是時間補償，倍率只在轉錢時用。** 加班 1 小時 = 補休 1 小時，這是「以時間換時間」；如果加班費要 1.34 倍那是「以時間換錢」要倍率。不混兩件事 — 員工選補休就拿等量時間，選加班費才走倍率。

### 9.7 為什麼超時加班必含 CEO
**法令層級的決策，主管無權獨斷。** 月加班 46–54 小時是勞基法 §32 容許但需特殊條件的範圍；這個層級的決策超出部門主管的職權，必須由 CEO 介入背書。系統把「主管自批」與「CEO 必含」用流程強制分流。

### 9.8 為什麼 `overtime_pay` 拆 `auto` / `manual`
**可追溯系統算的 vs HR 補的。** `overtime_pay_auto` 是系統依出勤資料 + 規則自動計算的金額；`overtime_pay_manual` 是 HR 額外手動加減的金額。兩欄分開讓未來稽核時可分辨「這是系統錯了還是 HR 故意」、也讓系統升級時可以單獨重算 auto 欄不影響 manual 調整。

### 9.9 為什麼 `daily_wage_snapshot` 凍結
**扣薪要用當時日薪，加薪不溯及。** 員工當月 5 號曠職一天要扣的日薪，是依「曠職當下」的薪資算，不是依「月底結算時」可能已調過的薪資算。凍結快照避免薪資結算因為月中加薪而被回頭重算。

### 9.10 為什麼 `monthly_hard_cap` 兩段式設計
**46 一般 / 54 走 CEO / 超過 54 擋，符合勞基法 §32。**
- 0 ~ 46 小時：一般加班，主管批即可
- 47 ~ 54 小時：仍合法但需特殊程序，必須走 CEO 流程
- 超過 54 小時：系統硬擋，不允許申請

兩段式映射勞基法的「上限」與「條件式上限」，把法令邊界內建到資料模型而不是靠 HR 記憶。

---

## 10. 階段 0 業務規則摘要（已確認的所有決策）

### 10.1 整體
- 薪資 + 出勤全勾稽：所有資料從員工動作到薪資數字必須有自動串接路徑，不允許 HR 手動橋
- 為績效管理鋪底：出勤資料結構要清晰完整，績效管理會基於此擴充

### 10.2 排班
- 班別不綁職位/員工屬性，每次排班開放選項
- 支援固定、彈性、跨日班（22:00-06:00）
- 月為單位（四週彈性工時制）
- 彈性休息 1 小時不計入工時（排 9-18 = 工時 8 小時）
- 三階段流程：員工自排（draft）→ 員工送出 → 主管確認（submitted）→ 主管定案（approved → locked）
- 一次排一個月
- Deadline：當月 25 號前排完下個月
- 員工可請整天不排（要被主管審核）
- 一天可上多段班（不限段數，schema 支援、UI 預設單段）

### 10.3 排班權限規則
| 角色 | 月底排班期 | 員工已送出後 | 月份開始後 | 工作日當天 |
|---|---|---|---|---|
| 員工 | 可排可重排 | 不能改 | 不能改 | 不能改 |
| 主管 | 可調整 | 可調整 | 可調整 | 可調整 |

- 員工後續調整需求 → 向主管提出申請
- 所有主管調整強制留紀錄
- 工作日當天調整 → 通知 HR + 執行長
- 主管覺得排班不行直接改，不需要駁回流程

### 10.4 國定假日
- 方案 C：手動為主 + 政府開放資料匯入按鈕 + 匯入後 HR 可調整
- 類型（開放列表）：國定假日 / 補行上班日 / 公司自訂休息日 / 彈性放假
- 一天只能一個類型
- pay_multiplier 預設 2.00
- 開放在國定假日排班，依法定倍率計算薪資
- 四週彈性工時制下，國定假日基本不會主動排

### 10.5 打卡
- 必須對應已定案排班
- 沒排班 → 拒絕打卡
- 排了班沒打卡 → 自動標記曠職 + 異常標示
- 無寬限時間：排 14:00 班，14:03 打卡就算遲到
- 遲到一律留紀錄，處置依「出勤獎懲設定」
- 跨日班屬於開始那一天

### 10.6 請假
- 請假時數 = 該日實際工時（含休息扣除）
- 例：排 9-18（含 1hr 休息）= 請 8 小時特休
- pending 期間排班可變動
- 批准時：實際扣請假時數依當下排班計算（沒班就不扣）
- 駁回時：視為「申請從未發生」，員工恢復正常排班狀態
- 特休完整版：餘額管理 + 年資計算 + 排班年度（週年制）+ 特休結算（轉工資 / 失效）
- 特休年資保留彈性（法定計算 + 公司可調整 granted_days）

### 10.7 補休
- 1:1 換算（加班幾小時 = 補休幾小時）
- 失效規則：法定 1 年
- 走跟請假同樣的審批流程，計算方式不同（扣 comp_time_balance）
- 失效後必須轉加班費
- 後台選項設定：自動轉 / 人工處理 / 作廢（保留彈性）

### 10.8 出勤計算（兩套並存）
- 薪資用「出勤」：影響全勤獎金，特休/補休不扣
- 績效用「實際出席率」：獨立演算法
- 共用分母 = 當月工作日（扣週末、扣國定假日，不用排班日數）
- 遲到早退按比例計算
- 不預存，查詢時即時計算

### 10.9 加班
- 上限維度：每日 / 每週 / 每月 / 每年（全部支援，後台選擇啟用）
- 上限綁定：全公司統一 / 個人個別調整(兩種都支援）
- 兩段式上限：monthly_limit 一般 / monthly_hard_cap 走 CEO / 超過 hard_cap 擋
- 超時加班必含執行長審核
- 必須當月內申請完，不能跨月
- 通過時數獨立，不併入下月上限
- 補償方式：審核者決定補休 / 加班費，申請頁面說明「由公司決定」

### 10.10 三軌連動（薪資勾稽核心）
打卡 attendance.overtime_hours
  ↓
員工申請加班（事前/事後 / 一般 / 超時）
  ↓
審核（主管 → 必要時 CEO → 決定補休/加班費）
  ↓
├─ 補休：comp_time_balance ++
└─ 加班費：salary.overtime_pay 自動填

---

## 附錄 A：本文件待補項目對照表

| Section | 待補內容 | 來源 |
|---|---|---|
| 4.1 ~ 4.6 | 各表 SQL + 設計理由 + seed | Ray 分批貼 |
| 5 | 跨表關聯圖 | Ray 階段 1 文件 Section 6 結尾 |
| 7 | `lib/` 完整目錄結構 | Ray 階段 1 文件 Section 6.6 |
| 10 | 階段 0 業務規則完整版 | Ray 階段 0 文件 |
| 6 | 各 cron 對應 lib 模組 | Section 7 補齊後回填 |
| 8 | 各 batch 精確 SQL + backfill | Section 4 收齊後產出 |

---

## 附錄 B：與既有系統的關聯

本設計與 repo 中既有實作的關係：

| 既有 | 本設計處置 |
|---|---|
| `supabase_setup.sql` 的 `attendance` / `leave_requests` / `salary_records` | §4.2 / §4.3 / §4.6 透過 ALTER 擴充 |
| `supabase_schedule.sql` 的 `shift_types` / `schedules` / `schedule_periods` | §4.1 / §4.2 透過 ALTER 擴充；既有 `shift_swap_requests` 暫不在本設計 scope |
| `supabase_extra_allowance.sql` 的 `extra_allowance` 欄位 | 保留，§4.6 `salary_records` 大改時一併納入 |
| `supabase_approvals_v2.sql` (`approvals_v2_*`) | 平行系統，本設計不動。加班申請改走獨立的 `overtime_requests` 表（§4.4），不寄生在 approvals_v2 |
| 舊 `approval_requests` 中的 `overtime` / `overtime_pay` request_type | 上線後停用；既有資料如何處理待 Ray 決定 |
| `schedule_periods.dept` | Legacy 欄位：既有系統以 dept 為單位排班，本設計改為員工為單位（employee_id）。dept 保留向後相容，本系統不再使用 |

---

**文件結束。** v1.0 為設計骨架版本，待 Ray 分批補齊 §4 / §5 / §7 / §10 後升 v1.1。
