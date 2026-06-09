-- 20260610_salary_grade_audit_and_change_logs.sql
-- Phase 1 步驟 1A(職等級距管理頁的 DB 配套):
--   (1) salary_grade 補 updated_at / updated_by 兩欄(原 schema 沒有 audit 欄、PATCH 寫不進去)
--   (2) 新增 salary_grade_change_logs audit table(對齊 leave_type_change_logs / schedule_change_logs 慣例)
--
-- 背景:
--   salary_grade 表(supabase_migrations/2026_05_10_payroll_baseline.sql:188-209)只有 id / grade /
--   grade_level / grade_name / base_salary / attendance_bonus / grade_allowance / can_be_manager /
--   manager_allowance / monthly_total + (2026_06_02 後)hourly_rate,**沒有 updated_at / updated_by**。
--   Phase 1 步驟 1A 開放 HR 後台編輯後,需要 audit 欄位記錄誰在何時動了哪個欄位。
--
--   salary_grade_change_logs 結構對齊 leave_type_change_logs(20260610 步驟 1B 那批):每次 PATCH
--   實際變動的欄位寫一筆、同次請求改多欄寫多筆。額外保留 grade / grade_level snapshot 給未來
--   join-less 查詢方便(salary_grade 不太會被刪除,但保留 snapshot 多一層保險)。
--
-- 本 migration 不做的事:
--   - 不重算既有 monthly_total(由 PATCH endpoint 在實際異動時算回去)
--   - 不對接 calculator(這頁是參考值、不影響員工實發)
--   - 不新增 / 不刪除任何 grade × grade_level 列(本 phase 只允許編輯既有列)
--
-- 對應檔案:
--   api/salary-grades/index.js  - GET 全列
--   api/salary-grades/[id].js   - PATCH 單筆 + 自動重算 monthly_total + 寫 change_logs
--   public/salary-grades-admin.html - HR 管理頁

BEGIN;

-- (1) salary_grade audit 欄
ALTER TABLE salary_grade
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS updated_by TEXT REFERENCES employees(id);

COMMENT ON COLUMN salary_grade.updated_at IS '最後一次 PATCH 時間;Phase 1 步驟 1A 開放編輯後寫入。';
COMMENT ON COLUMN salary_grade.updated_by IS '最後一次 PATCH 操作者;NULL = 系統 / migration / 從未編輯過。';

-- (2) audit log table
CREATE TABLE IF NOT EXISTS salary_grade_change_logs (
  id               BIGSERIAL PRIMARY KEY,
  salary_grade_id  INTEGER NOT NULL REFERENCES salary_grade(id),
  grade            TEXT NOT NULL,         -- snapshot(便於 join-less 查歷史)
  grade_level      INTEGER NOT NULL,      -- snapshot
  changed_field    TEXT NOT NULL,
  before_value     TEXT,                  -- 一律轉字串存(null / boolean / 數字皆轉)
  after_value      TEXT,
  changed_by       TEXT NOT NULL REFERENCES employees(id),
  changed_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_salary_grade_change_logs_grade_time
  ON salary_grade_change_logs(salary_grade_id, changed_at DESC);

CREATE INDEX IF NOT EXISTS idx_salary_grade_change_logs_actor_time
  ON salary_grade_change_logs(changed_by, changed_at DESC);

COMMENT ON TABLE salary_grade_change_logs IS
  '職等級距異動 audit log。每次 PATCH /api/salary-grades/:id 任一可編輯欄位變動寫一筆(同次請求改多欄寫多筆)。對齊 leave_type_change_logs / schedule_change_logs 慣例。';

COMMIT;

-- Verify(跑完查一眼):
-- \d salary_grade
-- \d salary_grade_change_logs
-- SELECT id, grade, grade_level, grade_name, base_salary, monthly_total, updated_at, updated_by
--   FROM salary_grade ORDER BY grade, grade_level;
