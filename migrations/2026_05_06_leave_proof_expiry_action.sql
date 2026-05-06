-- Phase 1.5 升級: leave_types 加 proof_expiry_action(法定假 vs 短假分流)
--
-- 業務分流:
--   convert       — 員工該負責補證明、過期自動轉事假(既有行為)
--   mark_expired  — 法定一次性 / 第三方核發、員工被動、過期只標 proof_status=expired、
--                   leave_type 不動、HR 個案處理
--
-- 三段式:① VERIFY → ② ALTER → ③ UPDATE。已於 2026-05-06 直接在 prod 執行、本檔留檔同步版控。

-- ═══ ① VERIFY(prod 跑前先檢查現況、確認欄位不存在)═══
-- 預期:requires_proof=true 共 11 種、proof_expiry_action 欄位不存在
SELECT code, name_zh, requires_proof, proof_grace_days
  FROM leave_types
 WHERE requires_proof = true
 ORDER BY code;
SELECT column_name FROM information_schema.columns
 WHERE table_name = 'leave_types' AND column_name = 'proof_expiry_action';

-- ═══ ② ALTER(加欄位 + CHECK + 預設 'convert')═══
BEGIN;
ALTER TABLE leave_types
  ADD COLUMN IF NOT EXISTS proof_expiry_action TEXT NOT NULL DEFAULT 'convert'
    CHECK (proof_expiry_action IN ('convert', 'mark_expired'));
COMMIT;

-- ═══ ③ UPDATE(法定假改 mark_expired)═══
-- convert 留 sick / hospital_unpaid(短假、員工該負責補)
-- mark_expired 9 種:法定一次性 / 第三方核發 / 員工被動取得證明
BEGIN;
UPDATE leave_types SET proof_expiry_action = 'mark_expired'
 WHERE code IN (
   'work_injury',     -- 公傷:勞檢 / 醫評流程冗長
   'public',          -- 公假:法院 / 政府傳票、員工被動
   'marriage',        -- 婚假:戶籍謄本一次性
   'funeral',         -- 喪假:死亡證明、家屬被動
   'maternity',       -- 產假:法定 8 週、無條件給
   'paternity',       -- 陪產假:法定一次性
   'miscarriage',     -- 流產假:涉醫療隱私
   'pregnancy_rest',  -- 安胎假:醫囑、員工被動
   'parental'         -- 育嬰留停:勞保署核可
 );

-- 驗:預期回 11 row、9 mark_expired + 2 convert
SELECT code, name_zh, proof_expiry_action FROM leave_types
 WHERE requires_proof = true
 ORDER BY proof_expiry_action, code;
COMMIT;

-- ═══ ④ PostgREST schema cache reload ═══
NOTIFY pgrst, 'reload schema';
