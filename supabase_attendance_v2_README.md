# Supabase Attendance v2 — Migration SQL Files

對應設計文件：[`docs/attendance-system-design-v1.md`](docs/attendance-system-design-v1.md) v1.0
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

## 三個檔案的執行順序

| # | 檔案 | 內容 | 風險 |
|---|---|---|---|
| 1 | `supabase_attendance_v2_batch_a.sql` | 純新增 12 表 + 1 VIEW + seed | 🟢 零 |
| 2 | `supabase_attendance_v2_batch_b.sql` | 既有 6 表 ALTER + backfill | 🟡 中 |
| 3 | `supabase_attendance_v2_batch_c.sql` | salary_records 大改 + GENERATED column 重建 | 🔴 高 |

順序固定：**A → B → C**。前一批驗收完才跑下一批。

---

## Batch A：純新增表

### 內容（13 物件）
- `holidays`
- `leave_types` + 8 筆 seed（annual / sick / personal / maternity / funeral / marriage / comp / public）
- `annual_leave_records`
- `comp_time_balance` — 注意 `source_overtime_request_id BIGINT NOT NULL` 但**暫不加 FK**，等 Batch C 補
- `leave_balance_logs`
- `overtime_requests`
- `overtime_limits` + 1 筆 company seed（4/12/46 + hard_cap 54）
- `overtime_request_logs`
- `attendance_penalties` + 3 筆 seed（late / early_leave / absent，金額 0）
- `attendance_penalty_records` — `salary_record_id BIGINT` **暫不加 FK**，等 Batch C 補
- `system_overtime_settings` + 1 筆 default row（id=1）
- `schedule_change_logs`
- `attendance_monthly_summary` VIEW

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

## Batch B：既有表新增欄位 + backfill

### 內容（6 表 ALTER）
- `shift_types`：補 `break_minutes`、`is_active`
- `employees`：補 `annual_leave_seniority_start`
- `schedule_periods`：補 `period_year`、`period_month`、三個 timestamp、UNIQUE 約束
- `schedules`：補 `period_id`、`segment_no`、`start_time`、`end_time`、`crosses_midnight`、`scheduled_work_minutes`、改 UNIQUE
- `attendance`：補 `schedule_id`、`segment_no`、`late_minutes`、`early_leave_minutes`、`is_holiday_work`、`holiday_id`、`is_anomaly`、`anomaly_note`；status CHECK 收斂為 6 值（移除 'anomaly'）
- `leave_requests`：補 `hours`、`finalized_hours`、`start_at`、`end_at`、`reviewed_by`、`reviewed_at`、`reject_reason`、`source_overtime_request_id`、status CHECK 加 'cancelled'、補 FK to leave_types

### 順序
SQL 檔案分三段：
- **段 1**：所有 ALTER TABLE ADD COLUMN（先 NULLABLE 或有 DEFAULT）
- **段 2**：backfill UPDATE（employees / schedules）
- **段 3**：將先前 NULLABLE 的欄位升 NOT NULL（目前只有 `employees.annual_leave_seniority_start`）

### Backfill 注意事項
1. `employees.annual_leave_seniority_start = hire_date`
2. `schedules.period_id` 兩階段：
   - 先 INSERT 缺失的 `schedule_periods`（依既有 `schedules.date` 反推）
   - 再 UPDATE `schedules.period_id` 連回去
3. `schedules.segment_no = 1`（既有資料都是單段，DEFAULT 已是 1，UPDATE 是防呆）
4. `schedules.scheduled_work_minutes`：依 `shift_types.start_time / end_time / break_minutes` 計算

### 回滾
- 段 1 失敗：`ALTER TABLE ... DROP COLUMN ...`
- 段 2 失敗：把 backfill 寫的 UPDATE 反向（將欄位設回 NULL）
- 段 3 失敗：`ALTER TABLE employees ALTER COLUMN annual_leave_seniority_start DROP NOT NULL;`

---

## Batch C：salary_records 大改

### 內容
1. CREATE TABLE `_salary_backup`（用於 GENERATED column 重建後比對）
2. 補大量新欄位 ALTER（`overtime_pay_auto/manual`、`comp_expiry_payout`、`attendance_penalty_total`、`attendance_bonus_*`、`absence_days`、`daily_wage_snapshot`、`holiday_work_pay`、`settlement_amount` 等）
3. 反向 FK ALTER 共 4 條：
   - `attendance_penalty_records.salary_record_id` → salary_records
   - `overtime_requests.applied_to_salary_record_id` → salary_records
   - `leave_requests.source_overtime_request_id` → overtime_requests
   - `comp_time_balance.source_overtime_request_id` → overtime_requests
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

## 我發現但**未自作主張修正**的設計疑點

依「逐字複製、不自作主張優化」原則，以下 design doc 與 prod schema 的潛在落差**沒在 SQL 檔內修正**，僅列出供 Ray 評估：

### 1. `attendance` 表欄位名 `date` vs `work_date`
- design §4.5.3 VIEW 與 §8.2 backfill 用 `a.date` / `s.date`
- 既有 `supabase_setup.sql` 與 `supabase_schedule.sql` 用的是 `work_date`
- 結果：VIEW 與 backfill SQL 在 prod 會回 `column does not exist`

### 2. `attendance_monthly_summary` VIEW 仍 filter `a.status = 'anomaly'`
- design §4.2.4 patch 已把 'anomaly' 從 attendance.status CHECK 移除（改成 boolean `is_anomaly`）
- 但 §4.5.3 VIEW 沒同步更新，仍有 `COUNT(...) FILTER (WHERE a.status = 'anomaly') AS anomaly_days`
- 結果：VIEW 不會壞，但 `anomaly_days` 永遠回 0（dead column）

### 3. `schedule_periods` 缺 `employee_id` 欄位
- design §4.2.1 ALTER 加 UNIQUE(`employee_id`, period_year, period_month)
- 既有 `supabase_schedule.sql` 的 `schedule_periods` 沒有 `employee_id` 欄位（有的是 `dept`）
- 結果：UNIQUE 約束會失敗（column does not exist）；§8.2 backfill 也會失敗
- 需新增 `employee_id` 欄位，design 漏寫

### 4. `schedule_periods` 補 `period_year INT NOT NULL` 無 DEFAULT
- 若 prod `schedule_periods` 已有 row，`ADD COLUMN ... NOT NULL` 無 DEFAULT 會失敗
- 需先 NULLABLE add → backfill → 加 NOT NULL
- design §4.2.1 寫法直接 NOT NULL 不安全

### 5. `schedules` `start_time` / `end_time` 型別衝突
- 既有 `supabase_schedule.sql` 是 `TEXT`
- design §4.2.2 ADD COLUMN 寫 `TIME`
- 用 `IF NOT EXISTS` → 不會新增（因為欄位已存在），新欄位的 TIME 型別不會生效
- 需 `ALTER COLUMN ... TYPE TIME USING start_time::TIME`

### 6. `schedules.date` 同樣是 `work_date`
- §8.2 backfill 用 `s.date`，但實際是 `s.work_date`

### 7. `leave_requests.leave_type` FK
- 既有 prod 可能有 `leave_type` 值不在 `leave_types.code` 字典裡的紀錄（因為原本沒 FK）
- 加 FK 前需 backfill 對齊（design 沒處理）

**建議**：Batch 10 前 Ray 跟我說一聲，我做一輪 design doc patch（同樣方式 commit + push）解決上述疑點，再產 v2 的 SQL 檔。本次 Batch 1 仍依「逐字複製」原則交付。

---

## Backfill 與 prod 資料量

prod 既有資料量推測：
- `salary_records`：少量（系統剛起步）→ Batch C backfill 應快
- `schedules`：少量
- `attendance`：少量
- `leave_requests`：少量

實際 row 數請 Ray 上 prod 前確認：
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
