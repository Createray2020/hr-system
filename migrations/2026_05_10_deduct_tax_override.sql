-- 階段 2.6.1: salary_records 加 deduct_tax_manual_override 欄位 + backfill 既有資料
-- 對應驗證: migrations-verify/verify_deduct_tax_override.sql
-- 規則: idempotent(可重跑)、整段 transaction 包住

BEGIN;

-- ====================================================================
-- §1. 加欄位
-- ====================================================================

ALTER TABLE salary_records
  ADD COLUMN IF NOT EXISTS deduct_tax_manual_override BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN salary_records.deduct_tax_manual_override IS
  '是否鎖定 deduct_tax 不讓 calculator 自動覆蓋。
   false = _auto(由 lib/salary/tax-withholding.js calculateWithholding 算);
   true  = _manual(保留既有 deduct_tax 值、calculator 跳過該欄位)。
   階段 2.6.1 backfill: 既有 deduct_tax > 0 的 row 自動標 true 保護。';

-- ====================================================================
-- §2. backfill — 保護既有 HR 設定的扣稅金額
-- 規則: 只標 deduct_tax > 0 的 row 為 manual override
-- (deduct_tax = 0 或 null 視為「沒設過」、走 _auto 由 calculator 算)
-- ====================================================================

UPDATE salary_records
   SET deduct_tax_manual_override = true
 WHERE deduct_tax IS NOT NULL
   AND deduct_tax > 0
   AND deduct_tax_manual_override = false;  -- idempotent: 重跑不重複動

COMMIT;
