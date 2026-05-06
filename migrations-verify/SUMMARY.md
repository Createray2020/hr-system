# 2026-05-07 待跑 prod migration 總覽

## 執行結果(2026-05-07 drift audit)

全部 5 條經 verify 確認 prod 已套用、未在本批執行 ② ALTER。
- #3 `employees_resigned_metadata`:保留 A 狀態(5 筆 `resigned_at = updated_at`),4 筆 4/20 batch artifact 待後台離職管理頁面開發後 HR 個案補正。

各 migration 檔頂部已加註解「2026-05-07 prod drift audit 確認已套用」、`supabase_known_drift_2026_05.sql` 加 C8-C12 段落紀錄本批 5 條 drift snapshot。

---

對應 `migrations-verify/verify_*.sql` 的一站式 VERIFY-pre / ALTER / VERIFY-post script。User 在 Supabase SQL Editor 手動執行,跑前先看 ① 看現況,跑 ② 真執行,跑後 ③ 確認生效。

## 執行順序建議

無相互依賴(每個動不同 table 或不同 column),**任意順序皆可**。但建議順序:

| 順 | Migration | 為什麼 |
|---|---|---|
| 1 | `attendance_early_arrival` | 純加欄位、最簡單、低風險暖身 |
| 2 | `employee_change_logs` | 純加表、暖身 |
| 3 | `employees_resigned_metadata` | 唯一有 row-level UPDATE backfill、跑前看清 ① resigned count、跑後驗 ③ backfill 數對齊 |
| 4 | `schedule_periods_audit` | 純加欄位 |
| 5 | `leave_terminated_status` | DROP/ADD CHECK constraint(微高風險、放最後)|

每個之間都用 BEGIN/COMMIT 包,失敗自己 rollback、不會留半套狀態。

## 5 個 migration 核心改動 + row-level data migration 標示

| # | 檔名 | 核心改動 | 有 row-level data migration? |
|---|---|---|---|
| 1 | `attendance_early_arrival.sql` | `ALTER attendance ADD early_arrival_minutes INT NOT NULL DEFAULT 0` | ❌(NOT NULL DEFAULT 0、PG 自動填 0、不算 row-level migration)|
| 2 | `employee_change_logs.sql` | `CREATE TABLE employee_change_logs` + 2 INDEX(7-field whitelist audit)| ❌(空表、無 backfill)|
| 3 | `employees_resigned_metadata.sql` | `ALTER employees ADD resigned_at TIMESTAMPTZ + resigned_reason TEXT` + **`UPDATE employees SET resigned_at = updated_at WHERE status='resigned' AND resigned_at IS NULL`** | ✅ **是、UPDATE 既有 resigned row**(N row、用 updated_at 替代精準離職時間)|
| 4 | `schedule_periods_audit.sql` | `ALTER schedule_periods ADD published_by TEXT FK + published_at TIMESTAMPTZ` | ❌(無 backfill、新動作起算、稽核走 schedule_change_logs)|
| 5 | `leave_terminated_status.sql` | DROP/ADD `leave_requests_status_check`(6→7 值、加 `'terminated'`)+ `ADD terminated_by TEXT FK + terminated_at TIMESTAMPTZ` | ❌(無 backfill、HR 在 leave-admin 個案處理)|

## 跑完後

`api/*.js` 的 audit hook(commit `f06374c` employee PUT、`d0dccea` leave terminate 等)會開始寫入新欄位,prod 行為:
- 員工關鍵欄位變更 → `employee_change_logs` 累積 audit row
- HR 設員工離職 → `resigned_at` 寫 NOW()
- HR 終止 expired leave → status='terminated' + terminated_by/at
- 主管定案/公告 schedule period → approved_by + published_by 開始有資料
- 員工 clockIn / 人工補登 → early_arrival_minutes 有非 0 值

## GPS Phase A schema(2026-05-07、本批之外)

新增 `office_locations` 表 + `attendance` ALTER 11 GPS columns + gps_flag CHECK。
- migration:`migrations/2026_05_07_attendance_gps_phase_a.sql`
- verify:`migrations-verify/verify_attendance_gps_phase_a.sql`
- Phase recap:`docs/PHASE_A_GPS.md`(7 commits / 整條 flow / 設計決策 / Phase B checklist)

獨立於本批的 5 條 drift confirmation、列在這裡只是給 user 看 attendance schema 的完整時間軸。

## 不在本批的 migration

`2026_05_06_leave_proof_expiry_action.sql`(Phase 1.5 升級)— 已在 prod 跑過(commit message 提)、不在本批。

## 驗證 SQL pattern 速查

| 改動類型 | PRE 怎麼查 | POST 怎麼查 |
|---|---|---|
| `CREATE TABLE` | `to_regclass('public.X')` → NULL | `to_regclass('public.X')` 非 NULL + `information_schema.columns` 列欄位 |
| `ALTER ADD COLUMN` | `information_schema.columns WHERE column_name=X` → 0 row | 同 query → 1 row + 抽 row 看 default |
| `ALTER CHECK constraint` | `pg_get_constraintdef(...)` 看舊內容 | 同 query 看新內容含新值 |
| FK | `pg_constraint WHERE contype='f' AND conname LIKE '%col%'` | 同 query → 1 row REFERENCES |
| INDEX | `pg_indexes WHERE tablename=X` | 同 query → 多幾個 row |
| Backfill UPDATE | `SELECT COUNT(...) WHERE 條件 AND 新欄位 IS NULL` | 同 query → 0(全部填完)+ 抽樣對比 |
