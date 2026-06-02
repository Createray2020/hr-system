-- 2026-06-03: comp_time_balance 加 3 個 expiry payout audit snapshot 欄位
--
-- 背景:lib/comp-time/expiry-sweep.js auto_payout 從「過期當下重算時薪 × 寫死 1.34」
-- 改成「回讀來源加班單的凍結 estimated_pay,依比例折發未休時數」(對齊勞基法
-- §32-1「依原延長工作時間之工資計算標準」)。
--
-- 為了讓事後 audit 看得到金額怎麼算出來,加 3 個 snapshot 欄:
--   expiry_payout_unit_amount        每補休小時的單價(= source_overtime.estimated_pay / source_overtime.hours)
--   expiry_payout_source_multiplier  來源加班的凍結倍率(申請當下的 pay_multiplier)
--   expiry_payout_source_overtime_date  來源加班的 overtime_date(便於回溯)
--
-- 全部 nullable:
--   - 既有 expired_paid row(prod 6 筆均 source_overtime_request_id=null)新欄全 NULL,不 backfill
--   - manual_review 路徑或無法回溯來源的列、payout_amount 自身就 NULL、snapshot 也 NULL

BEGIN;

ALTER TABLE comp_time_balance
  ADD COLUMN IF NOT EXISTS expiry_payout_unit_amount       NUMERIC(10,4),
  ADD COLUMN IF NOT EXISTS expiry_payout_source_multiplier NUMERIC(4,2),
  ADD COLUMN IF NOT EXISTS expiry_payout_source_overtime_date DATE;

COMMENT ON COLUMN comp_time_balance.expiry_payout_unit_amount IS
  '每補休小時的折發單價(= 來源加班 estimated_pay / hours、§32-1 原延長工時工資)。
   audit/UI 顯示用、payout_amount = unit × remaining 反推驗算。';
COMMENT ON COLUMN comp_time_balance.expiry_payout_source_multiplier IS
  '來源加班申請當下凍結的 pay_multiplier(平日 1.34 / 休息日前 2h 1.34 / 國定 2.0 等),
   audit 用以說明本次折發費率;不參與 payout_amount 計算(unit 已隱含倍率)。';
COMMENT ON COLUMN comp_time_balance.expiry_payout_source_overtime_date IS
  '來源加班的 overtime_date(YYYY-MM-DD),audit 用以回溯本筆補休源於哪日加班。';

COMMIT;

-- ═══ PostgREST schema cache reload ═══
NOTIFY pgrst, 'reload schema';
