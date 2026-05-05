-- Fix: leave_requests.days INTEGER 無法承載半天 (0.5) / 自訂時段請假
-- Root cause: schema 定義為 INTEGER、但 lib/leave/request-flow.js 寫入時為 hours/8 (小數)
-- 影響：所有 hours 非 8 整數倍的請假申請（半天、自訂時段）皆 PG syntax error
-- 修補：widening INTEGER → NUMERIC(5,2)，舊資料無損
-- 已於 2026-05-05 直接在 prod Supabase 執行，本檔留檔同步版控

BEGIN;

ALTER TABLE leave_requests
  ALTER COLUMN days TYPE NUMERIC(5,2);

COMMIT;
