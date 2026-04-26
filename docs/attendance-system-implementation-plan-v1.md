# 出勤核心系統實作計畫 v1.0

| 項目 | 內容 |
|---|---|
| 版本 | v1.0 |
| 撰寫日期 | 2026-04-25 |
| 對應設計文件 | docs/attendance-system-design-v1.md (v1.0) |
| 狀態 | 實作階段 — 等 Ray 拍板進入 Batch 1 |
| 預估工作量 | 10 個 Batch（前 1 批純 SQL、中 8 批功能、最後 1 批 prod migration） |

---

## 0. 工作模式（重要）

**這份文件是給 Claude Code 看的執行 spec，但每批進度由 Ray 控制。**

1. **每批一個明確 deliverable**：每批做完有具體可驗收的產出
2. **每批做完停下回報**：Ray 看完驗收，說「進下一批」才繼續
3. **不能自動跳批**：即使下一批看起來很順、很想做，也要停
4. **scope 外的改動先問**：發現需要超出本批計畫的改動要先問 Ray
5. **每批驗收條件嚴格遵守**：不滿足就不算完成
6. **遇到不清楚的地方先問再做**

**Ray 操作模式：**
- Ray 會把每批指令貼給 Claude Code
- Claude Code 完成後回報，Ray 會對話討論
- 進入 prod 的步驟（Batch 10）由 Ray 親手執行，Claude Code 只給 SQL

---

## 1. 整體計畫概觀

| Batch | 內容 | 性質 | 預估規模 |
|---|---|---|---|
| 1 | SQL Migration 檔案 | 純檔案產出，不上 prod | 3 個 SQL 檔 + README |
| 2 | 國定假日（lib + API + UI） | 功能實作 | ~500 lines |
| 3 | 排班三階段流程 | 功能實作 | ~1200 lines |
| 4 | 打卡對應排班 + 曠職判定 | 功能實作 | ~600 lines |
| 5 | 請假 + 特休完整版 | 功能實作 | ~1000 lines |
| 6 | 補休系統 | 功能實作 | ~600 lines |
| 7 | 加班系統 | 功能實作 | ~1200 lines |
| 8 | 出勤獎懲 | 功能實作 | ~500 lines |
| 9 | 薪資勾稽 | 功能實作 | ~800 lines |
| 10 | Prod Migration + Deploy | Prod 操作 | Ray 親手執行 |

**總體流程：**
- Batch 1 產出所有 SQL 檔案，但不執行
- Batch 2-9 在 repo 裡寫 lib + API + UI + tests，但不上 prod（schema 還沒在 prod）
- Batch 10 才動 prod：執行 SQL → deploy code → 啟用 cron

**為什麼這樣排：** 系統未上線、可一次到位。Batch 1-9 都在 repo 內完成、tests 全跑、code review 完成；Batch 10 一次動 prod。風險集中在 Batch 10，前面九批沒風險。

---

## 2. 共通規則（每批都適用）

### 2.1 Code 風格

- ESM only（package.json 已 type=module）
- 所有 lib/ 模組為純函式（no I/O，DB 透過 repo 層注入）
- API handler 是 thin wrapper：權限檢查 → 呼叫 lib → 回 HTTP
- 不用 trigger 寫狀態機

### 2.2 測試

- 每批都要有 vitest 單元測試
- lib/ 純函式 100% 覆蓋
- 每批做完跑 `npx vitest run`，全綠才算完成
- Test file 命名：`tests/{module}.test.js`

### 2.3 不准動的東西

- 既有 `lib/approvals_v2/` 模組（平行系統，本計畫不涉及）
- 既有 `lib/roles.js` 與 `public/js/roles.js`（已穩定）
- 既有 `requireRole` / `requireRoleOrPass` 的 dev-mode pass-through 行為（轉嚴格不在本計畫 scope）
- 既有 `supabase_*.sql` 檔案（本計畫產獨立 migration 檔）

### 2.4 提交規則

- 每批做完 git add + commit，但**不 push**（Ray 自己決定何時 push）
- Commit message 格式：`feat(attendance): batch N - <短描述>`

---

## 3. Batch 1：SQL Migration 檔案

### 3.1 Deliverable

產出三個 SQL 檔案，放在 repo 根目錄：

1. `supabase_attendance_v2_batch_a.sql`
2. `supabase_attendance_v2_batch_b.sql`
3. `supabase_attendance_v2_batch_c.sql`

外加一份說明文件：

4. `supabase_attendance_v2_README.md`

### 3.2 檔案內容規範

#### Batch A SQL：純新增表

包含設計文件 §4 中所有「新建」的表 + seed：

- holidays（§4.1.1）
- leave_types + seed（§4.3.1）
- annual_leave_records（§4.3.3）
- comp_time_balance（§4.3.4，注意：source_overtime_request_id 暫不加 FK，等 Batch C 補）
- leave_balance_logs（§4.3.5）
- overtime_requests（§4.4.1）
- overtime_limits + seed（§4.4.2）
- overtime_request_logs（§4.4.3）
- attendance_penalties + seed（§4.5.1）
- attendance_penalty_records（§4.5.2）
- system_overtime_settings + default row（§4.6.2）
- schedule_change_logs（§4.2.3）
- attendance_monthly_summary VIEW（§4.5.3）

每張表前面加 `-- ========== {table_name} ==========` 分隔註解。

每張表的 SQL 內容**逐字**從設計文件複製，不修改、不簡化。

檔案開頭加 header：
```sql
-- =====================================================
-- supabase_attendance_v2_batch_a.sql
-- 出勤核心系統 v2.0 - Batch A：純新增表（零風險）
-- 對應設計文件：docs/attendance-system-design-v1.md §4
-- 執行時機：在跑 Batch B 之前
-- 回滾方式：DROP TABLE 即可（見 README）
-- =====================================================
```

#### Batch B SQL：既有表新增欄位 + backfill

包含設計文件 §4 中所有「修改」的表的 ALTER：

- shift_types（§4.1.2）
- employees（§4.1.3，含 backfill）
- schedule_periods（§4.2.1）
- schedules（§4.2.2，含 segment_no DEFAULT 1）
- attendance（§4.2.4，含 is_anomaly 旗標）
- leave_requests（§4.3.2）

外加 §8.2 的所有 backfill SQL（schedules.period_id 等）。

順序：
1. 所有 ALTER TABLE
2. 所有 backfill UPDATE
3. NOT NULL 約束加上去（要 backfill 完才能加）

#### Batch C SQL：salary_records 大改

包含 §4.6.1 的全部 ALTER + §8.3 的完整流程：

1. CREATE TABLE _salary_backup AS SELECT 快照
2. 補新欄位 ALTER TABLE
3. 反向 FK ALTER TABLE（含 comp_time_balance 那條）
4. Backfill UPDATE
5. DROP gross_salary / net_salary
6. ADD COLUMN GENERATED 重建
7. 比對驗證 SELECT（註解形式，提示 Ray 執行）
8. DROP TABLE _salary_backup（註解形式，等 Ray 確認後才執行）

#### README 內容

- 三個檔案的執行順序
- 每個檔案的風險等級
- 每個檔案的 backfill 注意事項
- 回滾方式
- 「Ray 不要現在執行」的明確警告

### 3.3 驗收條件

1. 三個 SQL 檔案存在 repo 根目錄
2. README 存在
3. SQL 檔案內容跟設計文件 §4 完全一致（grep 抽檢幾條 CREATE TABLE / ALTER TABLE 比對）
4. Seed 資料正確：
   - leave_types 八筆
   - overtime_limits 一筆（company scope）
   - attendance_penalties 三筆
   - system_overtime_settings 一筆 default row
5. 不執行任何 SQL 在 prod
6. 不修改既有 supabase_*.sql 檔案
7. 跑 `npx vitest run` 仍全綠（不應該影響到任何測試）
8. git add + commit 三個 SQL + README，commit message：`feat(attendance): batch 1 - SQL migration files`

### 3.4 完成後 Claude Code 該做的事

1. 列出三個檔案的 wc -l 與 grep -c 'CREATE TABLE' 與 'ALTER TABLE' 計數
2. 跑一次 vitest 確認沒破壞既有測試
3. git status 確認只動了預期的檔案
4. 報告完成、等 Ray 進 Batch 2

### 3.5 給 Claude Code 的指令模板

[Ray 執行時：把以下整段貼給 Claude Code]
進 Batch 1：SQL Migration 檔案。
請依 docs/attendance-system-implementation-plan-v1.md §3 的規範，產出：

supabase_attendance_v2_batch_a.sql
supabase_attendance_v2_batch_b.sql
supabase_attendance_v2_batch_c.sql
supabase_attendance_v2_README.md

SQL 內容逐字從 docs/attendance-system-design-v1.md §4 與 §8 複製，不簡化、不重組。
完成後做 §3.4 的四件事，回報結果。
不要丟 prod。不要動既有檔案。不要進 Batch 2。

---

## 4. Batch 2：國定假日（lib + API + UI）

### 4.1 Deliverable

**Lib（純函式）：**
- `lib/holidays/parser.js` — data.gov.tw 政府開放資料的 CSV/JSON parser
- `lib/holidays/lookup.js` — 查當天是否國定假日、回傳 pay_multiplier

**API：**
- `api/holidays/index.js` — GET（列表，支援年度篩選） / POST（新建單筆）
- `api/holidays/[id].js` — PUT（修改單筆） / DELETE（刪除單筆）
- `api/holidays/import.js` — POST（從 data.gov.tw 匯入年度資料）

**UI：**
- `public/holidays-admin.html` — HR 後台管理頁

**測試：**
- `tests/holidays-parser.test.js` — parser 純函式測試
- `tests/holidays-lookup.test.js` — lookup 純函式測試

### 4.2 lib/holidays/parser.js 規範

純函式，輸入是 data.gov.tw 回傳的 raw 資料（JSON），輸出是 holidays 表的 row 陣列。

**function 簽名：**
```javascript
export function parseGovHolidays(rawData, year) {
  // 回傳：[{ date, holiday_type, name, description, pay_multiplier, source: 'imported', imported_from: 'data.gov.tw' }, ...]
}
```

**邏輯：**
- 把政府公告的日曆資料映射到 holidays 表的 holiday_type：
  - 「國定假日」/「紀念日」/「節日」→ `national`
  - 「補行上班」→ `makeup_workday`
  - 「彈性放假」→ `flexible`
  - 不認識的類型 → 跳過 + console.warn
- pay_multiplier 對 national 給 2.00、其他給 1.00
- 回傳的陣列要 dedupe（同一天只一筆）

**測試 cases：**
- 標準年度資料正常 parse
- 補行上班日正確識別
- 彈性放假正確識別
- 未知類型跳過 + warn
- 同日重複資料只回一筆

### 4.3 lib/holidays/lookup.js 規範

**function 簽名：**
```javascript
export async function getHolidayInfo(repo, date) {
  // 回傳：{ isHoliday: boolean, holiday_type, pay_multiplier, holiday_id }
  // 找不到回傳 { isHoliday: false }
}
```

**重點：** 接收 repo 介面（不直接依賴 supabase），讓測試可以注入 mock。

### 4.4 API 規範

#### `api/holidays/index.js`

- **GET**：query params 支援 `year`（必填）、`type`（選填）
  - 權限：所有員工可讀（後台會用，員工 app 也會用）
  - 回傳：holidays 陣列
- **POST**：HR / admin 才能新建
  - body：date / holiday_type / name / description / pay_multiplier
  - source 自動填 `manual`
  - 回傳新建的 row

#### `api/holidays/[id].js`

- **PUT / DELETE**：權限 HR / admin
- 修改時不影響 source 欄位

#### `api/holidays/import.js`

- **POST**：權限 HR / admin
- body：`{ year: number }`
- 流程：
  1. 從 data.gov.tw 抓資料（具體 URL 由 Claude Code 找；我建議查一下 [data.gov.tw 政府行政機關辦公日曆表](https://data.gov.tw/dataset/14718)）
  2. 用 `lib/holidays/parser.js` 解析
  3. 用 transaction 寫入 holidays 表
  4. 回傳：`{ imported: N, skipped: M, errors: [...] }`
- 如果該年已有 imported 資料，先刪除再重新匯入（讓 HR 重匯時資料不會疊加）
- 但 **HR 手動建立的不刪**（source='manual' 的不動）

### 4.5 UI 規範（holidays-admin.html）

設計風格沿用既有後台頁面（如 `public/announcement-admin.html`）。

**畫面元素：**
1. 年度切換器（下拉選單，預設今年）
2. 「從 data.gov.tw 匯入 {year} 年度」按鈕（會顯示確認對話框）
3. 假日列表（表格）：日期 / 類型 / 名稱 / 倍率 / 來源 / 操作（編輯 / 刪除）
4. 「新增假日」按鈕（彈出表單）
5. 編輯 / 新增表單欄位：日期 / 類型（下拉） / 名稱 / 描述 / 倍率（預設 2.00）
6. 顯示「source: 匯入」/「source: 手動」標示

**權限：** 整個頁面只有 HR / admin 看得到（在 sidebar 控制）。

### 4.6 驗收條件

1. 兩個 lib 純函式檔存在、單元測試全綠
2. 三個 API 檔存在、API 能正確回應（不需要 prod 真的有 holidays 表，因為還沒上 prod；用 mock 測）
3. 一個 UI 頁面存在、能本地打開（即使 API 還沒能跑也要結構正確）
4. 跑 `npx vitest run` 全綠
5. git status 確認只動了預期的檔案
6. git commit message：`feat(attendance): batch 2 - holidays system`
7. 不 push

### 4.7 給 Claude Code 的指令模板

[Ray 執行時：把以下整段貼給 Claude Code]
進 Batch 2：國定假日系統。
請依 docs/attendance-system-implementation-plan-v1.md §4 的規範實作。
關鍵注意點：

lib/ 純函式，repo 介面注入式設計（不直接依賴 supabase）
data.gov.tw 的具體 URL 自己找，找不到就在 README.md 註明 TODO
UI 沿用既有後台頁面風格，不要自創新風格

完成後做 §4.6 驗收，回報結果，等我說「進 Batch 3」。

---

## 5. Batch 3：排班三階段流程

### 5.1 Deliverable

**Lib（純函式）：**
- `lib/schedule/period-state.js` — 排班週期狀態機（draft / submitted / approved / locked）
- `lib/schedule/permissions.js` — 員工 / 主管的排班權限判定
- `lib/schedule/work-hours.js` — 工時計算（含跨日、含休息扣除、多段班加總）
- `lib/schedule/lock-sweep.js` — cron：自動鎖定到期週期
- `lib/schedule/change-logger.js` — 異動紀錄寫入
- `lib/schedule/reminder.js` — cron：26 號排班送出提醒

**API：**
- `api/schedule-periods/index.js` — GET（員工/主管查週期清單） / POST（員工建立 draft）
- `api/schedule-periods/[id]/submit.js` — POST（員工送出 draft → submitted）
- `api/schedule-periods/[id]/approve.js` — POST（主管 submitted → approved）
- `api/schedules/index.js` — GET / POST 改動
- `api/schedules/[id].js` — PUT / DELETE
- `api/cron-schedule-lock.js` — cron entry
- `api/cron-schedule-reminder.js` — cron entry

**UI：**
- `public/employee-schedule.html` — 員工自排頁（重做，原檔備份為 `.old`）
- `public/schedule.html` — 主管確認 + 定案頁（重做，原檔備份為 `.old`）

**測試：**
- `tests/schedule-period-state.test.js`
- `tests/schedule-permissions.test.js`
- `tests/schedule-work-hours.test.js`
- `tests/schedule-change-logger.test.js`

### 5.2 lib/schedule/period-state.js 規範

純 reducer 設計，跟 `lib/approvals_v2/state-machine.js` 同款。

**function 簽名：**
```javascript
export const SCHEDULE_PERIOD_STATES = ['draft', 'submitted', 'approved', 'locked'];

export function canTransition(fromState, action, actor) {
  // actor: { is_employee_self, is_manager, is_system }
  // action: 'submit' | 'approve' | 'adjust' | 'lock'
  // 回傳：{ ok: boolean, nextState?, reason? }
}
```

**Transition 規則（合法的）：**

| from | action | to | actor 條件 |
|---|---|---|---|
| draft | submit | submitted | is_employee_self |
| submitted | approve | approved | is_manager |
| submitted | adjust | submitted | is_manager（主管調整但仍 submitted） |
| approved | adjust | approved | is_manager（定案後主管又改，仍 approved） |
| approved | lock | locked | is_system（cron 月份開始觸發） |
| locked | adjust | locked | is_manager（鎖定後主管當天改） |

其他組合都回 `{ ok: false, reason }`。

### 5.3 lib/schedule/permissions.js 規範

```javascript
export function canEmployeeEditSchedule(period, employee_id, today) {
  // 員工只能在 status='draft' 且 employee_id 是自己時可改
  // 月份開始後永遠不能改（即使 status 還是 draft，這種情況是員工沒按時送出）
  // 回傳：{ ok: boolean, reason? }
}

export function canManagerEditSchedule(period, manager, today) {
  // 主管任何時候都可改（包含 locked 狀態）
  // 但需要是該員工的主管或 HR
  // 回傳：{ ok: boolean, isLateChange: boolean }
  // isLateChange = true 代表工作日當天改（要觸發通知）
}
```

### 5.4 lib/schedule/work-hours.js 規範

```javascript
export function calculateScheduleWorkMinutes(startTime, endTime, breakMinutes, crossesMidnight) {
  // 回傳：分鐘數（INT）
  // 跨日：如果 crossesMidnight=true，end < start 視為跨日
  // 例：22:00-06:00 = 8h - break = 480 - break minutes
}

export function calculateDailyTotalMinutes(segments) {
  // segments: [{ start_time, end_time, break_minutes, crosses_midnight }, ...]
  // 回傳：該員工該日全部段加總
}

export function detectSegmentOverlap(segments) {
  // 回傳：[{ segmentA, segmentB }] 重疊的對；無重疊回 []
}
```

### 5.5 lib/schedule/lock-sweep.js 規範

cron 觸發：每天 00:30 跑一次。

```javascript
export async function runLockSweep(repo, today) {
  // 找出 status='approved' 且 period_year/month 對應的月份已過第 1 天的 schedule_periods
  // 改成 status='locked'，寫 schedule_change_logs（change_type='system_lock'）
  // 回傳：{ locked_count: N }
}
```

### 5.6 lib/schedule/change-logger.js 規範

```javascript
export async function logScheduleChange(repo, {
  schedule_id,
  employee_id,
  change_type,
  changed_by,
  before_data,
  after_data,
  reason,
  isLateChange
}) {
  // 寫入 schedule_change_logs
  // 如果 isLateChange=true，notification_sent=false（讓後續通知系統處理）
  // 回傳新建的 log id
}
```

### 5.7 lib/schedule/reminder.js 規範

cron 觸發：每月 26 日 09:00。

```javascript
export async function runScheduleReminder(repo, today) {
  // 找出下個月的 schedule_periods 中還是 status='draft' 的員工
  // 對每個員工發站內通知（透過 lib/push.js）
  // 回傳：{ reminded_count: N }
}
```

### 5.8 API 規範（重點）

#### `api/schedule-periods/index.js`

- **GET**：
  - query：`year` / `month` / `employee_id`（HR 可指定看別人）
  - 員工只能看自己；主管能看下屬；HR 能看全部
  - 回傳：包含 schedule_periods + 對應的 schedules（一次撈完）

- **POST**：
  - body：`{ year, month }`
  - 建立該員工該月的 schedule_periods（status='draft'）
  - 員工自己建（or HR 代建）

#### `api/schedule-periods/[id]/submit.js`

- **POST**：員工送出 draft → submitted
- 檢查：必須是 employee_id 本人、必須有至少一筆 schedules

#### `api/schedule-periods/[id]/approve.js`

- **POST**：主管定案 submitted → approved
- 檢查：必須是該員工的主管或 HR

#### `api/schedules/index.js` 與 `[id].js`

- 員工只能改自己的 draft 期間的 schedules
- 主管隨時可改任何 schedule
- 主管改的時候若是 locked 狀態 + 工作日當天，標 isLateChange=true，觸發通知（即時推播 HR + CEO，不靠 cron）

### 5.9 UI 規範

#### `public/employee-schedule.html`（員工自排）

**畫面元素：**
1. 月份切換器（預設下個月）
2. 月曆（28-31 天，週一到週日格子）
3. 每天可點：選班別 / 選時段 / 加段次
4. 「請整天不排」選項
5. 多段班 UI（預設單段，按「加一段」才出第二段）
6. 底部：「送出主管確認」按鈕（draft → submitted）
7. 狀態提示：`draft`=可編輯、`submitted`=唯讀「已送出，等主管確認」、`approved`/`locked`=唯讀

**禁用條件：**
- 員工已送出後，UI 全部 disabled
- 月份開始後，UI 全部 disabled
- 顯示明確的禁用原因訊息

#### `public/schedule.html`（主管確認 + 定案）

**畫面元素：**
1. 月份切換器
2. 部門員工列表 + 每人的排班週期狀態（draft/submitted/approved/locked）
3. 點員工 → 進入該員工的排班月曆（跟員工頁類似但全可編輯）
4. 「定案」按鈕（submitted → approved）
5. 主管調整時，自動檢查 isLateChange，若是當天改：
   - 跳出確認對話框「此調整會通知 HR + CEO，確定送出？」
   - 確認後寫入 change_log + 觸發推播

### 5.10 驗收條件

1. 六個 lib 純函式檔存在、四個測試檔全綠
2. 七個 API 檔存在
3. 兩個 UI 頁面存在、原檔備份為 `.old`
4. 跑 `npx vitest run` 全綠
5. 手測（在 Ray 那邊跑）：
   - 員工建 draft → 送出 → 唯讀
   - 主管定案 → 員工看到 approved
   - 主管當天改 → 觸發確認對話框
6. git status 確認只動了預期的檔案
7. git commit：`feat(attendance): batch 3 - schedule three-stage flow`
8. 不 push

### 5.11 給 Claude Code 的指令模板

[Ray 執行時：把以下整段貼給 Claude Code]
進 Batch 3：排班三階段流程。
請依 docs/attendance-system-implementation-plan-v1.md §5 的規範實作。
關鍵注意點：

lib/ 純函式，repo 介面注入
既有 employee-schedule.html / schedule.html 改名為 .old 備份
isLateChange 通知是即時推播，不走 cron
UI 沿用既有風格

完成後做 §5.10 驗收，回報結果，等我說「進 Batch 4」。

---

## 6. Batch 4：打卡對應排班 + 曠職判定

### 6.1 Deliverable

**Lib（純函式）：**
- `lib/attendance/clock.js` — 打卡邏輯（驗證 schedule、算遲到/早退/工時/加班）
- `lib/attendance/absence-sweep.js` — cron：曠職判定

**API：**
- `api/attendance/index.js` — 重做：GET（列表） / POST（打卡）
- `api/attendance/[id].js` — 重做：PUT（HR 修改） / DELETE
- `api/attendance/anomaly.js` — POST（HR 標記/取消 is_anomaly + anomaly_note）
- `api/cron-absence-detection.js` — cron entry

**UI：**
- `public/attendance.html` — 打卡頁（重做，原檔備份 .old）
- `public/attendance-admin.html` — HR 後台（檢視 + 處理 is_anomaly，新建）

**測試：**
- `tests/attendance-clock.test.js`
- `tests/attendance-absence-sweep.test.js`

### 6.2 lib/attendance/clock.js 規範

**function 簽名：**
```javascript
export async function clockIn(repo, { employee_id, timestamp }) {
  // 1. 找該員工該日的 schedules（status='locked' 或 'approved' 的最近一筆 schedule_period）
  // 2. 沒 schedule → 拒絕（throw NoScheduleError）
  // 3. 多段班：找對應的 segment（時間落在哪段裡）
  // 4. 計算 late_minutes = max(0, timestamp - schedule.start_time)
  // 5. 寫 attendance：clock_in、schedule_id、segment_no、late_minutes、status='normal'/'late'
  // 6. 若該日是國定假日，is_holiday_work=true、holiday_id=該天 id
  // 回傳新建的 attendance
}

export async function clockOut(repo, { employee_id, timestamp }) {
  // 1. 找今天/前一天有 clock_in 但無 clock_out 的 attendance（跨日班會找前一天）
  // 2. 算 work_hours = (clock_out - clock_in) / 3600（小時）
  // 3. 算 overtime_hours = max(0, scheduled_minutes 換算後超出的部分)
  // 4. 算 early_leave_minutes = max(0, schedule.end_time - timestamp)
  // 5. 更新 status：early_leave / normal
  // 回傳更新後的 attendance
}
```

**錯誤類型：**
- `NoScheduleError`：該員工該日無 schedule
- `AlreadyClockedInError`：今天已打卡上班
- `NoOpenAttendanceError`：找不到要打卡下班的紀錄

**測試 cases：**
- 正常打卡（準時、遲到、早退）
- 跨日班（22-06）的 clock_in 跟 clock_out
- 多段班的對應 segment（早段 / 中段 / 晚段）
- 沒 schedule 拒絕
- 國定假日 is_holiday_work 標記
- segment_no 正確

### 6.3 lib/attendance/absence-sweep.js 規範

cron 觸發：每天 00:15。

```javascript
export async function runAbsenceSweep(repo, today) {
  // 1. 找昨日（today - 1）的 schedules 中 status='locked' 的所有員工 × 段次
  // 2. 對每個 (employee_id, date, segment_no) 檢查：
  //    a. 是否有對應的 attendance？沒有 → 標曠職
  //    b. 是否該天有 approved leave_request？有 → 標 status='leave'，不算曠職
  // 3. 寫入 attendance：status='absent'、is_anomaly=false（先當曠職）
  // 4. 觸發推播給該員工 + 主管 + HR
  // 回傳：{ absent_count, leave_count, normal_count }
}
```

**重點：**
- 「先當曠職」是預設判斷；HR 之後可透過 `api/attendance/anomaly.js` 改成 anomaly+note
- 推播用既有 `lib/push.js`

### 6.4 API 規範（重點）

#### `api/attendance/index.js`

- **GET**：query year/month/employee_id；員工只看自己；HR 看全部
- **POST**：員工自己打卡
  - body：`{ action: 'clock_in' | 'clock_out' }`
  - timestamp 用 server time（不接受 client 傳）
  - 回傳對應的 attendance row

#### `api/attendance/[id].js`

- **PUT**：HR / admin 改 attendance（修正錯誤打卡）
  - 限制：clock_in / clock_out / late_minutes / early_leave_minutes / status / is_anomaly / anomaly_note
- **DELETE**：HR / admin 刪除 attendance

#### `api/attendance/anomaly.js`

- **POST**：HR / admin 標記 is_anomaly
  - body：`{ attendance_id, is_anomaly: bool, anomaly_note: string }`

### 6.5 UI 規範

#### `public/attendance.html`（員工打卡頁）

**畫面元素：**
1. 顯示「今日排班」（從 schedule 撈）
   - 沒排班 → 顯示「今日無排班，無法打卡」
   - 有排班 → 顯示班別 / 時段 / 段次（多段班全列）
2. 「打上班卡」 / 「打下班卡」按鈕
   - 已打過上班卡 → 上班卡按鈕變 disabled
   - 對應 segment 自動判斷（員工不需選段）
3. 打卡歷史（最近 7 天）

#### `public/attendance-admin.html`（HR 後台）

**畫面元素：**
1. 員工 / 月份篩選
2. 列表：日期 / 員工 / clock_in / clock_out / status / is_anomaly / 操作
3. 異常區塊（is_anomaly=true 或 status='absent'）置頂顯示
4. 點某筆 → 編輯抽屜（改 clock_in/out、標 is_anomaly、加 anomaly_note）

### 6.6 驗收條件

1. 兩個 lib 純函式檔 + 兩個測試檔全綠
2. 四個 API 檔 + 一個 cron entry
3. 兩個 UI 頁面（打卡頁原檔備份 .old）
4. 跑 `npx vitest run` 全綠
5. 手測：員工打卡、HR 標 is_anomaly
6. git commit：`feat(attendance): batch 4 - clock + absence detection`

### 6.7 給 Claude Code 的指令模板

[Ray 執行時：把以下整段貼給 Claude Code]

進 Batch 4：打卡對應排班 + 曠職判定。

請依 docs/attendance-system-implementation-plan-v1.md §6 的規範實作。

關鍵注意點：
- 沒 schedule 一律拒絕打卡（不要寬限）
- 曠職判定先標 absent，is_anomaly 預設 false（HR 之後標）
- timestamp 用 server time，不接受 client 傳

完成後做 §6.6 驗收，回報結果，等我說「進 Batch 5」。

---

## 7. Batch 5：請假 + 特休完整版

### 7.1 Deliverable

**Lib（純函式）：**
- `lib/leave/types.js` — 請假類型查詢輔助（讀 leave_types 表）
- `lib/leave/annual.js` — 特休年資 → 法定天數計算（勞基法 §38）
- `lib/leave/annual-rollover.js` — cron：特休週年滾動
- `lib/leave/balance.js` — 餘額查詢與異動（讀 / 寫 annual_leave_records、寫 leave_balance_logs）
- `lib/leave/request-flow.js` — 請假申請流程（建立 / 審核 / 撤回）

**API：**
- `api/leaves/index.js` — 重做：GET / POST
- `api/leaves/[id].js` — 重做：PUT（審核） / DELETE（撤回）
- `api/annual-leaves/index.js` — GET（員工查自己餘額 / HR 查全部）
- `api/annual-leaves/[id].js` — PUT（HR 手動調整 granted_days / 結算）
- `api/cron-annual-leave-rollover.js` — cron entry

**UI：**
- `public/leave.html` — 重做（員工請假頁，原檔備份 .old）
- `public/leave-admin.html` — 重做（HR 後台，原檔備份 .old）
- `public/annual-leave-admin.html` — 新建（HR 管理特休餘額 / 結算）

**測試：**
- `tests/leave-annual.test.js`
- `tests/leave-balance.test.js`
- `tests/leave-request-flow.test.js`
- `tests/leave-annual-rollover.test.js`

### 7.2 lib/leave/annual.js 規範

依勞基法 §38 計算特休天數。

```javascript
export function calculateLegalDays(seniorityYears) {
  // 0 ~ 0.5 年：0 天
  // 0.5 ~ 1 年：3 天
  // 1 ~ 2 年：7 天
  // 2 ~ 3 年：10 天
  // 3 ~ 5 年：14 天
  // 5 ~ 10 年：15 天
  // 10 年以上：每滿 1 年 +1 天，上限 30 天
  // 回傳：number
}

export function calculatePeriodBoundary(seniorityStart, today) {
  // 週年制：今年的週期是哪天到哪天？
  // 回傳：{ period_start: Date, period_end: Date, seniority_years: number }
}
```

### 7.3 lib/leave/annual-rollover.js 規範

cron 觸發：每天 03:00。

```javascript
export async function runAnnualRollover(repo, today) {
  // 1. 找今天是 annual_leave_seniority_start 週年日的員工
  // 2. 對每個員工：
  //    a. 上週期 annual_leave_records 結算：依公司設定（暫定全部 paid_out + 自動算金額；
  //       未來可加設定切換 expired / rolled_over）
  //    b. 建立新週期 annual_leave_records（依 seniority_years 算 legal_days，
  //       granted_days 預設 = legal_days）
  //    c. 寫 leave_balance_logs（grant 事件）
  // 回傳：{ rollover_count: N, payout_total: $$ }
}
```

**注意：** 結算金額由 `lib/salary/settlement.js` 計算（Batch 9 才實作）。本 batch 先把欄位寫好、金額暫填 0 + 留 TODO 註解。

### 7.4 lib/leave/balance.js 規範

```javascript
export async function getAnnualBalance(repo, employee_id) {
  // 找 status='active' 的最新 annual_leave_records
  // 回傳：{ legal_days, granted_days, used_days, remaining_days, period_end }
}

export async function deductAnnualLeave(repo, { employee_id, days, leave_request_id, changed_by }) {
  // UPDATE annual_leave_records SET used_days = used_days + days
  // 寫 leave_balance_logs（change_type='use'）
  // 注意：要鎖 row（SELECT FOR UPDATE）避免併發
}

export async function refundAnnualLeave(repo, { employee_id, days, leave_request_id, changed_by, reason }) {
  // UPDATE used_days = used_days - days
  // 寫 leave_balance_logs（change_type='cancel_use'）
}
```

### 7.5 lib/leave/request-flow.js 規範

```javascript
export async function calculateLeaveHours(repo, { employee_id, start_at, end_at }) {
  // 依該員工該時段的 schedules 計算總工時
  // 例：請 9-18，schedules 是 9-18（含 1hr 休息）→ 8 小時
  // 回傳：number（小時，支援半小時）
}

export async function submitLeaveRequest(repo, { employee_id, leave_type, start_at, end_at, reason }) {
  // 1. 計算 hours
  // 2. 餘額預檢（若 leave_type.has_balance=true）
  // 3. INSERT leave_requests with status='pending'、hours、finalized_hours=NULL
}

export async function approveLeaveRequest(repo, { request_id, approved_by }) {
  // 1. 重新計算 hours（pending 期間排班可能變動）
  // 2. 寫入 finalized_hours
  // 3. 若 leave_type.has_balance → deductAnnualLeave or deductCompTime
  // 4. 寫 leave_request_logs / leave_balance_logs
  // 5. UPDATE leave_requests SET status='approved'
}

export async function rejectLeaveRequest(repo, { request_id, rejected_by, reject_reason }) {
  // UPDATE status='rejected'，不扣餘額（pending 期間沒扣）
  // 視為「申請從未發生」
}

export async function cancelLeaveRequest(repo, { request_id, cancelled_by }) {
  // 員工撤回：只能在 status='pending' 時撤
  // UPDATE status='cancelled'
}
```

### 7.6 API 規範

跟既有 `api/leaves/*` 介面盡量相容（避免 UI 改動），新增以下：
- `start_at`/`end_at` 取代 `start_date`/`end_date`（既有 `days` 計算邏輯換成 `hours`）
- 審核時走 `approveLeaveRequest`（重算時數）

### 7.7 UI 規範

#### `public/leave.html`（員工）

**畫面元素：**
1. 「我的特休」區塊：餘額 / 已用 / 剩餘 / 週期到期日
2. 「我的補休」區塊：暫顯示佔位（Batch 6 才有）
3. 申請表單：類型 / 開始時間（DateTimePicker） / 結束時間 / 預估時數（即時計算） / 理由
4. 申請列表：pending / approved / rejected / cancelled

#### `public/leave-admin.html`（HR 審核）

**畫面元素：**
1. 待審核 pending 列表
2. 點某筆 → 看詳細 + 即時計算當下扣的時數（可能 ≠ 申請時的時數）
3. 「核准」/「駁回」按鈕

#### `public/annual-leave-admin.html`（特休管理，新建）

**畫面元素：**
1. 員工列表 + 每人的 annual_leave_records（活躍週期）
2. 顯示：seniority_years / legal_days / granted_days / used / remaining / status
3. 點某筆 → 編輯抽屜：
   - 調整 granted_days（HR 給優於法定）
   - 觸發結算（離職 / 週期到期手動觸發）
   - 加 note

### 7.8 驗收條件

1. 五個 lib + 四個測試全綠
2. 五個 API（含 cron entry）
3. 三個 UI 頁面（兩個原檔備份）
4. `npx vitest run` 全綠
5. 手測：請特休扣餘額、請完撤回退餘額
6. git commit：`feat(attendance): batch 5 - leave + annual`

### 7.9 給 Claude Code 的指令模板

[Ray 執行時：把以下整段貼給 Claude Code]

進 Batch 5：請假 + 特休完整版。

請依 docs/attendance-system-implementation-plan-v1.md §7 的規範實作。

關鍵注意點：
- 請假時數依當下排班計算（pending 期間排班可變、批准時重算）
- annual-rollover 結算金額暫填 0 + TODO（Batch 9 補）
- 餘額異動要鎖 row 避免併發

完成後做 §7.8 驗收，回報結果，等我說「進 Batch 6」。

---

## 8. Batch 6：補休系統

### 8.1 Deliverable

**Lib（純函式）：**
- `lib/comp-time/balance.js` — 補休餘額查詢
- `lib/comp-time/expiry-sweep.js` — cron：失效處理
- `lib/comp-time/expiry-warning.js` — cron：失效預警

**API：**
- `api/comp-time/index.js` — GET（員工查自己餘額 / HR 查全部）
- `api/cron-comp-expiry.js` — cron entry
- `api/cron-comp-expiry-warning.js` — cron entry

**UI：**
- `public/comp-time.html` — 員工查補休餘額（新建）
- `public/comp-time-admin.html` — HR 後台（新建）

**測試：**
- `tests/comp-time-balance.test.js`
- `tests/comp-time-expiry.test.js`

### 8.2 重要：補休「申請」走 leave 系統

補休申請走 `lib/leave/request-flow.js`（Batch 5 已實作），`leave_type='comp'`。

當 `submitLeaveRequest({ leave_type: 'comp', ... })` 時：
- `calculateLeaveHours` 一樣依排班算
- 餘額檢查改檢 `comp_time_balance`（FIFO 取最舊未過期的）
- 批准時 `approveLeaveRequest` 扣 comp_time_balance.used_hours

**所以 Batch 6 主要做的是「補休餘額」+「失效處理」，「申請」沿用 Batch 5。**

但 Batch 6 要回頭補 Batch 5 的 lib/leave/balance.js：
- 加 `deductCompTime(repo, { employee_id, hours, leave_request_id, changed_by })`
- 加 `refundCompTime(repo, ...)`
- FIFO：找 `status='active' AND remaining_hours > 0` 中 `expires_at` 最早的那筆，扣到該筆扣完再下一筆

### 8.3 lib/comp-time/balance.js 規範

```javascript
export async function getCompBalance(repo, employee_id) {
  // 撈所有 active 的 comp_time_balance
  // 回傳：{
  //   total_remaining: number,
  //   records: [{ id, earned_at, expires_at, remaining_hours }, ...]
  // }
}

export async function grantCompTime(repo, { employee_id, hours, source_overtime_request_id, earned_at }) {
  // INSERT comp_time_balance
  // expires_at = earned_at + 1 year
  // status='active'
  // 寫 leave_balance_logs（balance_type='comp', change_type='grant'）
}
```

### 8.4 lib/comp-time/expiry-sweep.js 規範

cron 觸發：每天 01:00。

```javascript
export async function runCompExpirySweep(repo, today) {
  // 1. 找 status='active' AND expires_at <= today 的 comp_time_balance
  // 2. 對每筆讀 system_overtime_settings.comp_expiry_action：
  //    - auto_payout：算金額（用該員工當下時薪 × remaining_hours × 1.34 預設倍率）
  //                  → 填入該員工當月 salary_records.comp_expiry_payout（若有 draft）
  //                  → 沒 draft 就建立一筆等待 HR 處理
  //                  → 標 status='expired_paid'，填 expiry_payout_amount
  //    - manual_review：標 status='expired_paid' 但金額 NULL（讓 HR 看到「待處理」清單）
  //    - void：標 status='expired_void'
  // 3. 寫 leave_balance_logs（change_type='expire'）
  // 回傳：{ expired_count, payout_total }
}
```

**注意：** 「填入 salary_records」的邏輯先寫好但 Batch 9 才會用，Batch 6 跑 cron 在 dev 環境只會建 expired_paid 紀錄。

### 8.5 lib/comp-time/expiry-warning.js 規範

cron 觸發：每天 02:00。

```javascript
export async function runCompExpiryWarning(repo, today) {
  // 讀 system_overtime_settings.comp_expiry_warning_days（預設 30）
  // 找 status='active' AND expires_at = today + warning_days 的 comp_time_balance
  // 對每筆觸發推播給該員工
  // 回傳：{ warning_sent_count }
}
```

### 8.6 UI 規範

#### `public/comp-time.html`（員工）

**畫面元素：**
1. 總剩餘補休時數（大數字）
2. 補休明細表：earned_at / expires_at / earned_hours / remaining_hours / status
3. 即將失效警示（30 天內到期的紅色標示）

#### `public/comp-time-admin.html`（HR）

**畫面元素：**
1. 員工列表 + 每人總補休餘額
2. 即將失效列表（30 天內）
3. 已失效待處理（status='expired_paid' AND expiry_payout_amount IS NULL）

### 8.7 驗收條件

1. 三個 lib + 兩個測試全綠
2. 三個 API（含兩個 cron entry）
3. 兩個 UI 頁面（新建）
4. Batch 5 的 lib/leave/balance.js 補上 deductCompTime / refundCompTime
5. `npx vitest run` 全綠
6. 手測：cron expiry-sweep 模擬執行
7. git commit：`feat(attendance): batch 6 - comp-time system`

### 8.8 給 Claude Code 的指令模板

[Ray 執行時：把以下整段貼給 Claude Code]

進 Batch 6：補休系統。

請依 docs/attendance-system-implementation-plan-v1.md §8 的規範實作。

關鍵注意點：
- 補休「申請」走 Batch 5 的 leave_requests（leave_type='comp'）
- Batch 6 主要做「餘額」+「失效處理」+「警告」
- 要回頭補 Batch 5 的 lib/leave/balance.js 加 deductCompTime/refundCompTime
- expiry-sweep 填 salary_records 的邏輯先寫好（Batch 9 才會真用）

完成後做 §8.7 驗收，回報結果，等我說「進 Batch 7」。

---

## 9. Batch 7：加班系統

### 9.1 Deliverable

**Lib（純函式）：**
- `lib/overtime/limits.js` — 上限查詢與檢查（個人 → 全公司 fallback）
- `lib/overtime/request-state.js` — 加班申請狀態機（pending / pending_ceo / approved / rejected / cancelled）
- `lib/overtime/pay-calc.js` — 加班費計算（依倍率）
- `lib/overtime/comp-conversion.js` — 加班通過 → 補休餘額轉換

**API：**
- `api/overtime-requests/index.js` — GET / POST（員工申請）
- `api/overtime-requests/[id]/manager-review.js` — POST（主管審核）
- `api/overtime-requests/[id]/ceo-review.js` — POST（CEO 審核，僅超時案件）
- `api/overtime-requests/[id]/cancel.js` — POST（員工撤回）
- `api/overtime-limits/index.js` — GET / POST（HR 設定上限）
- `api/overtime-limits/[id].js` — PUT / DELETE

**UI：**
- `public/overtime.html` — 員工加班申請頁（新建）
- `public/overtime-admin.html` — HR 後台（含上限設定 + 審核總覽，新建）
- `public/overtime-review.html` — 主管 / CEO 審核頁（新建）

**測試：**
- `tests/overtime-limits.test.js`
- `tests/overtime-request-state.test.js`
- `tests/overtime-pay-calc.test.js`
- `tests/overtime-comp-conversion.test.js`

### 9.2 lib/overtime/limits.js 規範

```javascript
export async function getEffectiveLimits(repo, employee_id, today) {
  // 1. 找該員工 scope='employee' 的 active overtime_limits（effective_from <= today <= effective_to）
  // 2. 沒有就 fallback 找 scope='company'
  // 3. 回傳：{ daily, weekly, monthly, yearly, monthly_hard_cap }
  //   每個欄位可能是 number 或 null（null = 該維度不限制）
}

export async function checkOverLimit(repo, { employee_id, overtime_date, hours }) {
  // 1. 取 effective limits
  // 2. 加總該員工該日 / 該週 / 該月 / 該年已 approved 的 overtime hours
  // 3. 加上本次 hours，逐一檢查每個維度
  // 回傳：{
  //   is_over_limit: boolean,
  //   over_limit_dimensions: ['daily', 'monthly'] (陣列，超了哪些),
  //   exceeds_hard_cap: boolean,  // 月維度超過 hard_cap
  // }
}
```

**重點：**
- `exceeds_hard_cap=true` → 系統直接擋，不能申請
- `is_over_limit=true && exceeds_hard_cap=false` → 走超時流程（pending_ceo）
- 只算 status='approved' 的歷史時數（不含 pending）

### 9.3 lib/overtime/request-state.js 規範

跟 approvals_v2 同款的 reducer 設計。

```javascript
export const OVERTIME_STATES = ['pending', 'pending_ceo', 'approved', 'rejected', 'cancelled'];

export function canTransition(fromState, action, actor, requestMeta) {
  // actor: { is_employee_self, is_manager, is_ceo }
  // action: 'manager_approve' | 'manager_reject' | 'ceo_approve' | 'ceo_reject' | 'cancel'
  // requestMeta: { is_over_limit, exceeds_hard_cap }
  // 回傳：{ ok, nextState?, reason? }
}
```

**Transition 規則：**

| from | action | to | 條件 |
|---|---|---|---|
| pending | manager_approve | approved | is_manager AND !is_over_limit |
| pending | manager_approve | pending_ceo | is_manager AND is_over_limit |
| pending | manager_reject | rejected | is_manager |
| pending | cancel | cancelled | is_employee_self |
| pending_ceo | ceo_approve | approved | is_ceo |
| pending_ceo | ceo_reject | rejected | is_ceo |

不合法組合都回 `{ ok: false }`。

### 9.4 lib/overtime/pay-calc.js 規範

```javascript
export function calculateOvertimePay(hours, hourlyRate, multiplierConfig, dayType) {
  // multiplierConfig: 從 system_overtime_settings 讀
  // dayType: 'weekday' | 'rest_day' | 'national_holiday'
  // 計算：
  //   national_holiday：直接用 holidays.pay_multiplier × hourlyRate × hours
  //   weekday/rest_day：前 2 小時 × first_2h_rate、超過 × after_2h_rate
  // 回傳：{ amount: number, breakdown: { ... } }
}

export function getHourlyRate(monthlySalary, monthlyWorkHoursBase) {
  // monthlyWorkHoursBase 從 system_overtime_settings 讀，預設 240
  // 回傳：monthlySalary / monthlyWorkHoursBase
}
```

### 9.5 lib/overtime/comp-conversion.js 規範

```javascript
export async function convertOvertimeToCompTime(repo, overtimeRequest) {
  // 加班通過且 compensation_type='comp_leave'
  // 呼叫 lib/comp-time/balance.js 的 grantCompTime
  // earned_hours = overtimeRequest.hours（1:1 換算，不依倍率）
  // earned_at = overtimeRequest.overtime_date
  // expires_at = earned_at + 1 year
  // 寫入後更新 overtime_requests.comp_balance_id
}
```

### 9.6 API 規範

#### `api/overtime-requests/index.js`

- **POST**：員工申請加班
  - body：`{ overtime_date, start_at, end_at, hours, request_kind, compensation_type, reason }`
  - 系統呼叫 `checkOverLimit`：
    - `exceeds_hard_cap=true` → 直接 reject 回 400
    - `is_over_limit=true` → 寫入 `is_over_limit=true` + `over_limit_dimensions`
  - 系統依日期類型寫入 `pay_multiplier`（用當下值，凍結）
  - 系統算 `estimated_pay`（即使選 comp_leave 也算供參考）
  - 寫入 `applies_to_year/month`（從 overtime_date 提取）
  - **注意：** 不能跨月申請 → 檢查 `applies_to_year/month` 必須等於 today 的年月（除非 HR 替員工補申請？此 batch 暫不處理 HR 補申請情境）

- **GET**：列表查詢

#### `api/overtime-requests/[id]/manager-review.js`

- **POST**：body：`{ decision: 'approved'/'rejected', note, compensation_type? }`
- 主管可改 compensation_type（員工選 undecided 時主管要決定）
- 通過後依 `is_over_limit` 流轉到 approved 或 pending_ceo
- 若直接 approved 且選 comp_leave → 觸發 `convertOvertimeToCompTime`

#### `api/overtime-requests/[id]/ceo-review.js`

- **POST**：CEO 審核超時案件
- 通過後狀態 → approved，觸發後續邏輯（同上）

#### `api/overtime-limits/*`

- HR / admin 才能 CRUD
- POST 時檢查 scope/employee_id 配對符合 chk_employee_scope
- 同 scope 同生效期間有重疊 → 拒絕

### 9.7 UI 規範

#### `public/overtime.html`（員工申請）

**畫面元素：**
1. 申請表單：日期 / 時段 / 預計時數（即時計算） / 補償方式（補休 / 加班費 / 待決定） / 理由
2. 補償方式下方提示文字：「最終補償方式由公司決定」
3. 即時上限檢查提示：
   - 「本月已申請 X 小時，本次申請 Y 小時，預計到 Z 小時」
   - 若超過 monthly_limit → 紅字「超出一般上限，需走超時加班流程」
   - 若超過 hard_cap → 紅字「超出最高上限，無法申請」
4. 申請列表：pending / pending_ceo / approved / rejected / cancelled

#### `public/overtime-admin.html`（HR 後台）

**畫面元素：**
1. **加班上限設定區塊**：
   - 全公司預設值（一筆 row）
   - 個別員工調整列表 + 新增按鈕
   - 編輯：四維度上限 + monthly_hard_cap + 生效期間
2. **加班申請總覽**：所有員工的申請（依月份篩選）

#### `public/overtime-review.html`（主管 / CEO 審核）

**畫面元素：**
1. 待我審核的清單
   - 主管看 status='pending' 的下屬申請
   - CEO 看 status='pending_ceo' 的所有申請
2. 點某筆 → 詳細頁：申請內容 / 員工本月已申請時數 / 是否超限提示
3. 「核准」/「駁回」按鈕 + 補償方式選擇 + 備註欄

### 9.8 驗收條件

1. 四個 lib + 四個測試全綠
2. 七個 API
3. 三個 UI 頁面（全新建）
4. `npx vitest run` 全綠
5. 手測：申請、超時走 CEO、選補休後 comp_time_balance 自動建立
6. git commit：`feat(attendance): batch 7 - overtime system`

### 9.9 給 Claude Code 的指令模板

[Ray 執行時：把以下整段貼給 Claude Code]

進 Batch 7：加班系統。

請依 docs/attendance-system-implementation-plan-v1.md §9 的規範實作。

關鍵注意點：
- 兩段式上限：未超 limit / 超 limit / 超 hard_cap 三種流向
- 不能跨月申請（applies_to_year/month 必須等於 today 的年月）
- 通過時依 compensation_type 分流：comp_leave 走 grantCompTime（Batch 6 已實作）
- pay_multiplier 申請時凍結
- 上限歷史時數只算 approved 的，不含 pending

完成後做 §9.8 驗收，回報結果，等我說「進 Batch 8」。

---

## 10. Batch 8：出勤獎懲

### 10.1 Deliverable

**Lib（純函式）：**
- `lib/attendance/bonus.js` — 全勤獎金扣除比例計算
- `lib/attendance/rate.js` — 實際出席率計算（給績效用，本批先建 stub，先有公式無實際使用）
- `lib/attendance/penalty.js` — 套用獎懲規則

**API：**
- `api/attendance-penalties/index.js` — GET / POST（HR 管理規則）
- `api/attendance-penalties/[id].js` — PUT / DELETE
- `api/attendance-penalty-records/index.js` — GET（查紀錄）
- `api/attendance-penalty-records/[id]/waive.js` — POST（HR 豁免某筆懲處）

**UI：**
- `public/attendance-penalty-admin.html` — HR 後台（規則設定 + 紀錄總覽，新建）

**測試：**
- `tests/attendance-bonus.test.js`
- `tests/attendance-rate.test.js`
- `tests/attendance-penalty.test.js`

### 10.2 lib/attendance/penalty.js 規範

**核心：** 把 attendance 的事件對應到 attendance_penalties 規則，產生 attendance_penalty_records。

```javascript
export async function applyPenaltyRules(repo, attendance) {
  // 1. 依 attendance.status 判斷 trigger_type：
  //    - status='late' → late
  //    - status='early_leave' → early_leave
  //    - status='absent' → absent（注意：曠職的「扣日薪」由薪資模組處理，這裡只處理「扣全勤」之類）
  // 2. 找對應的 attendance_penalties 規則：
  //    - 取 active=true、effective_from/to 涵蓋當天
  //    - 依 trigger_type 撈
  //    - 對 late/early_leave：用 late_minutes/early_leave_minutes 對應 threshold_minutes_min/max
  //    - 檢查 monthly_count_threshold（本月該類事件第幾次）
  // 3. 對每條符合的規則，產生 attendance_penalty_records：
  //    - penalty_type / penalty_amount 從規則拷貝（快照）
  //    - 套用 penalty_cap
  //    - applies_to_year/month 從 attendance.date 提取
  // 4. 返回：產生的 records 清單
}
```

### 10.3 lib/attendance/bonus.js 規範

```javascript
export async function calculateAttendanceBonusDeduction(repo, { employee_id, year, month }) {
  // 1. 取該員工該月的 attendance + leave_requests + attendance_penalty_records
  // 2. 計算扣除比例（扣多少 % 全勤獎金）：
  //    a. 曠職天數 → 比例
  //    b. 影響全勤的請假類型（leave_types.affects_attendance_bonus=true）→ 比例
  //    c. attendance_penalty_records 中 penalty_type='deduct_attendance_bonus_pct' → 加總
  // 3. 比例上限 1.0（扣到 0 為止）
  // 回傳：{ deduction_rate: 0~1, breakdown: {...} }
}
```

**重點：** 具體比例規則**從 attendance_penalties 表讀**，本函式只負責加總，不寫死「曠職一天扣 30%」這種邏輯。

### 10.4 lib/attendance/rate.js 規範（stub）

```javascript
export async function calculateAttendanceRate(repo, { employee_id, year, month }) {
  // 績效用「實際出席率」，獨立演算法
  // 本批先建 stub：
  //   1. 算當月應出勤工時（扣週末 + 國定假日）
  //   2. 算當月實際出席工時（attendance.work_hours 加總）
  //   3. 扣除遲到早退分鐘的工時
  //   4. 不扣請假類型 affects_attendance_rate=false 的時段
  // 回傳：{ rate: 0~1, total_required, total_attended, deductions }
  // TODO: 績效模組實作時細部對齊
}
```

### 10.5 API 規範

跟前面類似，CRUD 規則 + 紀錄查詢 + waive 豁免邏輯。

`waive.js`：
- HR / admin 才能呼叫
- body: `{ waive_reason }`
- UPDATE attendance_penalty_records SET status='waived', waived_by, waived_at, waive_reason

### 10.6 UI 規範

#### `public/attendance-penalty-admin.html`

**畫面元素：**

**Tab 1：規則設定**
1. 規則列表（依 trigger_type 分組）
2. 新增 / 編輯規則 modal：trigger_type / 階梯 min/max / penalty_type / 金額 / cap / 啟用
3. 階梯規則的 UI：可新增多階（例：遲到 1-5 分鐘扣 X、6-30 分鐘扣 Y、30+ 分鐘扣 Z）

**Tab 2：懲處紀錄**
1. 月份 / 員工篩選
2. 列表：日期 / 員工 / 類型 / 金額 / 狀態 / 操作
3. 操作：查看詳細、豁免

### 10.7 驗收條件

1. 三個 lib + 三個測試全綠
2. 五個 API
3. 一個 UI 頁面（新建）
4. `npx vitest run` 全綠
5. 手測：HR 設規則、模擬遲到觸發紀錄、豁免
6. git commit：`feat(attendance): batch 8 - penalty system`

### 10.8 給 Claude Code 的指令模板

[Ray 執行時：把以下整段貼給 Claude Code]

進 Batch 8：出勤獎懲。

請依 docs/attendance-system-implementation-plan-v1.md §10 的規範實作。

關鍵注意點：
- penalty 規則**從 attendance_penalties 表讀**，邏輯不寫死
- bonus 計算只加總比例，不寫死扣多少 %
- rate 函式是 stub，公式有但細節等績效模組對齊
- 曠職的「扣日薪」不在這層處理（薪資模組做）

完成後做 §10.7 驗收，回報結果，等我說「進 Batch 9」。

---

## 11. Batch 9：薪資勾稽

### 11.1 Deliverable

**Lib（純函式）：**
- `lib/salary/calculator.js` — 薪資計算主流程（聚合所有來源）
- `lib/salary/attendance-bonus.js` — 全勤獎金套用（呼叫 lib/attendance/bonus.js + 寫入 salary_records）
- `lib/salary/overtime-aggregator.js` — 加班費聚合（撈該月 approved overtime_requests + 寫入 overtime_pay_auto）
- `lib/salary/penalty-applier.js` — 懲處套用（撈 pending 的 penalty_records + 寫入 attendance_penalty_total）
- `lib/salary/settlement.js` — 結算項目（特休結算金額計算）

**API：**
- `api/salary/index.js` — 重做：GET / POST（HR 產生月度薪資草稿）
- `api/salary/[id].js` — 重做：PUT（手動覆寫）
- `api/salary/recalculate.js` — POST（HR 重算某員工某月）

**UI：**
- `public/salary.html` — 大改（HR 薪資管理頁，原檔備份 .old）
- `public/employee-salary.html` — 重做（員工查自己薪資單，原檔備份 .old）

**測試：**
- `tests/salary-calculator.test.js`
- `tests/salary-attendance-bonus.test.js`
- `tests/salary-overtime-aggregator.test.js`
- `tests/salary-penalty-applier.test.js`
- `tests/salary-settlement.test.js`

### 11.2 lib/salary/calculator.js 規範

**核心：** 月底 / HR 觸發時，產生 / 更新某員工某月的 salary_records。

```javascript
export async function calculateMonthlySalary(repo, { employee_id, year, month }) {
  // 1. 撈員工基本資料 → base_salary
  // 2. 算 daily_wage_snapshot = base_salary / 該月工作日數（凍結）
  // 3. 算 absence_days（從 attendance status='absent' 的天數）
  // 4. 呼叫 lib/salary/attendance-bonus.js → attendance_bonus_base / deduction_rate / actual
  // 5. 呼叫 lib/salary/overtime-aggregator.js → overtime_pay_auto
  // 6. 呼叫 lib/salary/penalty-applier.js → attendance_penalty_total
  // 7. 算 holiday_work_pay：找該月 attendance.is_holiday_work=true 的時段 × multiplier
  // 8. 呼叫 lib/salary/settlement.js → settlement_amount（特休結算 / 補休失效轉錢等）
  // 9. UPSERT salary_records（status='draft'）
  // 10. 標記相關 records：
  //     - attendance_penalty_records.status='applied' + salary_record_id
  //     - overtime_requests.applied_to_salary_record_id
  // 回傳：完整 salary_records row
}
```

### 11.3 各 lib 的職責

#### `lib/salary/attendance-bonus.js`

```javascript
export async function applyAttendanceBonus(repo, salaryRecord, { employee_id, year, month }) {
  // 1. 從 employees.attendance_bonus 撈 base
  // 2. 呼叫 lib/attendance/bonus.js 的 calculateAttendanceBonusDeduction
  // 3. 寫入 salary_records.attendance_bonus_base / deduction_rate / actual
}
```

#### `lib/salary/overtime-aggregator.js`

```javascript
export async function aggregateOvertimePay(repo, { employee_id, year, month }) {
  // 1. 撈該月 approved overtime_requests 中 compensation_type='overtime_pay'
  // 2. 加總 estimated_pay 或重算（依 pay_calc）
  // 3. 回傳 overtime_pay_auto 數值
  // 不處理 manual 欄位（HR 在 UI 直接改）
}
```

#### `lib/salary/penalty-applier.js`

```javascript
export async function applyAttendancePenalties(repo, { employee_id, year, month }) {
  // 1. 撈該月 attendance_penalty_records status='pending' 的金額
  // 2. 排除 status='waived'
  // 3. 加總得 attendance_penalty_total
  // 4. 把這些 records 標 status='applied' + salary_record_id（在 calculator 主流程做）
}
```

#### `lib/salary/settlement.js`

```javascript
export async function calculateSettlementAmount(repo, { employee_id, year, month }) {
  // 1. 找該員工該月需結算的項目：
  //    a. annual_leave_records 中 status='paid_out' 但 settlement_amount=0 的（rollover 產生的）
  //    b. comp_time_balance 中 status='expired_paid' 但 expiry_payout_amount=0 的
  // 2. 對 a：剩餘天數 × 日薪 × 1.0（特休結算就是 1 倍日薪換算）
  // 3. 對 b：剩餘小時數 × 時薪 × 1.34（用法定加班費倍率，從 system_overtime_settings 讀）
  // 4. 加總
  // 5. 同時更新原始 records 的金額欄位
  // 回傳：總金額
}
```

### 11.4 API 規範

#### `api/salary/index.js`

- **POST**：HR 觸發批次產生某月薪資草稿（依員工迴圈呼叫 calculator）
- **GET**：列表查詢，員工只看自己

#### `api/salary/[id].js`

- **PUT**：HR 手動覆寫
  - 允許欄位：overtime_pay_manual / allowance / extra_allowance / deduct_labor_ins / deduct_health_ins / deduct_tax / overtime_pay_note / settlement_note
  - 不允許覆寫 GENERATED column（gross_salary / net_salary）

#### `api/salary/recalculate.js`

- **POST**：body `{ employee_id, year, month }`
- HR 觸發重算某員工某月（會清掉 manual 嗎？暫定**不清**，HR 改的保留）
- 重算時 attendance_penalty_records 從 applied 改回 pending（讓 calculator 重新標記）

### 11.5 UI 規範

#### `public/salary.html`（HR）

**畫面元素：**
1. 月份切換器
2. 員工列表 + 薪資狀態（draft / confirmed / paid）
3. 點某筆 → 詳細編輯抽屜：
   - 顯示所有自動計算欄位（read-only）
   - 顯示所有手動可改欄位（input）
   - 顯示 GENERATED gross_salary / net_salary（即時更新）
   - 顯示明細：加班費來源（哪幾筆 overtime_requests）、懲處明細（哪幾筆 records）、結算明細
4. 「重算」按鈕：呼叫 recalculate API
5. 「批次產生」按鈕：對該月所有員工跑 calculator

#### `public/employee-salary.html`（員工）

**畫面元素：**
1. 月份切換器
2. 該月薪資單：
   - 收入：base / bonus / allowance / overtime_pay / settlement / holiday_work_pay
   - 扣除：absence / labor_ins / health_ins / tax / penalty_total
   - 總計：gross_salary / net_salary
3. 加班費明細展開（連到 overtime_requests）
4. 補休失效轉錢明細（如果有）
5. 特休結算明細（如果有）

### 11.6 驗收條件

1. 五個 lib + 五個測試全綠
2. 三個 API（含 recalculate）
3. 兩個 UI 頁面（原檔備份）
4. `npx vitest run` 全綠
5. 手測：批次產生薪資、HR 改 manual、重算
6. **驗證薪資 GENERATED column 公式正確**：
   - 用 mock data 跑一次計算
   - 比對 gross_salary = sum(收入欄位)
   - 比對 net_salary = gross - sum(扣除欄位)
7. 回頭補 Batch 5/6 的 TODO：
   - `lib/leave/annual-rollover.js` 結算金額調用 `lib/salary/settlement.js`
   - `lib/comp-time/expiry-sweep.js` 「填入 salary_records」邏輯啟用
8. git commit：`feat(attendance): batch 9 - salary integration`

### 11.7 給 Claude Code 的指令模板

[Ray 執行時：把以下整段貼給 Claude Code]

進 Batch 9：薪資勾稽。

請依 docs/attendance-system-implementation-plan-v1.md §11 的規範實作。

關鍵注意點：
- calculator 是聚合者，不重算其他模組已算的東西
- daily_wage_snapshot 在計算當下凍結，後續不變
- 重算不清掉 HR 的 manual 改動
- 特休結算 / 補休失效轉錢 都由 settlement.js 處理
- 回頭補 Batch 5 / Batch 6 的 TODO（annual-rollover、expiry-sweep）

完成後做 §11.6 驗收（特別是公式驗證），回報結果，等我說「進 Batch 10」。

---

## 12. Batch 10：Prod Migration + Deploy（Ray 親手執行）

### 12.1 性質

**這批不是 Claude Code 做的**，是 Ray 親手在 prod 環境執行。

Claude Code 在這批的角色：
- 提供精確的 SQL 給 Ray 執行
- 提供 Vercel cron 設定指令
- 不直接動 prod，不直接 deploy

### 12.2 前提條件（執行前必須全部達成）

- [ ] Batch 1-9 全部已完成、commit、push
- [ ] 所有 vitest 測試全綠
- [ ] Batch 1 產出的三個 SQL 檔案內容跟設計文件 §4 一致
- [ ] Batch 9 的薪資公式驗證已通過
- [ ] Ray 已在本地 dev 環境用測試 supabase 跑過 batch_a + b + c 一次（建議）
- [ ] Ray 已通知所有員工系統將進維護期

### 12.3 執行步驟

#### Step 1：跑 Batch A SQL（純新增表）

**位置：** Supabase Dashboard → SQL Editor

**動作：**
1. 開 `supabase_attendance_v2_batch_a.sql`
2. 整段複製貼到 SQL Editor
3. 執行
4. 驗證：

```sql
-- 確認 13 張新表 + 1 個 VIEW 都建好
SELECT table_name, table_type
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN (
    'holidays', 'leave_types', 'annual_leave_records', 'comp_time_balance',
    'leave_balance_logs', 'overtime_requests', 'overtime_limits',
    'overtime_request_logs', 'attendance_penalties', 'attendance_penalty_records',
    'system_overtime_settings', 'schedule_change_logs', 'attendance_monthly_summary'
  )
ORDER BY table_name;
-- 預期 13 row（12 BASE TABLE + 1 VIEW）

-- 確認 seed 資料
SELECT COUNT(*) FROM leave_types;            -- 預期 8
SELECT COUNT(*) FROM overtime_limits;         -- 預期 1
SELECT COUNT(*) FROM attendance_penalties;    -- 預期 3
SELECT COUNT(*) FROM system_overtime_settings; -- 預期 1
```

**回滾（如失敗）：**
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

#### Step 2：跑 Batch B SQL（既有表新增欄位 + backfill）

**動作：**
1. 開 `supabase_attendance_v2_batch_b.sql`
2. **分段執行**（不要一次全跑）：
   - 段 1：所有 ALTER TABLE ADD COLUMN（先 NULLABLE）
   - 段 2：所有 backfill UPDATE
   - 段 3：ALTER TABLE 加 NOT NULL 約束
3. 每段執行後驗證

**段 1 執行後驗證：**
```sql
-- 確認新欄位都加了
\d shift_types
\d employees
\d schedule_periods
\d schedules
\d attendance
\d leave_requests
```

**段 2 執行後驗證：**
```sql
-- employees backfill 確認
SELECT COUNT(*) FROM employees WHERE annual_leave_seniority_start IS NULL;
-- 預期 0

-- schedules backfill 確認
SELECT COUNT(*) FROM schedules WHERE period_id IS NULL;
-- 預期 0（如果舊系統有 schedule 資料）

SELECT COUNT(*) FROM schedules WHERE scheduled_work_minutes IS NULL;
-- 預期 0（除非 shift_type 沒設 start/end_time）
```

**段 3 執行：**
```sql
-- 把 NULLABLE 改 NOT NULL（前提：上面驗證 0 row）
ALTER TABLE employees ALTER COLUMN annual_leave_seniority_start SET NOT NULL;
-- ...其他 NOT NULL 約束
```

**回滾（如失敗）：**
- 段 1 失敗：DROP COLUMN
- 段 2 失敗：UPDATE 改回 NULL
- 段 3 失敗：DROP NOT NULL 約束

#### Step 3：跑 Batch C SQL（salary_records 大改）

**這是最高風險步驟。執行前先把 salary_records 整表備份：**

```sql
-- 備份整張表（不只 _salary_backup 那個用於 GENERATED column 比對的）
CREATE TABLE salary_records_pre_v2_backup AS
SELECT * FROM salary_records;
```

**動作：**
1. 開 `supabase_attendance_v2_batch_c.sql`
2. **分段執行**：
   - 段 1：CREATE _salary_backup
   - 段 2：所有 ALTER TABLE ADD COLUMN（補新欄位）
   - 段 3：所有反向 FK
   - 段 4：UPDATE backfill
   - 段 5：DROP gross_salary / net_salary
   - 段 6：ADD GENERATED column（新公式）
   - 段 7：比對驗證 SELECT
   - 段 8：（驗證 0 row 後才執行）DROP _salary_backup

**段 7 驗證：**
```sql
SELECT s.id, b.gross_salary AS old_gross, s.gross_salary AS new_gross,
       b.gross_salary - s.gross_salary AS gross_diff,
       b.net_salary AS old_net, s.net_salary AS new_net,
       b.net_salary - s.net_salary AS net_diff
FROM salary_records s
JOIN _salary_backup b ON b.id = s.id
WHERE b.gross_salary != s.gross_salary
   OR b.net_salary != s.net_salary;
-- 預期：0 row
```

**如果有 row 差異：**
- **不要繼續**
- 用 `salary_records_pre_v2_backup` 還原：

```sql
TRUNCATE salary_records;
INSERT INTO salary_records SELECT * FROM salary_records_pre_v2_backup;
-- 然後 debug backfill SQL，修正後重跑
```

**回滾（最壞情況）：**
- DROP TABLE salary_records
- CREATE TABLE salary_records AS SELECT * FROM salary_records_pre_v2_backup
- 重建所有約束 + index

#### Step 4：Deploy code

```bash
# 確認所有 Batch 1-9 commit 都已 push
cd /Users/ray/Downloads/hr-system-v2
git status
git log --oneline -20

# Vercel 自動 deploy 在 push 時觸發
# 確認 Vercel Dashboard 顯示最新 commit deploy 成功
```

#### Step 5：設定 Vercel Cron

**位置：** Vercel Dashboard → Project Settings → Cron Jobs

**設定六個 cron：**

| Path | Schedule | 說明 |
|---|---|---|
| `/api/cron-absence-detection` | `15 0 * * *` | 每日 00:15 曠職判定 |
| `/api/cron-schedule-lock` | `30 0 * * *` | 每日 00:30 排班鎖定 |
| `/api/cron-comp-expiry` | `0 1 * * *` | 每日 01:00 補休失效處理 |
| `/api/cron-comp-expiry-warning` | `0 2 * * *` | 每日 02:00 補休失效預警 |
| `/api/cron-annual-leave-rollover` | `0 3 * * *` | 每日 03:00 特休週年滾動 |
| `/api/cron-schedule-reminder` | `0 9 26 * *` | 每月 26 日 09:00 排班送出提醒 |

**或者改用 vercel.json：**
```json
{
  "crons": [
    { "path": "/api/cron-absence-detection", "schedule": "15 0 * * *" },
    { "path": "/api/cron-schedule-lock", "schedule": "30 0 * * *" },
    { "path": "/api/cron-comp-expiry", "schedule": "0 1 * * *" },
    { "path": "/api/cron-comp-expiry-warning", "schedule": "0 2 * * *" },
    { "path": "/api/cron-annual-leave-rollover", "schedule": "0 3 * * *" },
    { "path": "/api/cron-schedule-reminder", "schedule": "0 9 26 * *" }
  ]
}
```

**注意 timezone：** Vercel cron 用 UTC。台灣 UTC+8，所以 `15 0` UTC = 台灣 08:15。如果要在台灣時間 00:15 執行，要設 `15 16 * * *` UTC（前一天 16:15 UTC）。**Ray 上線前確認 cron schedule 是否已轉成 UTC**。

#### Step 6：手測全系統

**順序：**
1. **HR 後台基礎資料**：
   - 設國定假日（手動建 + 從 data.gov.tw 匯入）
   - 設加班上限（檢查預設那筆 company scope 在）
   - 設出勤懲處規則
   - 設 system_overtime_settings 倍率（用 default 即可）
2. **員工排班 → 主管定案**：
   - 員工建 draft → 排班 → 送出
   - 主管確認 → 定案
   - 等 cron 鎖定 or 手動 trigger lock
3. **員工打卡**：
   - 正常打卡
   - 跨日班打卡
   - 沒排班拒絕打卡
4. **員工請假**：
   - 申請特休
   - 主管核准 → 確認餘額扣
5. **員工申請加班**：
   - 一般加班 → 主管批 → 選補休 → 確認 comp_time_balance 建立
   - 超時加班 → 主管批 → CEO 批
6. **HR 產生薪資**：
   - 跑 calculator
   - 確認 gross / net 計算正確
   - HR 改 manual 欄位 → 確認 net 自動重算

**手測通過後才算上線完成。**

#### Step 7：通知員工新系統上線

- 站內公告
- 操作手冊（如有）

### 12.4 上線後第一個月觀察重點

- 每天 00:15 後檢查 cron-absence-detection 是否有預期內外的執行
- 每天 00:30 後檢查 cron-schedule-lock 是否正確鎖定
- 月底前確認排班送出提醒有發出
- HR 開始累積薪資資料，月底跑薪資計算時注意公式

### 12.5 給 Claude Code 的角色

**Batch 10 期間 Claude Code 不主動做事，只在 Ray 問時提供：**
- 任何 SQL 修正
- 任何 backfill 邏輯說明
- 任何錯誤訊息的 debug 協助

**禁止：**
- Claude Code 不能直接連 prod supabase
- Claude Code 不能自動 deploy
- Claude Code 不能改 vercel.json 直接 push（除非 Ray 明確要求）

---

## 13. 整體驗收清單

整個出勤核心系統上線後，以下清單全部通過才算系統正式啟用。

### 13.1 Schema 驗證

- [ ] 12 張新表全部建好（含 attendance_monthly_summary VIEW）
- [ ] 7 張既有表的新欄位全部加好
- [ ] 所有 FK 關聯正確（特別是反向 FK：penalty_records / overtime_requests / leave_requests / comp_time_balance → salary_records / overtime_requests）
- [ ] 所有 CHECK 約束都到位
- [ ] 所有 partial INDEX 都建立
- [ ] salary_records.gross_salary / net_salary 是 GENERATED STORED column

### 13.2 Seed 資料

- [ ] leave_types 8 筆（annual / sick / personal / maternity / funeral / marriage / comp / public）
- [ ] overtime_limits 至少 1 筆 company scope（4/12/46 + hard_cap 54）
- [ ] attendance_penalties 至少 3 筆（late / early_leave / absent，預設不扣金額）
- [ ] system_overtime_settings 1 筆 default row（id=1）

### 13.3 lib/ 模組

- [ ] `lib/holidays/` 2 檔
- [ ] `lib/schedule/` 6 檔
- [ ] `lib/attendance/` 5 檔
- [ ] `lib/leave/` 5 檔
- [ ] `lib/overtime/` 4 檔
- [ ] `lib/comp-time/` 3 檔
- [ ] `lib/salary/` 5 檔
- [ ] 所有 lib/ 純函式有對應的 vitest 測試

### 13.4 API endpoint

- [ ] 所有 holidays / schedules / attendance / leaves / overtime-requests / overtime-limits / comp-time / salary / attendance-penalties endpoint 全部到位
- [ ] 6 個 cron entry（absence-detection / schedule-lock / comp-expiry / comp-expiry-warning / annual-leave-rollover / schedule-reminder）

### 13.5 UI 頁面

員工頁面：
- [ ] employee-schedule.html（員工自排）
- [ ] attendance.html（打卡）
- [ ] leave.html（請假）
- [ ] comp-time.html（補休餘額）
- [ ] overtime.html（加班申請）
- [ ] employee-salary.html（薪資單）

主管 / CEO 頁面：
- [ ] schedule.html（主管確認 + 定案）
- [ ] overtime-review.html（主管 / CEO 審核）

HR 後台：
- [ ] holidays-admin.html
- [ ] attendance-admin.html
- [ ] leave-admin.html
- [ ] annual-leave-admin.html
- [ ] comp-time-admin.html
- [ ] overtime-admin.html
- [ ] attendance-penalty-admin.html
- [ ] salary.html

### 13.6 Cron 啟用

- [ ] 6 個 cron 全部在 Vercel 設定好
- [ ] Schedule 已轉成 UTC（台灣 UTC+8）
- [ ] 第一天執行後檢查 log 確認跑成功

### 13.7 業務流程驗證（手測）

- [ ] 員工排班三階段：draft → submitted → approved → locked 全部走通
- [ ] 主管當天改班：觸發即時通知 HR + CEO
- [ ] 員工打卡：對應 schedule、算遲到 / 早退 / 加班正確
- [ ] 沒排班無法打卡（API 拒絕）
- [ ] 排了班沒打卡：cron 隔日標 absent
- [ ] 員工請特休：餘額正確扣 / 撤回正確還
- [ ] 員工請補休：FIFO 扣最舊的 comp_time_balance
- [ ] 員工申請加班：超 limit 走 CEO，超 hard_cap 擋
- [ ] 加班通過選 comp_leave：自動建 comp_time_balance
- [ ] 補休失效：cron 自動轉錢 / 待處理 / 作廢（依設定）
- [ ] HR 產月薪資：所有來源欄位正確聚合
- [ ] HR 改 manual：gross / net 即時重算

### 13.8 Tests

- [ ] `npx vitest run` 全綠
- [ ] Test 覆蓋所有 lib/ 純函式

---

## 14. 文件結束

本實作計畫對應設計文件 **docs/attendance-system-design-v1.md** v1.0。

**實作 10 個 Batch 的執行順序：**

1. Batch 1（SQL 檔案產出，不上 prod）
2. Batch 2（國定假日）
3. Batch 3（排班三階段）
4. Batch 4（打卡 + 曠職）
5. Batch 5（請假 + 特休）
6. Batch 6（補休）
7. Batch 7（加班）
8. Batch 8（出勤獎懲）
9. Batch 9（薪資勾稽）
10. Batch 10（Ray 親手執行 prod migration + deploy）

**每批的進入條件：** 上一批完成、Ray 拍板說「進下一批」。

**整個專案完成標準：** §13 整體驗收清單全部打勾。

---
