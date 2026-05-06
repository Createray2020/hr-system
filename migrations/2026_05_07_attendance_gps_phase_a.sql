-- Phase GPS A: attendance + office_locations 加 GPS 欄位
-- 用途:員工打卡時記錄 GPS 座標 + 距公司據點距離
-- 模式:soft mode(超出 radius 不擋打卡、純記錄 + flag)
-- 後續:Phase B 累積 1-2 週數據後切 hard mode

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

-- 3. gps_flag CHECK 拆出(避免欄位 IF NOT EXISTS 跳過時 CHECK 也跳過、用 DROP/ADD 確保 CHECK 永遠對齊)
ALTER TABLE attendance DROP CONSTRAINT IF EXISTS attendance_gps_flag_check;
ALTER TABLE attendance ADD CONSTRAINT attendance_gps_flag_check
  CHECK (
    gps_flag IS NULL OR
    gps_flag IN ('denied','outside','low_accuracy','mock_suspected')
  );

COMMIT;

NOTIFY pgrst, 'reload schema';
