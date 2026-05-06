-- migrations/2026_05_06_leave_pending_status_cleanup.sql
--
-- Phase 1.5 cleanup:把 leave_requests 的 legacy 'pending' 全部 UPDATE → 'pending_mgr'、
-- ALTER CHECK 從 7 值縮成 6 值(拔掉 'pending')。
--
-- 背景:Phase 1.1 加多階審核(pending_mgr / pending_ceo)時保留 'pending' 向後相容、
-- Phase 1.3 PATCH handler 用 normalizeStage('pending')='pending_mgr' 處理舊 row。
-- Phase 1.5 audit:prod 只剩 2 筆 'pending' row、cleanup 安全。
--
-- 執行順序(user 在 Supabase SQL Editor 手動操作):
--   ① VERIFY:跑這條看 'pending' count(audit 時是 2、user 跑時可能更少)
--   ② UPDATE 既有 'pending' → 'pending_mgr'
--   ③ ALTER CHECK 拔 'pending'(縮成 6 值)
--
-- 影響:
--   - write-side:api/leaves/index.js legacy POST 已改寫 'pending_mgr'(commit 751fb22)
--   - read-side:api/leaves/[id].js normalizeStage 仍保留作 safety net、無害
--   - frontend(leave-admin/leave/employee-leave/dashboard)的 'pending' filter 仍含、
--     向後相容、不影響功能(prod 已無 pending row、filter match 不到也 OK)


-- ═══ ① VERIFY:跑這條看 affected count ═══
SELECT status, COUNT(*) AS row_count
FROM leave_requests
GROUP BY status
ORDER BY status;
-- 期望輸出(audit 時 snapshot、user 跑時數字可能不同):
--   approved      4
--   pending       2   ← 將被 UPDATE → pending_mgr
--   pending_mgr   1
--   rejected      1


-- ═══ ② UPDATE 既有 'pending' → 'pending_mgr' ═══
UPDATE leave_requests SET status = 'pending_mgr' WHERE status = 'pending';
-- 期望:UPDATE N rows(N = ① 的 pending count)


-- ═══ ③ ALTER CHECK 拔 'pending'(縮成 6 值)═══
-- DROP CONSTRAINT 名稱沿用 Phase 1.1 schema 的 'leave_requests_status_check'。
-- IF EXISTS 防 user 重跑此 migration 時報錯。
ALTER TABLE leave_requests DROP CONSTRAINT IF EXISTS leave_requests_status_check;
ALTER TABLE leave_requests ADD CONSTRAINT leave_requests_status_check
  CHECK (status IN (
    'pending_mgr',   -- 等主管審
    'pending_ceo',   -- 主管已批、等執行長審
    'approved',      -- 執行長已批、待 HR 歸檔
    'archived',      -- HR 已歸檔(最終)
    'rejected',      -- 任一階拒絕(最終)
    'cancelled'      -- 員工撤回(最終)
  ));
-- 注意:未來任何 INSERT/UPDATE leave_requests.status 必須用 6 值之一、
-- 不能寫 'pending'。Phase 1.3 normalizeStage 仍保留作 read-side safety net、
-- 但 write-side 已關門。
