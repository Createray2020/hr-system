-- Fix: shift_types 缺 break_start / break_end 欄位、導致：
--   1) 員工請假頁「上下半段」切點只能用 (start+end)/2 中點
--   2) 時數演算用 ratio = work/span 把 break 均攤、自訂時段被多扣
-- 修補：補欄位、ST001 backfill 13:00-14:00、ST003/ST004 dirty break 清 0
-- 已於 2026-05-05 直接在 prod Supabase 執行、本檔留檔同步版控

BEGIN;

ALTER TABLE shift_types
  ADD COLUMN IF NOT EXISTS break_start TIME,
  ADD COLUMN IF NOT EXISTS break_end TIME;

UPDATE shift_types
   SET break_start = '13:00'::TIME,
       break_end   = '14:00'::TIME
 WHERE id = 'ST001';

UPDATE shift_types
   SET break_minutes = 0
 WHERE id IN ('ST003', 'ST004');

COMMIT;
