-- ============================================================
--  supabase_known_drift_2026_05.sql
--  ─ 5/1 cleanup 系列收尾、prod DB 與 supabase_*.sql 檔之間
--    已知 drift 的 audit trail snapshot
-- ============================================================
--
--  本檔案目的：
--    紀錄 prod schema 跟 repo 內 supabase_setup.sql /
--    supabase_schedule.sql / supabase_attendance_v2_batch_*.sql
--    之間「prod 已 ALTER、SQL 檔沒同步」的 drift。
--
--  本檔案不會被執行：
--    全部 SQL 都用 -- 註解掉、單純當文件用。
--    跑 supabase 客戶端貼上整檔 → 0 statement 執行。
--
--  Dev 想對齊本地 DB → uncomment 對應段落手動執行：
--    每段 ALTER 都用 IF NOT EXISTS / DROP IF EXISTS 寫法、
--    idempotent — 即使在 prod 跑也是 no-op、但**仍不建議**在
--    prod 跑（無實益、徒增 audit log noise）。
--
--  最後更新：2026-05-03
--  Ref：5/1 上線後 cleanup 盤點報告 §C + C7（盤點時新發現）
--
-- ============================================================



-- ============================================================
-- C1: schedule_periods.status enum 從 4 → 5 狀態（新增 'published'）
-- ============================================================
-- Source of truth : prod
-- SQL files claim : supabase_schedule.sql:69
--                   CHECK (status IN ('draft','submitted','approved','locked'))
-- Code references : lib/schedule/period-state.js:21（5 狀態定義）
--                   lib/schedule/period-state.js:33（approved → published transition）
--                   api/schedule-periods/[id]/publish.js（寫入 'published'）
--                   tests/schedule-period-state.test.js:82（斷言 5 狀態）
-- Risk if not synced : dev 從 supabase_schedule.sql 重建 → 跑 publish endpoint
--                      時 DB 拋 23514 CHECK violation、整個 publish 流程壞
--
-- 對齊 prod 的 SQL（uncomment 執行）：
-- ALTER TABLE schedule_periods DROP CONSTRAINT IF EXISTS schedule_periods_status_check;
-- ALTER TABLE schedule_periods ADD CONSTRAINT schedule_periods_status_check
--   CHECK (status IN ('draft','submitted','approved','published','locked'));



-- ============================================================
-- C2: shift_types prod 有 ST005-ST008、SQL seed 只有 ST001-ST004
-- ============================================================
-- Source of truth : prod
-- SQL files claim : supabase_schedule.sql:19-23（INSERT ST001-ST004）
-- Code references : public/js/schedule/excel-builder.js:24-28
--                     ALIAS_MAP 含「中班 / 晚班 / 夜班 / 國定假日」
--                   public/shift-types-admin.html（HR UI 可建任意班別）
--                   public/schedule.html:226（placeholder 例「中班」）
-- Risk if not synced : dev 從 supabase_schedule.sql 重建 → Excel 匯入「中班」
--                      / 「夜班」/ 「國定假日」會找不到對應 shift_type、報
--                      「不認得班別」、整批匯入失敗
--
-- 對齊 prod 的 SQL（uncomment 執行）：
-- ⚠ 警告：ST005-ST008 的具體欄位值（start_time / end_time /
--   break_minutes / color / is_system / sort_order / crosses_midnight）
--   prod 實際值未知、且必為 HR 在 admin UI 自行設定。
--
--   Dev 對齊本地時請改採以下流程：
--     1. 在 prod Supabase SQL editor 跑：
--        SELECT * FROM shift_types WHERE id LIKE 'ST00[5-8]';
--     2. 將結果整段改成 INSERT ... ON CONFLICT (id) DO NOTHING 貼到本地
--     3. 不要相信下面這個 fallback (僅供結構參考、不是真實值)：
--
-- INSERT INTO shift_types (id, name, is_off, is_active) VALUES
--   ('ST005', '中班',     false, true),
--   ('ST006', '晚班',     false, true),
--   ('ST007', '夜班',     false, true),
--   ('ST008', '國定假日', true,  true)
-- ON CONFLICT (id) DO NOTHING;



-- ============================================================
-- C3: ST002 prod is_active=false、SQL 沒寫 UPDATE
-- ============================================================
-- Source of truth : prod
-- SQL files claim : supabase_schedule.sql:21（INSERT 時不指定 is_active）
--                   supabase_attendance_v2_batch_b.sql:21（is_active default=true）
-- Code references : public/schedule.html:687（前端 .filter(t => t.id !== 'ST002'))
--                   lib/shift-types/handler.js:13（後端 list 過濾 is_active=true）
-- Risk if not synced : dev 看到 ST002 在班別選單裡（前端已 .filter
--                      排除）但其他流程（例如 Excel 匯入、API 直接打）
--                      可能仍寫到舊 ST002 → 跟 prod 行為 diverge
--
-- 對齊 prod 的 SQL（uncomment 執行）：
-- UPDATE shift_types SET is_active = false WHERE id = 'ST002';



-- ============================================================
-- C4: shift_types 4 個 column drift（is_system / sort_order /
--                                    crosses_midnight / updated_at）
-- ============================================================
-- Source of truth : prod
-- SQL files claim : supabase_schedule.sql:6-15（CREATE TABLE 沒這 4 column）
--                   supabase_attendance_v2_batch_b.sql:17-21（只 ALTER 加
--                                                             break_minutes / is_active）
-- Code references : lib/shift-types/handler.js:8（ALLOWED_NEW_FIELDS 含全部 4 個）
--                   lib/shift-types/handler.js:41（is_system: false）
--                   lib/shift-types/handler.js:43（sort_order: nextSort）
--                   lib/shift-types/handler.js:39（crosses_midnight）
-- Risk if not synced : dev 重建 → /api/shift-types CRUD 寫入時拋 column does
--                      not exist、整個班別管理頁壞、排班 pill bar 也壞
--
-- 對齊 prod 的 SQL（uncomment 執行）：
-- ALTER TABLE shift_types ADD COLUMN IF NOT EXISTS is_system        BOOLEAN NOT NULL DEFAULT false;
-- ALTER TABLE shift_types ADD COLUMN IF NOT EXISTS sort_order       INT;
-- ALTER TABLE shift_types ADD COLUMN IF NOT EXISTS crosses_midnight BOOLEAN NOT NULL DEFAULT false;
-- ALTER TABLE shift_types ADD COLUMN IF NOT EXISTS updated_at       TIMESTAMPTZ DEFAULT NOW();
--
-- 系統預設班別 is_system 標記（uncomment 前先確認）：
-- ⚠ 警告：哪些 ID 應為 is_system=true 由 prod 真實狀態決定。
--   uncomment 前請在 prod 跑：
--     SELECT id, name, is_system FROM shift_types ORDER BY id;
--   再依結果調整下面 IN 清單。
--
-- UPDATE shift_types SET is_system = true WHERE id IN ('ST001','ST002','ST003','ST004');



-- ============================================================
-- C5: schedules.shift_type_id DROP NOT NULL
-- ============================================================
-- Source of truth : prod
-- SQL files claim : supabase_schedule.sql:31
--                   shift_type_id TEXT NOT NULL REFERENCES shift_types(id)
-- Code references : api/schedules/index.js:231
--                   shift_type_id: shift_type_id || null
--                   api/schedules/[id].js:81（同樣 || null pattern）
-- Risk if not synced : dev 重建 → 排班 modal 員工標「整天不排」(只送 note='__OFF__'、
--                      不送 shift_type_id) 時拋 23502 NOT NULL violation
--
-- 對齊 prod 的 SQL（uncomment 執行）：
-- ALTER TABLE schedules ALTER COLUMN shift_type_id DROP NOT NULL;



-- ============================================================
-- C6: schedules UNIQUE (employee_id, work_date) →
--                     (employee_id, work_date, segment_no)
-- ============================================================
-- Source of truth : prod（已是新 unique）
-- SQL files claim : 三檔不一致：
--                   supabase_schedule.sql:41        UNIQUE(employee_id, work_date)        ← 舊
--                   supabase_setup.sql:68            UNIQUE(employee_id, work_date)        ← 舊
--                   supabase_attendance_v2_batch_b.sql:78-80
--                     DROP CONSTRAINT IF EXISTS uq_schedules_employee_date;
--                     ADD CONSTRAINT uq_schedules_employee_date_segment
--                     UNIQUE (employee_id, work_date, segment_no);                          ← 新（正解）
-- Code references : api/schedules/index.js（多段排班依賴 segment_no upsert）
-- Risk if not synced : dev 跑 supabase_setup.sql + supabase_schedule.sql 沒跑 batch_b
--                      → 員工同一天標多段班別（早班 + 晚班）upsert 時撞舊 unique
--                      → 第二段被視為更新第一段、整段 segment_no 體系崩
--
-- 對齊 prod 的 SQL（uncomment 執行；也可改為直接跑 batch_b.sql line 78-80）：
-- ALTER TABLE schedules DROP CONSTRAINT IF EXISTS uq_schedules_employee_date;
-- ALTER TABLE schedules DROP CONSTRAINT IF EXISTS schedules_employee_id_work_date_key;
-- ALTER TABLE schedules ADD CONSTRAINT uq_schedules_employee_date_segment
--   UNIQUE (employee_id, work_date, segment_no);



-- ============================================================
-- C7: schedules.status vs schedule_periods.status — 兩個獨立 enum
-- ============================================================
-- ⚠ 不是真的 drift、是讀者陷阱（reader trap）：盤點時容易把這兩個
--   status 看成同一個東西、寫到一半發現對不上而踩坑、所以記在這裡。
--
-- schedules.status            : 3 狀態 ('draft', 'confirmed', 'locked')
--                               supabase_schedule.sql:36
--                               prod 應未擴成 5 狀態（grep 沒看到 code 寫
--                               schedules.status='published'）
--
-- schedule_periods.status     : 5 狀態（見 C1）
--                               其中 'published' 是 prod ALTER 後新增、SQL 檔沒同步
--
-- 兩張表 status 完全獨立、不要混用。寫 ALTER 時注意 table 名。
--
-- （沒有 ALTER 段、純 audit warning）



-- ============================================================
--  附錄：未來新增 drift 的處理流程
-- ============================================================
--
--  1. 不要 reset 編號。下次發現 drift → 加 C8 / C9 / ... 接續編號。
--
--  2. 嚴重程度高的 drift（會讓 dev 重建本地 DB 整個壞）優先補進來、
--     reader trap 性質的（如 C7）放後面。
--
--  3. 每筆段落格式照 C1-C6 的 5 段：
--       Source of truth / SQL files claim / Code references /
--       Risk if not synced / 對齊 prod 的 SQL
--
--  4. SQL 一律用 IF NOT EXISTS / DROP IF EXISTS / ON CONFLICT DO
--     NOTHING、確保 idempotent、即使被誤跑也是 no-op。
--
--  5. 累積 1 季左右、開新檔 supabase_known_drift_<YYYY_MM>.sql、
--     舊檔保留當歷史 snapshot、不刪。
--
-- ============================================================
