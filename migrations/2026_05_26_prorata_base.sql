-- 2026-05-26 B26 批次 3.5:salary_records 加 prorata_base 欄位 + 改 GENERATED gross/net 公式
--
-- 背景:批次 4 calculator 需對 is_final_month=true 員工算 pro-rata 月薪。但既有
-- gross_salary / net_salary 是 DB GENERATED ALWAYS column、JS 不能 if 分支 override。
-- 解法:加新 input 欄位 prorata_base + 改 GENERATED 用 COALESCE(prorata_base, base_salary)
-- 自動選對(非 final-month NULL 走 base_salary、final-month 寫 prorata_base 走 pro-rata 值)。
--
-- 此次 migration 跟 2026-05-10 salary_records_v2 第二次重建 pattern 一致(攤開 net、
-- 不 reference gross GENERATED、避開 PG 42P17「GENERATED 不能 reference 另一個 GENERATED」)。
--
-- 三段式:① VERIFY pre + 既有公式 snapshot → ② DROP + RECREATE → ③ VERIFY post 對比


-- ═══════════════════════════════════════════
-- ① VERIFY PRE
-- ═══════════════════════════════════════════

-- Q1.1 prorata_base 不存在
SELECT column_name FROM information_schema.columns
 WHERE table_schema='public' AND table_name='salary_records'
   AND column_name = 'prorata_base';
-- 預期:0 row

-- Q1.2 既有 gross_salary / net_salary 是 GENERATED + 公式 snapshot
--   跑前先把當下值 snapshot 存到 temp table、跑完用 Q3.3 比對「migration 前後值一致」
DROP TABLE IF EXISTS _b26_gross_net_snapshot;
CREATE TEMP TABLE _b26_gross_net_snapshot AS
  SELECT id, gross_salary, net_salary FROM salary_records;
SELECT COUNT(*) AS snapshot_rows FROM _b26_gross_net_snapshot;
-- 預期回 1 row、snapshot_rows = salary_records 既有 row 數(prod 看 ~45)

-- Q1.3 既有 GENERATED column 確認(公式預期 v2:含 4 個 bonus + 7 個 deduct 攤開)
SELECT column_name, generation_expression
  FROM information_schema.columns
 WHERE table_schema='public' AND table_name='salary_records'
   AND column_name IN ('gross_salary','net_salary');
-- 預期 2 row、is_generated='ALWAYS'、expression 含 12 income (含 4 bonus) 跟 12 deduction


-- ═══════════════════════════════════════════
-- ② DROP + RECREATE
-- 順序:net 先 DROP(避 PG 依賴 / 邏輯順序)、gross 後 DROP
-- ═══════════════════════════════════════════

BEGIN;

-- 1. ADD prorata_base(input 欄位、非 GENERATED)
ALTER TABLE salary_records ADD COLUMN IF NOT EXISTS
  prorata_base NUMERIC(12,2);

COMMENT ON COLUMN salary_records.prorata_base IS
  'B26 批次 3.5:離職月 pro-rata 後月薪。非 final-month 為 NULL、走 base_salary。GENERATED gross_salary / net_salary 用 COALESCE(prorata_base, base_salary) 自動選對。由 calculator.js is_final_month=true 分支寫入 = base_salary × (worked_days / total_days_in_month)。';

-- 2. DROP gross / net(順序:依 SQL 攤開公式語意 net 含 gross 所有 income、PG 限制兩個都需重建)
ALTER TABLE salary_records DROP COLUMN IF EXISTS net_salary;
ALTER TABLE salary_records DROP COLUMN IF EXISTS gross_salary;

-- 3. RECREATE gross_salary
--    對齊 migrations/2026_05_10_salary_records_v2.sql:117-131 既有公式(12 income)
--    唯一改動:base_salary → COALESCE(prorata_base, base_salary)
ALTER TABLE salary_records ADD COLUMN gross_salary NUMERIC(12,2)
  GENERATED ALWAYS AS (
    COALESCE(prorata_base, base_salary)
    + COALESCE(attendance_bonus_actual, 0::numeric)
    + COALESCE(allowance, 0::numeric)
    + COALESCE(extra_allowance, 0::numeric)
    + COALESCE((overtime_pay_auto + overtime_pay_manual), 0::numeric)
    + COALESCE(comp_expiry_payout, 0::numeric)
    + COALESCE(holiday_work_pay, 0::numeric)
    + COALESCE(settlement_amount, 0::numeric)
    + COALESCE(bonus_yearend, 0::numeric)
    + COALESCE(bonus_festival, 0::numeric)
    + COALESCE(bonus_performance, 0::numeric)
    + COALESCE(bonus_other, 0::numeric)
  ) STORED;

-- 4. RECREATE net_salary(攤開、不 reference gross GENERATED;PG 42P17 限制)
--    對齊 migrations/2026_05_10_salary_records_v2.sql:134-160 既有公式(12 income + 12 deduction)
--    唯一改動:base_salary → COALESCE(prorata_base, base_salary)
ALTER TABLE salary_records ADD COLUMN net_salary NUMERIC(12,2)
  GENERATED ALWAYS AS (
    COALESCE(prorata_base, base_salary)
    + COALESCE(attendance_bonus_actual, 0::numeric)
    + COALESCE(allowance, 0::numeric)
    + COALESCE(extra_allowance, 0::numeric)
    + COALESCE((overtime_pay_auto + overtime_pay_manual), 0::numeric)
    + COALESCE(comp_expiry_payout, 0::numeric)
    + COALESCE(holiday_work_pay, 0::numeric)
    + COALESCE(settlement_amount, 0::numeric)
    + COALESCE(bonus_yearend, 0::numeric)
    + COALESCE(bonus_festival, 0::numeric)
    + COALESCE(bonus_performance, 0::numeric)
    + COALESCE(bonus_other, 0::numeric)
    - COALESCE(deduct_absence, 0::numeric)
    - COALESCE(deduct_labor_ins, 0::numeric)
    - COALESCE(deduct_health_ins, 0::numeric)
    - COALESCE(deduct_tax, 0::numeric)
    - COALESCE(attendance_penalty_total, 0::numeric)
    - COALESCE(deduct_pension_voluntary, 0::numeric)
    - COALESCE(deduct_supplementary_health, 0::numeric)
    - COALESCE(deduct_welfare_fund, 0::numeric)
    - COALESCE(deduct_union_fee, 0::numeric)
    - COALESCE(deduct_court_garnishment, 0::numeric)
    - COALESCE(deduct_loan_repayment, 0::numeric)
    - COALESCE(deduct_other, 0::numeric)
  ) STORED;

COMMIT;

NOTIFY pgrst, 'reload schema';


-- ═══════════════════════════════════════════
-- ③ VERIFY POST(跑後對比 migration 前後 gross/net 完全一致)
-- ═══════════════════════════════════════════

-- Q3.1 prorata_base 欄位已加(NULL 預設、非 GENERATED)
SELECT column_name, data_type, is_nullable, is_generated, column_default
  FROM information_schema.columns
 WHERE table_schema='public' AND table_name='salary_records'
   AND column_name = 'prorata_base';
-- 預期 1 row:numeric / YES / NEVER / NULL

-- Q3.2 gross/net GENERATED 公式含 COALESCE(prorata_base, base_salary)
SELECT column_name, is_generated, generation_expression
  FROM information_schema.columns
 WHERE table_schema='public' AND table_name='salary_records'
   AND column_name IN ('gross_salary','net_salary');
-- 預期 2 row、is_generated='ALWAYS'、expression 內含 'COALESCE(prorata_base, base_salary)'

-- Q3.3 ⚠ 比對 migration 前後既有 row gross / net 是否完全一致
--      (prorata_base 都 NULL → COALESCE 回 base_salary → 算出值應等於 migration 前)
SELECT s.id,
       b.gross_salary AS old_gross, s.gross_salary AS new_gross,
       (b.gross_salary - s.gross_salary) AS gross_diff,
       b.net_salary AS old_net, s.net_salary AS new_net,
       (b.net_salary - s.net_salary) AS net_diff
FROM salary_records s
JOIN _b26_gross_net_snapshot b ON b.id = s.id
WHERE COALESCE(b.gross_salary, 0) != COALESCE(s.gross_salary, 0)
   OR COALESCE(b.net_salary, 0)   != COALESCE(s.net_salary, 0);
-- 預期 0 row(所有既有 row gross/net 完全一致、無 diff)
-- 若 >0 row:DEBUG、可能是 backfill 對齊問題;rollback 跑回退 SQL(見 ④)

-- Q3.4 抽 5 個既有 record snapshot 對比細節
SELECT s.id, s.base_salary, s.prorata_base,
       b.gross_salary AS old_gross, s.gross_salary AS new_gross,
       b.net_salary AS old_net, s.net_salary AS new_net
FROM salary_records s
JOIN _b26_gross_net_snapshot b ON b.id = s.id
ORDER BY s.id LIMIT 5;
-- 預期 prorata_base NULL、gross/net 跟 snapshot 完全一致

-- Q3.5 對柯郁含 5 月 record 驗(批次 3 已建、is_final_month=true、prorata_base NULL → 走 base_salary)
SELECT id, base_salary, prorata_base, is_final_month, worked_days, total_days_in_month,
       gross_salary, net_salary
FROM salary_records
WHERE id = 'S_EMP_01251101_2026_05';
-- 預期 prorata_base=NULL(批次 4 calculator pro-rata 重算後才會寫值)
-- gross/net 走 base_salary 公式、未變


-- ═══════════════════════════════════════════
-- ④ ROLLBACK PLAN(若 Q3.3 有 diff、Q3.5 未預期值)
-- ═══════════════════════════════════════════
-- BEGIN;
-- ALTER TABLE salary_records DROP COLUMN net_salary;
-- ALTER TABLE salary_records DROP COLUMN gross_salary;
-- ALTER TABLE salary_records DROP COLUMN prorata_base;
-- -- Restore 原 v2 公式(從 migrations/2026_05_10_salary_records_v2.sql L117-160 複製)
-- ALTER TABLE salary_records ADD COLUMN gross_salary ... (原 12 income、不含 prorata_base)
-- ALTER TABLE salary_records ADD COLUMN net_salary   ... (原 12 income + 12 deduction、不含 prorata_base)
-- COMMIT;
