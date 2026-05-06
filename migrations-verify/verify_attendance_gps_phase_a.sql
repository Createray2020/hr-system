-- ==========================================
-- Migration:2026_05_07_attendance_gps_phase_a.sql
-- Phase:GPS A(soft mode、不擋打卡、純記錄)
-- 用途:office_locations 新表 + attendance 加 11 個 GPS 欄位 + gps_flag CHECK
-- 類型:CREATE TABLE + 1 partial INDEX + ALTER ADD COLUMN × 11 + DROP/ADD CHECK
--      (無 row-level data migration)
-- ==========================================

-- ═══════════════════════════════════════════
-- ① VERIFY PRE — 跑前確認現況
-- 預期:
--   Q1.1 office_locations 表不存在
--   Q1.2 attendance 11 個 GPS 欄位都不存在(0 row)
--   Q1.3 attendance_gps_flag_check constraint 不存在(0 row)
--   Q1.4 attendance 總 row count(背景對照、跑後不變)
-- ═══════════════════════════════════════════

-- Q1.1 office_locations 表不存在
SELECT to_regclass('public.office_locations');                          -- 預期:NULL

-- Q1.2 attendance 11 個 GPS 欄位都不存在
SELECT column_name FROM information_schema.columns
 WHERE table_schema='public' AND table_name='attendance'
   AND column_name IN (
     'clock_in_lat','clock_in_lng','clock_in_accuracy',
     'clock_in_distance_m','clock_in_location_id',
     'clock_out_lat','clock_out_lng','clock_out_accuracy',
     'clock_out_distance_m','clock_out_location_id',
     'gps_flag'
   );                                                                    -- 預期:0 row

-- Q1.3 attendance 沒有 attendance_gps_flag_check constraint
SELECT conname FROM pg_constraint
 WHERE conrelid = 'attendance'::regclass
   AND conname = 'attendance_gps_flag_check';                            -- 預期:0 row

-- Q1.4 attendance 總 row(背景、跑前後該不變)
SELECT COUNT(*) AS attendance_total_pre FROM attendance;


-- ═══════════════════════════════════════════
-- ② ALTER — 真正的 migration(直接從原檔複製)
-- ═══════════════════════════════════════════

BEGIN;

-- 1. office_locations 新表
CREATE TABLE IF NOT EXISTS office_locations (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  lat           NUMERIC(10,7) NOT NULL,
  lng           NUMERIC(10,7) NOT NULL,
  radius_m      INT NOT NULL DEFAULT 150,
  is_active     BOOLEAN NOT NULL DEFAULT true,
  note          TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_office_locations_active
  ON office_locations(is_active) WHERE is_active = true;

-- 2. attendance ALTER 加 11 個 GPS 欄位
ALTER TABLE attendance
  ADD COLUMN IF NOT EXISTS clock_in_lat          NUMERIC(10,7),
  ADD COLUMN IF NOT EXISTS clock_in_lng          NUMERIC(10,7),
  ADD COLUMN IF NOT EXISTS clock_in_accuracy     NUMERIC(6,1),
  ADD COLUMN IF NOT EXISTS clock_in_distance_m   NUMERIC(8,1),
  ADD COLUMN IF NOT EXISTS clock_in_location_id  TEXT REFERENCES office_locations(id),
  ADD COLUMN IF NOT EXISTS clock_out_lat         NUMERIC(10,7),
  ADD COLUMN IF NOT EXISTS clock_out_lng         NUMERIC(10,7),
  ADD COLUMN IF NOT EXISTS clock_out_accuracy    NUMERIC(6,1),
  ADD COLUMN IF NOT EXISTS clock_out_distance_m  NUMERIC(8,1),
  ADD COLUMN IF NOT EXISTS clock_out_location_id TEXT REFERENCES office_locations(id),
  ADD COLUMN IF NOT EXISTS gps_flag              TEXT;

-- 3. gps_flag CHECK 拆出
ALTER TABLE attendance DROP CONSTRAINT IF EXISTS attendance_gps_flag_check;
ALTER TABLE attendance ADD CONSTRAINT attendance_gps_flag_check
  CHECK (
    gps_flag IS NULL OR
    gps_flag IN ('denied','outside','low_accuracy','mock_suspected')
  );

COMMIT;

NOTIFY pgrst, 'reload schema';


-- ═══════════════════════════════════════════
-- ③ VERIFY POST — 跑後確認生效
-- 預期:
--   Q3.1 office_locations 表已建立
--   Q3.2 office_locations 9 column + types 對
--   Q3.3 idx_office_locations_active partial index 存在
--   Q3.4 attendance 11 個 GPS 欄位都在
--   Q3.5 attendance 兩個 location_id FK 對 office_locations(id)
--   Q3.6 attendance_gps_flag_check CHECK 含 4 個值
--   Q3.7 attendance 既有 row GPS 欄位全 NULL(剛 ALTER 還沒寫過)
--   Q3.8 attendance 總 row 不變
-- ═══════════════════════════════════════════

-- Q3.1 office_locations 表已建立
SELECT to_regclass('public.office_locations');                          -- 預期:public.office_locations

-- Q3.2 office_locations 9 columns + types
SELECT column_name, data_type, is_nullable, column_default
  FROM information_schema.columns
 WHERE table_schema='public' AND table_name='office_locations'
 ORDER BY ordinal_position;
-- 預期 9 row:
--   id          text                       NO  NULL
--   name        text                       NO  NULL
--   lat         numeric                    NO  NULL
--   lng         numeric                    NO  NULL
--   radius_m    integer                    NO  150
--   is_active   boolean                    NO  true
--   note        text                       YES NULL
--   created_at  timestamp with time zone   NO  now()
--   updated_at  timestamp with time zone   NO  now()

-- Q3.3 partial index 存在
SELECT indexname, indexdef FROM pg_indexes
 WHERE schemaname='public' AND tablename='office_locations'
 ORDER BY indexname;
-- 預期 2 row:
--   office_locations_pkey            CREATE UNIQUE INDEX ...(id)
--   idx_office_locations_active      CREATE INDEX ...(is_active) WHERE (is_active = true)

-- Q3.4 attendance 11 個 GPS 欄位 + types
SELECT column_name, data_type, is_nullable
  FROM information_schema.columns
 WHERE table_schema='public' AND table_name='attendance'
   AND column_name IN (
     'clock_in_lat','clock_in_lng','clock_in_accuracy',
     'clock_in_distance_m','clock_in_location_id',
     'clock_out_lat','clock_out_lng','clock_out_accuracy',
     'clock_out_distance_m','clock_out_location_id',
     'gps_flag'
   )
 ORDER BY column_name;
-- 預期 11 row、全 nullable=YES:
--   clock_in_accuracy      numeric  YES
--   clock_in_distance_m    numeric  YES
--   clock_in_lat           numeric  YES
--   clock_in_lng           numeric  YES
--   clock_in_location_id   text     YES
--   clock_out_accuracy     numeric  YES
--   clock_out_distance_m   numeric  YES
--   clock_out_lat          numeric  YES
--   clock_out_lng          numeric  YES
--   clock_out_location_id  text     YES
--   gps_flag               text     YES

-- Q3.5 attendance 兩個 location_id FK 對 office_locations(id)
SELECT conname, pg_get_constraintdef(oid)
  FROM pg_constraint
 WHERE conrelid = 'attendance'::regclass
   AND contype = 'f'
   AND conname LIKE '%location_id%';
-- 預期 2 row:
--   FOREIGN KEY (clock_in_location_id)  REFERENCES office_locations(id)
--   FOREIGN KEY (clock_out_location_id) REFERENCES office_locations(id)

-- Q3.6 attendance_gps_flag_check CHECK 含 4 個值
SELECT conname, pg_get_constraintdef(oid)
  FROM pg_constraint
 WHERE conrelid = 'attendance'::regclass
   AND conname = 'attendance_gps_flag_check';
-- 預期 1 row、CHECK ((gps_flag IS NULL) OR (gps_flag = ANY (ARRAY[
--   'denied','outside','low_accuracy','mock_suspected'])))

-- Q3.7 attendance 既有 row GPS 欄位全 NULL(剛 ALTER 還沒寫過)
SELECT COUNT(*) AS gps_dirty_count
  FROM attendance
 WHERE clock_in_lat IS NOT NULL
    OR clock_in_lng IS NOT NULL
    OR clock_in_accuracy IS NOT NULL
    OR clock_in_distance_m IS NOT NULL
    OR clock_in_location_id IS NOT NULL
    OR clock_out_lat IS NOT NULL
    OR clock_out_lng IS NOT NULL
    OR clock_out_accuracy IS NOT NULL
    OR clock_out_distance_m IS NOT NULL
    OR clock_out_location_id IS NOT NULL
    OR gps_flag IS NOT NULL;                                            -- 預期:0

-- Q3.8 attendance 總 row 不變
SELECT COUNT(*) AS attendance_total_post FROM attendance;
-- 預期:= Q1.4 attendance_total_pre
