-- 2026-05-29 schedules.shift_type_id 拆 NOT NULL
--
-- 背景:supabase_schedule.sql:40 原本宣告 shift_type_id TEXT NOT NULL,但 API code
-- 早就在寫 || null pattern(api/schedules/index.js:329、api/schedules/[id].js:82),
-- 表示「自訂時段班表」需求(歷史 2026/1-4 月 backfill、Excel 表定時間有 0900-1300+
-- 1400-1800 二段、1900-0300 跨日等對不到既有 ST00x 的情況)需要 shift_type_id=null
-- 配合 start_time / end_time 獨立存。supabase_known_drift_2026_05.sql:130-137 C5 已記
-- 此 drift、本 migration 為版控對齊(prod 已手動執行、補檔留紀錄,不需再執行)。
--
-- 對應使用點:scripts/import_schedules.mjs(歷史排班批次匯入)

ALTER TABLE schedules ALTER COLUMN shift_type_id DROP NOT NULL;

-- 不 reload schema:純 column NOT NULL 約束變動、PostgREST 不認 NOT NULL flag、無需 reload。
