-- 2026-05-28 leave_types 補法定上限 backfill — menstrual / family_care
--
-- 背景:
--   supabase_attendance_v2_batch_a.sql L103-105 註解明示:prod 7 種假別
--   (work_injury / menstrual / family_care / typhoon / voting / hospital_unpaid /
--   job_seeking)的 INSERT 「只覆蓋 code / name_zh / display_order / 4 個 Phase 1.1
--   欄位、其他欄位取 CREATE TABLE 預設值」、所以 legal_max_days_per_year 實際是 NULL。
--
--   本批次只補兩種「累積型有上限」且法源明確的假別,其他 5 種要嘛非累積型(typhoon /
--   voting 不可預期)、要嘛無明確年上限(work_injury 個案 / hospital_unpaid 個案 /
--   job_seeking 預告期內),不在本 backfill 範圍。
--
-- 法源:
--   - menstrual    生理假:性別工作平等法 §14 — 每月得請 1 日、全年合計 12 日
--   - family_care  家庭照顧假:性別工作平等法 §20 — 每年得請 7 日
--
-- Idempotent guard:
--   WHERE legal_max_days_per_year IS NULL — 已有值的不覆蓋、重跑無副作用、可重複執行。
--
-- 三段式:① VERIFY pre → ② UPDATE → ③ VERIFY post


-- ═══════════════════════════════════════════
-- ① VERIFY PRE — 跑前確認兩 row 現況
-- ═══════════════════════════════════════════

SELECT code, name_zh, legal_max_days_per_year, has_balance, is_paid, advance_rule
  FROM leave_types
 WHERE code IN ('menstrual', 'family_care')
 ORDER BY code;
-- 預期:2 row、legal_max_days_per_year 兩個都是 NULL(若已有值代表別人補過、本 migration
-- 的 IS NULL guard 會跳過、安全;若實際是其他值則需停下檢查為何被改)


-- ═══════════════════════════════════════════
-- ② UPDATE 補值(含 IS NULL guard、冪等)
-- ═══════════════════════════════════════════

BEGIN;

-- menstrual 生理假:性別工作平等法 §14
UPDATE leave_types
   SET legal_max_days_per_year = 12,
       updated_at = NOW()
 WHERE code = 'menstrual'
   AND legal_max_days_per_year IS NULL;
-- 預期:1 row updated(若 0 row 代表已有值、guard 起作用)

-- family_care 家庭照顧假:性別工作平等法 §20
UPDATE leave_types
   SET legal_max_days_per_year = 7,
       updated_at = NOW()
 WHERE code = 'family_care'
   AND legal_max_days_per_year IS NULL;
-- 預期:1 row updated

COMMIT;


-- ═══════════════════════════════════════════
-- ③ VERIFY POST — 跑後確認生效
-- ═══════════════════════════════════════════

SELECT code, name_zh, legal_max_days_per_year, updated_at
  FROM leave_types
 WHERE code IN ('menstrual', 'family_care')
 ORDER BY code;
-- 預期:
--   family_care | 家庭照顧假 | 7  | (剛剛時間)
--   menstrual   | 生理假     | 12 | (剛剛時間)


-- ═══════════════════════════════════════════
-- ④ PostgREST schema cache reload
-- ═══════════════════════════════════════════

NOTIFY pgrst, 'reload schema';
