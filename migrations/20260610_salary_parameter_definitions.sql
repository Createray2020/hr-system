-- 20260610_salary_parameter_definitions.sql
-- Phase 1 步驟 1C:薪資費率參數中央表 + 初始 seed
--
-- 背景:目前 lib/salary/*.js 散落多個 hardcoded 費率常數(勞健保員工自付率、
-- 補充保費率/門檻倍數/單次給付上限、勞退強制+自願率、夜間津貼時薪),Phase 1 偵察
-- 已盤點完成。本表把可表示為 scalar 的費率/倍數/金額常數收進來、帶生效日期版本化,
-- 為 Phase 3 接入 getEffectiveParameter helper 鋪路。
--
-- 本 migration 做的事:
--   (1) CREATE TABLE salary_parameter_definitions(對齊 overtime_limits / insurance_settings_history
--       既有版本化命名:effective_from / effective_to DATE + created_by/at + updated_by/at)
--   (2) seed 8 筆 scalar 費率/常數,effective_from='2026-01-01'、effective_to=NULL、
--       created_by='system_migration',ON CONFLICT 三鍵 idempotent
--
-- 本 migration 不做的事:
--   - 不對接 calculator(留 Phase 3 接 getEffectiveParameter helper)
--   - 不 seed 稅額 frozen object(TW_2024/2025/2026_WITHHOLDING_DEFAULTS、結構化 3 欄、另案處理)
--   - 不 seed 雇主成本 occupationalRate / employmentRate / welfareRate(依行業而異、需 per-employer
--     override 機制,calculator 目前都傳 0、未實裝)
--
-- 對應檔案:
--   api/salary-parameters/index.js   - GET 列表 + POST 新增生效版本
--   api/salary-parameters/[id].js    - PATCH 描述性欄位(不動 value/生效日)
--   public/salary-parameters-admin.html - HR 後台管理頁

BEGIN;

CREATE TABLE IF NOT EXISTS salary_parameter_definitions (
  id               bigserial PRIMARY KEY,
  category         text NOT NULL,
  parameter_name   text NOT NULL,
  label_zh         text NOT NULL,
  parameter_value  numeric NOT NULL,
  unit             text NOT NULL DEFAULT 'rate',
  regulation_basis text,
  effective_from   date NOT NULL,
  effective_to     date,
  note             text,
  created_by       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       text,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (category, parameter_name, effective_from)
);

CREATE INDEX IF NOT EXISTS idx_salary_param_lookup
  ON salary_parameter_definitions (category, parameter_name, effective_from DESC);

COMMENT ON TABLE salary_parameter_definitions IS
  '薪資費率參數中央表(Phase 1C 建、Phase 3 接 calculator)。同 (category,parameter_name)
   多版本以 effective_from/effective_to 區隔,當前版本 = effective_to IS NULL 那筆。';

-- ─── Seed ──────────────────────────────────────────────────
-- 8 筆 scalar 費率/常數,effective_from='2026-01-01'、idempotent(ON CONFLICT 三鍵)
INSERT INTO salary_parameter_definitions
  (category, parameter_name, label_zh, parameter_value, unit, regulation_basis,
   effective_from, effective_to, note, created_by)
VALUES
  ('labor_insurance',      'employee_rate',          '勞保員工自付率',          0.023,    'rate',
   '勞工保險條例(總費率 11.5% × 員工負擔比例 20%)',
   DATE '2026-01-01', NULL,
   '對應 lib/salary/calculator.js TW_2026_LABOR_INS_EMPLOYEE_RATE;優先使用 insurance_settings.labor_ins_employee 直接金額、本值僅作 fallback',
   'system_migration'),

  ('health_insurance',     'employee_rate',          '健保員工自付率',          0.01551,  'rate',
   '全民健康保險法(總費率 5.17% × 員工負擔比例 30%、不含眷屬)',
   DATE '2026-01-01', NULL,
   '對應 lib/salary/calculator.js TW_2026_HEALTH_INS_EMPLOYEE_RATE;優先使用 insurance_settings.health_ins_employee 直接金額、本值僅作 fallback',
   'system_migration'),

  ('supplementary_health', 'rate',                   '二代健保補充保費率',      0.0211,   'rate',
   '全民健康保險法 §31',
   DATE '2026-01-01', NULL,
   '對應 lib/salary/supplementary-health.js TW_2026_SUPPLEMENTARY_HEALTH_RATE',
   'system_migration'),

  ('supplementary_health', 'threshold_multiplier',   '補充保費起扣門檻倍數',    4,        'multiplier',
   '全民健康保險法(累計達投保金額 4 倍超過部分課徵)',
   DATE '2026-01-01', NULL,
   '對應 lib/salary/supplementary-health.js thresholdMultiplier default',
   'system_migration'),

  ('supplementary_health', 'cap_per_payment',        '補充保費單次給付上限',    1000000,  'NTD',
   '全民健康保險法',
   DATE '2026-01-01', NULL,
   '對應 lib/salary/supplementary-health.js capPerPayment default',
   'system_migration'),

  ('pension',              'employer_mandatory_rate','雇主強制提撥率',          0.06,     'rate',
   '勞工退休金條例 §14',
   DATE '2026-01-01', NULL,
   '對應 lib/salary/pension-deduction.js TW_PENSION_EMPLOYER_MANDATORY_RATE',
   'system_migration'),

  ('pension',              'employee_voluntary_max','員工自願提繳上限率',      0.06,     'rate',
   '勞工退休金條例 §14',
   DATE '2026-01-01', NULL,
   '對應 lib/salary/pension-deduction.js TW_PENSION_EMPLOYEE_VOLUNTARY_MAX',
   'system_migration'),

  ('night_allowance',      'per_hour_ntd',           '夜間津貼時薪',            50,       'NTD',
   '公司政策(非法定)',
   DATE '2026-01-01', NULL,
   '對應 lib/salary/night-allowance.js NIGHT_ALLOWANCE_PER_HOUR;對夜班 night_eligible=true 班別整段 × 此值/h',
   'system_migration')

ON CONFLICT (category, parameter_name, effective_from) DO NOTHING;

COMMIT;

-- Verify(跑完查一眼,期望 8 筆 effective_to=NULL):
-- SELECT category, parameter_name, label_zh, parameter_value, unit, effective_from, effective_to
--   FROM salary_parameter_definitions
--  ORDER BY category, parameter_name, effective_from DESC;
