# Supabase Attendance v2 — Migration SQL Files

對應設計文件：[`docs/attendance-system-design-v1.md`](docs/attendance-system-design-v1.md) v1.0（commit 8721a2f）
對應實作計畫：[`docs/attendance-system-implementation-plan-v1.md`](docs/attendance-system-implementation-plan-v1.md) §3 (Batch 1) + §12 (Batch 10)

---

## ⚠ 重要：Ray 不要現在執行

這三個 SQL 檔案是 **Batch 10 才執行** 的 prod migration。
現在（Batch 1 完成時）只是把檔案產出來給 Ray 審查、放進 repo。

**禁止：**
- 直接複製到 Supabase Dashboard SQL Editor 執行
- 在本地 supabase 跑（除非 Ray 自己決定要做 dev rehearsal）

**Batch 2-9 期間** Claude Code 會在 repo 裡寫 lib/ + API + UI，假設這些 schema 已存在；但 prod 不動。
**Batch 10 期間** Ray 親手依 `attendance-system-implementation-plan-v1.md` §12 流程執行。

---

## v2.0 — 對齊 prod schema 的修正（相對 commit 540423d）

本次重產對齊 design doc commit `8721a2f`，相對舊版（commit `540423d`）有以下修正：

### Batch A 變動
- `schedule_change_logs.schedule_id`：BIGINT → **TEXT**（schedules.id 是 TEXT PRIMARY KEY）
- `overtime_requests.schedule_id` / `attendance_id` / `applied_to_salary_record_id`：BIGINT → **TEXT**
- `attendance_penalty_records.attendance_id` / `salary_record_id`：BIGINT → **TEXT**
- `leave_balance_logs.leave_request_id`：BIGINT → **TEXT**（leave_requests.id 是 TEXT）
- `attendance_monthly_summary VIEW`：
  - `a.date` → `a.work_date`（共 7 處：4 個 EXTRACT、5 個 FILTER 來源、2 個 GROUP BY）
  - `anomaly_days` filter 從 `a.status = 'anomaly'` → `a.is_anomaly = true`

### Batch B 變動（改動最大）
- `schedule_periods` 補 `employee_id TEXT REFERENCES employees(id)`（既有表沒有此欄位）
- `schedule_periods` 補 `period_start DATE` / `period_end DATE`（design backfill SQL 用到的欄位）
- `schedule_periods.period_year` / `period_month` 改為 **NULLABLE 加 → backfill → SET NOT NULL** pattern（原本是 NOT NULL，prod 表非空時會 fail）
- `schedule_periods` 新增 backfill UPDATE：legacy dept-based row 的 `period_year/month/period_start/end` 從既有 `start_date/end_date` 推
- `schedule_periods` 段 3 NOT NULL 包括：`employee_id` / `period_year` / `period_month` / `period_start` / `period_end`（共 5 條）
- `schedules.period_id`：BIGINT → **TEXT**
- `schedules.start_time` / `end_time`：補 `ALTER COLUMN ... TYPE TIME USING NULLIF(..., '')::TIME`（既有 prod 是 TEXT，IF NOT EXISTS 對 ADD COLUMN 會 skip，要明確 ALTER TYPE）
- `shift_types.start_time` / `end_time`：同上 ALTER TYPE TIME（**這是 Batch B 的事，不是 Batch A 的事**）
- `schedules` UNIQUE 約束從 `(employee_id, date, segment_no)` → `(employee_id, work_date, segment_no)`（既有 schema 用 work_date）
- `attendance.schedule_id`：BIGINT → **TEXT**
- §8.2 backfill SQL 全文 `s.date` → `s.work_date`（共 7 處）
- §8.2 backfill `INSERT INTO schedule_periods` 補 `id` 欄位（schedule_periods.id 是 TEXT NOT NULL PRIMARY KEY 沒 default，要明確產 id：`'s_period_' || employee_id || '_YYYY_MM'`）
- §8.2 backfill 末段 `UPDATE scheduled_work_minutes` 加註解說明 shift_types 已 ALTER 為 TIME
- §4.3.2 `leave_requests` `fk_leave_requests_type` 加 sanity check 註解（prod 既有 leave_type 值若不在 leave_types.code 字典裡，FK ADD 會 fail；prod 當前 leave_requests 為空，無此疑慮）

### Batch C 變動
- 反向 FK 區塊**內容不變**：型別由 column 決定，column 在 Batch A/B 已對齊，FK 自然合法。
  - `overtime_requests.applied_to_salary_record_id` = TEXT → salary_records.id (TEXT) ✓
  - `attendance_penalty_records.salary_record_id` = TEXT → salary_records.id (TEXT) ✓
  - `leave_requests.source_overtime_request_id` = BIGINT → overtime_requests.id (BIGSERIAL) ✓
  - `comp_time_balance.source_overtime_request_id` = BIGINT → overtime_requests.id (BIGSERIAL) ✓

---

## 三個檔案的執行順序

| # | 檔案 | 內容 | 風險 |
|---|---|---|---|
| 1 | `supabase_attendance_v2_batch_a.sql` | 純新增 12 表 + 1 VIEW + seed | 🟢 零 |
| 2 | `supabase_attendance_v2_batch_b.sql` | 既有 6 表 ALTER + ALTER TYPE TIME + backfill + NOT NULL | 🟡 中 |
| 3 | `supabase_attendance_v2_batch_c.sql` | salary_records 大改 + GENERATED column 重建 | 🔴 高 |

順序固定：**A → B → C**。前一批驗收完才跑下一批。

---

## Batch A：純新增表

### 內容（13 物件）
- `holidays`
- `leave_types` + 8 筆 seed（annual / sick / personal / maternity / funeral / marriage / comp / public）
- `annual_leave_records`
- `comp_time_balance` — `source_overtime_request_id BIGINT NOT NULL` 但**暫不加 FK**，等 Batch C 補
- `leave_balance_logs` — `leave_request_id TEXT REFERENCES leave_requests(id)` ✓
- `overtime_requests` — `schedule_id` / `attendance_id` / `applied_to_salary_record_id` 皆 TEXT
- `overtime_limits` + 1 筆 company seed（4/12/46 + hard_cap 54）
- `overtime_request_logs`
- `attendance_penalties` + 3 筆 seed（late / early_leave / absent，金額 0）
- `attendance_penalty_records` — `attendance_id TEXT`、`salary_record_id TEXT` 但**暫不加 FK**，等 Batch C 補
- `system_overtime_settings` + 1 筆 default row（id=1）
- `schedule_change_logs` — `schedule_id TEXT REFERENCES schedules(id) ON DELETE SET NULL`
- `attendance_monthly_summary` VIEW — 用 `a.work_date`、`is_anomaly = true`

### Backfill
無（純新增）

### 回滾
```sql
DROP TABLE IF EXISTS attendance_penalty_records;
DROP TABLE IF EXISTS attendance_penalties;
DROP TABLE IF EXISTS overtime_request_logs;
DROP TABLE IF EXISTS overtime_requests;
DROP TABLE IF EXISTS overtime_limits;
DROP TABLE IF EXISTS leave_balance_logs;
DROP TABLE IF EXISTS comp_time_balance;
DROP TABLE IF EXISTS annual_leave_records;
DROP TABLE IF EXISTS leave_types;
DROP TABLE IF EXISTS holidays;
DROP TABLE IF EXISTS schedule_change_logs;
DROP TABLE IF EXISTS system_overtime_settings;
DROP VIEW IF EXISTS attendance_monthly_summary;
```

---

## Batch B：既有表新增欄位 + ALTER TYPE + backfill

### 內容（6 表 ALTER）
- `shift_types`：補 `break_minutes`、`is_active`；既有 `start_time` / `end_time` ALTER TYPE TEXT → TIME
- `employees`：補 `annual_leave_seniority_start`
- `schedule_periods`：補 `employee_id` (TEXT)、`period_year` / `period_month` (NULLABLE)、`period_start` / `period_end` (NULLABLE)、三個 timestamp、UNIQUE 約束
- `schedules`：補 `period_id` (**TEXT**)、`segment_no`、`start_time` / `end_time`、`crosses_midnight`、`scheduled_work_minutes`、改 UNIQUE 用 `work_date`；既有 TEXT `start_time` / `end_time` ALTER TYPE → TIME
- `attendance`：補 `schedule_id` (**TEXT**)、`segment_no`、`late_minutes`、`early_leave_minutes`、`is_holiday_work`、`holiday_id`、`is_anomaly`、`anomaly_note`；status CHECK 收斂為 6 值（移除 'anomaly'）
- `leave_requests`：補 `hours`、`finalized_hours`、`start_at`、`end_at`、`reviewed_by`、`reviewed_at`、`reject_reason`、`source_overtime_request_id`、status CHECK 加 'cancelled'、補 FK to leave_types（含 sanity check 註解）

### 順序
SQL 檔案分三段：
- **段 1**：所有 ALTER（ADD COLUMN / ALTER TYPE / DROP+ADD CHECK / DROP+ADD UNIQUE）
- **段 2**：所有 backfill UPDATE / INSERT
  - `employees.annual_leave_seniority_start = hire_date`
  - `schedule_periods` legacy row 推 period_year/month/period_start/end
  - `schedules.period_id` 兩階段（建缺失的 `schedule_periods` → UPDATE schedules）
  - `schedules.segment_no = 1`
  - `schedules.scheduled_work_minutes` 依 shift_type 計算（shift_types 已 ALTER 為 TIME）
- **段 3**：NOT NULL（共 6 條）
  - `employees.annual_leave_seniority_start`
  - `schedule_periods.employee_id` / `period_year` / `period_month` / `period_start` / `period_end`

### Backfill 注意事項
1. shift_types 與 schedules 的 `start_time` / `end_time` 從 TEXT 升級為 TIME 用 `USING NULLIF(col, '')::TIME` — 空字串會被當 NULL 處理
2. schedule_periods.id 是 TEXT NOT NULL PRIMARY KEY 沒 default，§8.2 INSERT 必須產 id（用 `'s_period_' || employee_id || '_YYYY_MM'` pattern）
3. schedule_periods 段 3 NOT NULL 對 legacy dept-based row 會 fail（因為這類 row 沒 employee_id）。**prod 此表為空（0 row），可直接執行**；若未來 dev rehearsal 環境有 legacy row，先 DELETE 或 backfill employee_id

### 回滾
- 段 1 失敗：`ALTER TABLE ... DROP COLUMN ...`、`ALTER TABLE ... ALTER COLUMN ... TYPE TEXT USING ...::TEXT`
- 段 2 失敗：把 backfill 寫的 UPDATE 反向（將欄位設回 NULL）
- 段 3 失敗：`ALTER TABLE ... ALTER COLUMN ... DROP NOT NULL;`

---

## Batch C：salary_records 大改

### 內容
1. CREATE TABLE `_salary_backup`（用於 GENERATED column 重建後比對）
2. 補大量新欄位 ALTER（`overtime_pay_auto/manual`、`comp_expiry_payout`、`attendance_penalty_total`、`attendance_bonus_*`、`absence_days`、`daily_wage_snapshot`、`holiday_work_pay`、`settlement_amount` 等）
3. 反向 FK ALTER 共 4 條：
   - `attendance_penalty_records.salary_record_id` → salary_records（column = TEXT）
   - `overtime_requests.applied_to_salary_record_id` → salary_records（column = TEXT）
   - `leave_requests.source_overtime_request_id` → overtime_requests（column = BIGINT）
   - `comp_time_balance.source_overtime_request_id` → overtime_requests（column = BIGINT）
4. UPDATE backfill 既有 `salary_records`（把 `bonus` 搬到 `attendance_bonus_*`、`overtime_pay` 搬到 `overtime_pay_manual` 等）
5. DROP `gross_salary` / `net_salary`
6. ADD GENERATED column 新公式（包含所有新增來源）

### 步驟 7、8 必須手動執行
SQL 檔最後兩步**以註解形式包起來**，Ray 上 prod 時自行解註解：
- **步驟 7**：比對驗證 SELECT（找 backup vs 新公式 gross/net 的差異，預期 0 row）
- **步驟 8**：DROP `_salary_backup`（驗證無誤後才跑）

### Backfill 注意事項
- `daily_wage_snapshot = base_salary / 30` 是預設快照公式（後續月度結算時應改為「該月實際工作日數」）
- `attendance_bonus_actual = COALESCE(bonus, 0)` 把舊的 `bonus` 欄位內容移植過來
- `overtime_pay_manual = COALESCE(overtime_pay, 0)` 把舊的 `overtime_pay` 移到 manual 欄
- 既有 `gross_salary` / `net_salary` 既然是 GENERATED column，重建後**會自動依新公式重算**；§5 比對 SELECT 用來確認新舊公式對齊

### 比對驗證後處置
- **0 row diff**：執行步驟 8 DROP `_salary_backup`
- **有 row diff**：**不要繼續**。用 §12.3 Step 3 的 `salary_records_pre_v2_backup`（執行 Batch C 前 Ray 應建立的整表備份）還原，debug backfill SQL 後重跑

### 回滾（最壞情況）
依設計文件 §8.3：
- 「困難（GENERATED column 改動很難無痛回滾）」
- 實務做法：執行 Batch C 前先建 `salary_records_pre_v2_backup`（整表複製），失敗時 TRUNCATE + INSERT 還原

---

## Backfill 與 prod 資料量

prod 既有資料量（commit 8721a2f 時實測）：
- `salary_records`：少量
- `schedules`：**564 rows**
- `attendance`：1 row
- `leave_requests`：0 row（empty）
- `schedule_periods`：0 row（empty）

實際 row 數請 Ray 上 prod 前再確認：
```sql
SELECT
  (SELECT COUNT(*) FROM salary_records) AS salary_count,
  (SELECT COUNT(*) FROM schedules) AS schedule_count,
  (SELECT COUNT(*) FROM attendance) AS attendance_count,
  (SELECT COUNT(*) FROM leave_requests) AS leave_count,
  (SELECT COUNT(*) FROM schedule_periods) AS period_count;
```

---

## 文件結束

執行細節請對照 `docs/attendance-system-implementation-plan-v1.md` §12 Batch 10。
