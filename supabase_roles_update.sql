-- 在 Supabase SQL Editor 執行此檔案
-- 為 employees 表新增 employment_type 欄位

ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS employment_type TEXT DEFAULT 'full_time'
  CHECK (employment_type IN ('full_time', 'part_time'));
