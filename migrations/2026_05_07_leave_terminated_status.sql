-- Phase 1.6: HR 終止 expired row 流程
--
-- 背景:Phase 1.5 升級後 9 法定假 mark_expired:cron UPDATE proof_status='expired'、
-- status 不動(仍 pending_mgr/pending_ceo)。HR 沒按鈕能動這些 row、變死資料。
-- 本 migration 加新 'terminated' status 讓 HR 把 expired row 拔出 pending 流程、保留紀錄。
--
-- 設計:Option A — 加新 status、不重用 archived(嚴守 approved → archived 不變式)
-- 新欄位 terminated_by / terminated_at(不重用 archived_*、語義不混淆)
-- proof_status 保留 'expired'(終止後仍標、為「為何被終止」歷史紀錄)
--
-- 三段式:① VERIFY → ② ALTER CHECK + ADD COLUMNS → ③ 無 backfill

-- ═══ ① VERIFY(prod 跑前先確認現況)═══
-- 期望:status 6 值、無 'terminated';terminated_by / terminated_at 欄位不存在
SELECT conname, pg_get_constraintdef(oid)
  FROM pg_constraint
 WHERE conrelid = 'leave_requests'::regclass
   AND conname = 'leave_requests_status_check';
SELECT column_name FROM information_schema.columns
 WHERE table_name = 'leave_requests' AND column_name IN ('terminated_by','terminated_at');
SELECT COUNT(*) AS expired_pending_count
  FROM leave_requests
 WHERE proof_status = 'expired'
   AND status IN ('pending_mgr','pending_ceo');

-- ═══ ② ALTER CHECK 6 值 → 7 值(加 'terminated')═══
-- DROP CONSTRAINT 名稱沿用 Phase 1.1 / 1.5 cleanup 的 'leave_requests_status_check'。
-- IF EXISTS 防 user 重跑此 migration 時報錯。
BEGIN;
ALTER TABLE leave_requests DROP CONSTRAINT IF EXISTS leave_requests_status_check;
ALTER TABLE leave_requests ADD CONSTRAINT leave_requests_status_check
  CHECK (status IN (
    'pending_mgr',   -- 等主管審
    'pending_ceo',   -- 主管已批、等執行長審
    'approved',      -- 執行長已批、待 HR 歸檔
    'archived',      -- HR 已歸檔(approved → archived 嚴守、最終)
    'rejected',      -- 任一階拒絕(最終)
    'cancelled',     -- 員工撤回(最終)
    'terminated'     -- HR 終止 expired row(pending_* + proof_expired → terminated、最終)
  ));

-- ② ADD COLUMN terminated_by / terminated_at(不重用 archived_*)
ALTER TABLE leave_requests
  ADD COLUMN IF NOT EXISTS terminated_by TEXT REFERENCES employees(id),
  ADD COLUMN IF NOT EXISTS terminated_at TIMESTAMPTZ;
COMMIT;

-- ═══ ③ 無 backfill ═══
-- 現存 expired pending row 由 HR 手動於 leave-admin 點「📛 終止此申請」處理、
-- 不批量寫入(每筆需 HR 個案決定)。

-- ═══ ④ PostgREST schema cache reload ═══
NOTIFY pgrst, 'reload schema';
