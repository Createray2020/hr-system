-- Phase 1.1: 多階審核 + 前置時間 + 證明 + override schema
-- 已於 2026-05-05 直接在 prod Supabase 執行、本檔留檔同步版控
-- 後續 Phase 1.2 lib 純函式、Phase 1.3 API 改造、Phase 1.4 frontend 將陸續使用這些欄位

BEGIN;

-- ═══ A. leave_types: 加前置時間 / 證明欄位 ═══
ALTER TABLE leave_types
  ADD COLUMN IF NOT EXISTS advance_hours    INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS advance_rule     TEXT    NOT NULL DEFAULT 'soft'
    CHECK (advance_rule IN ('hard','soft')),
  ADD COLUMN IF NOT EXISTS requires_proof   BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS proof_grace_days INTEGER NOT NULL DEFAULT 0;

-- ═══ B. backfill 既有 15 種假別 ═══
UPDATE leave_types SET advance_hours=72,  advance_rule='hard', requires_proof=false, proof_grace_days=0 WHERE code='annual';
UPDATE leave_types SET advance_hours=72,  advance_rule='hard', requires_proof=false, proof_grace_days=0 WHERE code='comp';
UPDATE leave_types SET advance_hours=24,  advance_rule='hard', requires_proof=false, proof_grace_days=0 WHERE code='personal';
UPDATE leave_types SET advance_hours=0,   advance_rule='soft', requires_proof=true,  proof_grace_days=5 WHERE code='sick';
UPDATE leave_types SET advance_hours=0,   advance_rule='soft', requires_proof=false, proof_grace_days=0 WHERE code='menstrual';
UPDATE leave_types SET advance_hours=0,   advance_rule='soft', requires_proof=false, proof_grace_days=0 WHERE code='family_care';
UPDATE leave_types SET advance_hours=168, advance_rule='hard', requires_proof=true,  proof_grace_days=0 WHERE code='marriage';
UPDATE leave_types SET advance_hours=0,   advance_rule='soft', requires_proof=true,  proof_grace_days=5 WHERE code='funeral';
UPDATE leave_types SET advance_hours=336, advance_rule='hard', requires_proof=true,  proof_grace_days=0 WHERE code='maternity';
UPDATE leave_types SET advance_hours=0,   advance_rule='soft', requires_proof=true,  proof_grace_days=0 WHERE code='work_injury';
UPDATE leave_types SET advance_hours=120, advance_rule='hard', requires_proof=true,  proof_grace_days=0 WHERE code='public';
UPDATE leave_types SET advance_hours=0,   advance_rule='soft', requires_proof=false, proof_grace_days=0 WHERE code='typhoon';
UPDATE leave_types SET advance_hours=24,  advance_rule='hard', requires_proof=false, proof_grace_days=0 WHERE code='voting';
UPDATE leave_types SET advance_hours=0,   advance_rule='soft', requires_proof=true,  proof_grace_days=5 WHERE code='hospital_unpaid';
UPDATE leave_types SET advance_hours=24,  advance_rule='hard', requires_proof=false, proof_grace_days=0 WHERE code='job_seeking';

-- ═══ C. INSERT 缺的 5 種假別（產檢 / 陪產 / 流產 / 安胎 / 育嬰）═══
INSERT INTO leave_types (
  code, name_zh, is_paid, pay_rate, has_balance,
  legal_max_days_per_year, is_active, display_order,
  advance_hours, advance_rule, requires_proof, proof_grace_days
) VALUES
  ('paternity_prenatal', '產檢假',       true,  1.00, false, 7,    true, 81, 24,  'hard', false, 0),
  ('paternity',          '陪產假',       true,  1.00, false, 7,    true, 82, 0,   'soft', true,  5),
  ('miscarriage',        '流產假',       true,  1.00, false, null, true, 83, 0,   'soft', true,  5),
  ('pregnancy_rest',     '安胎假',       true,  0.50, false, null, true, 84, 0,   'soft', true,  5),
  ('parental',           '育嬰留職停薪', false, 0.00, false, null, true, 85, 240, 'hard', true,  0)
ON CONFLICT (code) DO NOTHING;

-- ═══ D. leave_requests: 加多階審核 + 前置 / 證明 / override 欄位 ═══
ALTER TABLE leave_requests
  -- 多階審核（mgr → ceo → archived）
  ADD COLUMN IF NOT EXISTS mgr_reviewed_by    TEXT REFERENCES employees(id),
  ADD COLUMN IF NOT EXISTS mgr_reviewed_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS mgr_decision       TEXT
    CHECK (mgr_decision IS NULL OR mgr_decision IN ('approved','rejected')),
  ADD COLUMN IF NOT EXISTS mgr_reject_reason  TEXT,
  ADD COLUMN IF NOT EXISTS ceo_reviewed_by    TEXT REFERENCES employees(id),
  ADD COLUMN IF NOT EXISTS ceo_reviewed_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ceo_decision       TEXT
    CHECK (ceo_decision IS NULL OR ceo_decision IN ('approved','rejected')),
  ADD COLUMN IF NOT EXISTS ceo_reject_reason  TEXT,
  ADD COLUMN IF NOT EXISTS archived_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS archived_by        TEXT REFERENCES employees(id),
  -- 前置時間
  ADD COLUMN IF NOT EXISTS late_application   BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS late_reason        TEXT,
  -- 證明文件
  ADD COLUMN IF NOT EXISTS proof_url          TEXT,
  ADD COLUMN IF NOT EXISTS proof_due_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS proof_status       TEXT NOT NULL DEFAULT 'not_required'
    CHECK (proof_status IN ('not_required','required','submitted','expired','converted_to_personal')),
  -- Override
  ADD COLUMN IF NOT EXISTS override_by        TEXT REFERENCES employees(id),
  ADD COLUMN IF NOT EXISTS override_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS override_reason    TEXT;

-- ═══ E. 擴展 status enum CHECK（保留 'pending' 向後相容）═══
ALTER TABLE leave_requests DROP CONSTRAINT IF EXISTS leave_requests_status_check;
ALTER TABLE leave_requests
  ADD CONSTRAINT leave_requests_status_check
  CHECK (status IN (
    'pending',       -- 舊版單階；Phase 1.3 改 API 後 UPDATE 成 pending_mgr 並從 CHECK 拿掉
    'pending_mgr',   -- 新版：等主管審
    'pending_ceo',   -- 新版：主管已批、等執行長審
    'approved',      -- 執行長已批、待 HR 歸檔
    'archived',      -- HR 已歸檔（最終）
    'rejected',      -- 任一階拒絕（最終）
    'cancelled'      -- 員工撤回（最終）
  ));

COMMIT;

-- ═══ F. PostgREST schema cache reload ═══
NOTIFY pgrst, 'reload schema';
