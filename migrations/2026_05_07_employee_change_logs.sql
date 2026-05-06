-- Phase 1.7.2:employee_change_logs audit 表
--
-- 背景:Phase 1.7 MVP 離職員工檔案頁標 disclaimer「顯示部門 = 當前 dept_id、可能與
-- 離職時不同」。Phase 1.7.2 加 audit 表、PUT employees 自動寫 log,離職檔案頁
-- 可回推離職時部門 / 職位 / 薪資、解掉 disclaimer。
--
-- audit 白名單(影響審核 / 法律 / 薪資):
--   name / dept_id / role / is_manager / base_salary / position / manager_id
--
-- 不 audit:
--   avatar / phone / address / id_number / bank_account / 等敏感但不影響稽核欄位
--   employees POST(新員工不 audit、log 從 update 起算)
--
-- 三段式:① VERIFY → ② CREATE TABLE + INDEX → ③ 不 backfill

-- ═══ ① VERIFY(prod 跑前確認表不存在)═══
SELECT table_name FROM information_schema.tables
 WHERE table_schema = 'public' AND table_name = 'employee_change_logs';

-- ═══ ② CREATE TABLE + INDEX ═══
BEGIN;
CREATE TABLE IF NOT EXISTS employee_change_logs (
  id            BIGSERIAL PRIMARY KEY,
  employee_id   TEXT NOT NULL REFERENCES employees(id),
  changed_field TEXT NOT NULL CHECK (changed_field IN (
    'name', 'dept_id', 'role', 'is_manager',
    'base_salary', 'position', 'manager_id'
  )),
  before_value  TEXT,
  after_value   TEXT,
  changed_by    TEXT REFERENCES employees(id),
  changed_at    TIMESTAMPTZ DEFAULT NOW()
);

-- 主要查詢:某員工的變更歷史(時間倒序)
CREATE INDEX IF NOT EXISTS idx_employee_change_logs_employee
  ON employee_change_logs(employee_id, changed_at DESC);

-- 全公司時間軸查(較少用、admin debug 用)
CREATE INDEX IF NOT EXISTS idx_employee_change_logs_time
  ON employee_change_logs(changed_at DESC);
COMMIT;

-- ═══ ③ 不 backfill ═══
-- Phase 1.7.2 起算、歷史變更無資料可回推。
-- 離職員工檔案頁回推時:有 log → audit 值;無 log → fallback 當前 dept(顯示「無變更紀錄、推估為當前部門」)。

-- ═══ ④ PostgREST schema cache reload ═══
NOTIFY pgrst, 'reload schema';
