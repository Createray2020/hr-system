-- ==========================================
-- Migration: 2026_05_26_resignation_checklist.sql
-- Phase:     B7 MVP enhancement(離職檢核表)
-- 用途:     新建 3 張表:resignation_checklists / _items / _signatures
-- 類型:     CREATE TABLE + INDEX(無 row-level data migration)
-- ==========================================

-- ═══════════════════════════════════════════
-- ① VERIFY PRE — 跑前確認三表都不存在
-- 預期:
--   Q1.1 to_regclass → 三個 NULL
--   Q1.2 columns 0 row(三表都不存在)
--   Q1.3 indexes 0 row
-- ═══════════════════════════════════════════

-- Q1.1 三表都不存在
SELECT to_regclass('public.resignation_checklists'),
       to_regclass('public.resignation_checklist_items'),
       to_regclass('public.resignation_checklist_signatures');
-- 預期:三個 NULL

-- Q1.2 columns double-check
SELECT table_name, column_name
  FROM information_schema.columns
 WHERE table_schema = 'public'
   AND table_name LIKE 'resignation_checklist%';
-- 預期:0 row

-- Q1.3 index 0 row
SELECT indexname FROM pg_indexes
 WHERE schemaname = 'public' AND tablename LIKE 'resignation_checklist%';
-- 預期:0 row

-- Q1.4 RLS / policy 都還沒套
SELECT tablename, rowsecurity FROM pg_tables
 WHERE schemaname='public' AND tablename LIKE 'resignation_checklist%';
-- 預期:0 row

SELECT policyname FROM pg_policies
 WHERE schemaname='public' AND tablename LIKE 'resignation_checklist%';
-- 預期:0 row

-- Q1.5 helper functions 都存在(RLS policy 依賴、跑前確認、避免引用不存在 fn)
SELECT proname FROM pg_proc
 WHERE proname IN (
   'auth_employee_id', 'auth_employee_role', 'auth_is_manager',
   'auth_employee_dept_id', 'auth_role_in', 'auth_is_hr_admin',
   'auth_is_my_dept_member'
 ) ORDER BY proname;
-- 預期 7 row(若缺、見 docs/rls-and-auth-design-v1.md §3.2、需先 apply helper migration)


-- ═══════════════════════════════════════════
-- ② ALTER — 真正的 migration(從原檔複製)
-- ═══════════════════════════════════════════

BEGIN;

CREATE TABLE IF NOT EXISTS resignation_checklists (
  id                   TEXT PRIMARY KEY,
  employee_id          TEXT NOT NULL REFERENCES employees(id),
  approval_request_id  TEXT NOT NULL REFERENCES approval_requests(id),
  status               TEXT NOT NULL DEFAULT 'draft' CHECK (status IN (
                         'draft', 'in_progress', 'completed', 'locked'
                       )),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at         TIMESTAMPTZ,
  locked_at            TIMESTAMPTZ,
  locked_by            TEXT REFERENCES employees(id),
  UNIQUE (employee_id, approval_request_id)
);
CREATE INDEX IF NOT EXISTS idx_resignation_checklists_employee
  ON resignation_checklists(employee_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_resignation_checklists_request
  ON resignation_checklists(approval_request_id);

CREATE TABLE IF NOT EXISTS resignation_checklist_items (
  id                TEXT PRIMARY KEY,
  checklist_id      TEXT NOT NULL REFERENCES resignation_checklists(id) ON DELETE CASCADE,
  category          TEXT NOT NULL CHECK (category IN (
                      '1_hr_admin', '2_payroll', '3_system_access',
                      '4_schedule_attendance', '5_org_relation',
                      '6_physical_asset', '7_handover', '8_notification_audit'
                    )),
  category_label    TEXT NOT NULL,
  item_seq          INTEGER NOT NULL,
  item_name         TEXT NOT NULL,
  item_description  TEXT,
  regulation_basis  TEXT,
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
                      'pending', 'done', 'n_a'
                    )),
  completed_at      TIMESTAMPTZ,
  completed_by      TEXT REFERENCES employees(id),
  note              TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_resignation_checklist_items_checklist
  ON resignation_checklist_items(checklist_id, item_seq);

CREATE TABLE IF NOT EXISTS resignation_checklist_signatures (
  id                  TEXT PRIMARY KEY,
  checklist_id        TEXT NOT NULL REFERENCES resignation_checklists(id) ON DELETE CASCADE,
  signer_role         TEXT NOT NULL CHECK (signer_role IN ('hr', 'manager', 'employee')),
  signer_id           TEXT REFERENCES employees(id),
  signer_name         TEXT NOT NULL,
  signature_data_url  TEXT NOT NULL,
  signed_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_resignation_checklist_signatures_checklist
  ON resignation_checklist_signatures(checklist_id, signed_at DESC);

ALTER TABLE resignation_checklists ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS allow_all ON resignation_checklists;
CREATE POLICY resignation_checklists_select_self_or_hr
  ON resignation_checklists FOR SELECT
  USING (employee_id = auth_employee_id() OR auth_is_hr_admin());
CREATE POLICY resignation_checklists_insert_hr
  ON resignation_checklists FOR INSERT
  WITH CHECK (auth_role_in('hr', 'admin'));
CREATE POLICY resignation_checklists_update_hr
  ON resignation_checklists FOR UPDATE
  USING (auth_role_in('hr', 'admin'))
  WITH CHECK (auth_role_in('hr', 'admin'));

ALTER TABLE resignation_checklist_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS allow_all ON resignation_checklist_items;
CREATE POLICY resignation_checklist_items_select_hr
  ON resignation_checklist_items FOR SELECT
  USING (auth_is_hr_admin());
CREATE POLICY resignation_checklist_items_insert_hr
  ON resignation_checklist_items FOR INSERT
  WITH CHECK (auth_role_in('hr', 'admin'));
CREATE POLICY resignation_checklist_items_update_hr
  ON resignation_checklist_items FOR UPDATE
  USING (auth_role_in('hr', 'admin'))
  WITH CHECK (auth_role_in('hr', 'admin'));

ALTER TABLE resignation_checklist_signatures ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS allow_all ON resignation_checklist_signatures;
CREATE POLICY resignation_checklist_signatures_select_hr
  ON resignation_checklist_signatures FOR SELECT
  USING (auth_is_hr_admin());
CREATE POLICY resignation_checklist_signatures_insert_hr
  ON resignation_checklist_signatures FOR INSERT
  WITH CHECK (auth_role_in('hr', 'admin'));

COMMIT;

NOTIFY pgrst, 'reload schema';


-- ═══════════════════════════════════════════
-- ③ VERIFY POST — 跑後確認生效
-- 預期:
--   Q3.1 to_regclass → 三個 public.xxx
--   Q3.2 三表 columns 數 正確(母 10 / items 11 / sig 7)
--   Q3.3 CHECK constraint 數正確(母 status / items category + status / sig signer_role)
--   Q3.4 indexes 數正確
--   Q3.5 row count 0(無 seed、由 applyResignation 動態 bulk insert)
-- ═══════════════════════════════════════════

-- Q3.1 三表已建立
SELECT to_regclass('public.resignation_checklists'),
       to_regclass('public.resignation_checklist_items'),
       to_regclass('public.resignation_checklist_signatures');
-- 預期:三個 public.<name>

-- Q3.2 columns + types
SELECT table_name, column_name, data_type, is_nullable
  FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name LIKE 'resignation_checklist%'
 ORDER BY table_name, ordinal_position;
-- 預期:
--   resignation_checklists           10 row(id, employee_id, approval_request_id, status,
--                                            created_at, updated_at, completed_at,
--                                            locked_at, locked_by + UNIQUE 不算 col)
--   resignation_checklist_items      11 row
--   resignation_checklist_signatures  7 row

-- Q3.3 CHECK constraint 內容
SELECT conrelid::regclass AS table_name, conname, pg_get_constraintdef(oid)
  FROM pg_constraint
 WHERE conrelid::regclass::text LIKE 'resignation_checklist%'
   AND contype = 'c'
 ORDER BY conrelid::regclass::text, conname;
-- 預期:
--   resignation_checklists.status CHECK IN ('draft','in_progress','completed','locked')
--   resignation_checklist_items.category CHECK IN (8 個值)
--   resignation_checklist_items.status CHECK IN ('pending','done','n_a')
--   resignation_checklist_signatures.signer_role CHECK IN ('hr','manager','employee')

-- Q3.4 indexes
SELECT indexname, indexdef FROM pg_indexes
 WHERE schemaname = 'public' AND tablename LIKE 'resignation_checklist%'
 ORDER BY tablename, indexname;
-- 預期至少 7 row(3 PK + 4 自定 index)

-- Q3.5 row count(都應為 0、由 applyResignation runtime 寫入)
SELECT
  (SELECT COUNT(*) FROM resignation_checklists)            AS checklists,
  (SELECT COUNT(*) FROM resignation_checklist_items)       AS items,
  (SELECT COUNT(*) FROM resignation_checklist_signatures)  AS sigs;
-- 預期 (0, 0, 0)

-- Q3.6 RLS enabled
SELECT tablename, rowsecurity
  FROM pg_tables
 WHERE schemaname='public' AND tablename LIKE 'resignation_checklist%'
 ORDER BY tablename;
-- 預期三表 rowsecurity=true

-- Q3.7 policy 總清單(8 個)
SELECT tablename, policyname, cmd, qual, with_check
  FROM pg_policies
 WHERE schemaname='public' AND tablename LIKE 'resignation_checklist%'
 ORDER BY tablename, cmd, policyname;
-- 預期 8 row:
--   resignation_checklists           : insert_hr / select_self_or_hr / update_hr  (3)
--   resignation_checklist_items      : insert_hr / select_hr / update_hr           (3)
--   resignation_checklist_signatures : insert_hr / select_hr                       (2)


-- ═══════════════════════════════════════════
-- ④ POLICY 行為驗證(可選、Ray 切 connection role 跑驗)
-- 三個視角測試:HR / 一般員工 / 非授權 visitor
-- 跑前先 INSERT 一筆假資料(用 service_role bypass RLS),驗完 ROLLBACK
-- ═══════════════════════════════════════════

-- ── 跑前用 service_role(supabaseAdmin)寫一筆 dummy data ──
-- (在 Supabase SQL Editor 預設是 postgres role、bypass RLS、可直接 INSERT)
BEGIN;
INSERT INTO resignation_checklists (id, employee_id, approval_request_id, status)
VALUES ('RCL_TEST', 'EMP_TEST', 'APR_TEST', 'draft')
ON CONFLICT (id) DO NOTHING;

-- ── 視角 1:HR(role='hr')──
-- 在 Supabase 設「Set role」/ Authorization 切換成 HR 員工的 JWT 後跑:
-- SELECT * FROM resignation_checklists WHERE id='RCL_TEST';
-- 預期 1 row(看得到)

-- ── 視角 2:一般員工(role='employee'、且不是 EMP_TEST 本人)──
-- 切員工 JWT 後跑:
-- SELECT * FROM resignation_checklists WHERE id='RCL_TEST';
-- 預期 0 row(被 RLS 擋下)

-- ── 視角 3:該離職員工本人(employee_id='EMP_TEST'、若帳號還 active)──
-- 切該員工 JWT 後跑:
-- SELECT * FROM resignation_checklists WHERE id='RCL_TEST';
-- 預期 1 row(self-select OR HR pass)
-- 注意:離職員工 auth_employee_id() 因 WHERE status='active' filter 回 NULL → 自動 deny
-- (F9 真正運作需走 backend supabaseAdmin、不依賴 RLS)

-- ── 視角 4:一般員工試圖 INSERT ──
-- INSERT INTO resignation_checklists (id, employee_id, approval_request_id, status)
-- VALUES ('RCL_HACK', 'EMP_HACK', 'APR_HACK', 'draft');
-- 預期:permission denied(insert_hr policy WITH CHECK 擋)

-- 清掉 dummy data
ROLLBACK;
