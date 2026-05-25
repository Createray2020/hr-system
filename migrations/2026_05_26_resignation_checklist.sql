-- 2026-05-26 Resignation Checklist MVP
--
-- 背景:B7 applyResignation cascade(commit 2a0acc7)只動 employees 3 欄位、
-- 不通知 HR 啟動後續事務(EMP_01251101 事故根因之一:5/14~5/24 attendance 7 筆
-- absent + 5/14~9/30 schedules 18 筆 confirmed 都因無 cascade 通知而無人清)。
--
-- MVP 目標:applyResignation 完成後自動建立離職檢核表 + 通知 HR、HR 在系統內
-- 完成所有離職事務追蹤(46 項預設項目分 8 大類、對齊台灣勞動法規 + 公司資產回收)。
--
-- 三張表:
--   1. resignation_checklists           — 母表(每 resignation request 一筆)
--   2. resignation_checklist_items      — 46 項預設(可由 applyResignation 自動 bulk insert)
--   3. resignation_checklist_signatures — MVP 預留 schema、API 暫不暴露(F2-F5 backlog 補)
--
-- 三段式:① VERIFY pre → ② CREATE TABLE + INDEX → ③ verify post

-- ═══ ① VERIFY(prod 跑前確認三表都不存在)═══
SELECT table_name FROM information_schema.tables
 WHERE table_schema = 'public'
   AND table_name IN (
     'resignation_checklists',
     'resignation_checklist_items',
     'resignation_checklist_signatures'
   );
-- 預期:0 row(三表都新建、目前不存在)


-- ═══ ② CREATE TABLE + INDEX ═══
BEGIN;

-- ── 1. resignation_checklists 母表 ────────────────────────────────
CREATE TABLE IF NOT EXISTS resignation_checklists (
  id                   TEXT PRIMARY KEY,
  employee_id          TEXT NOT NULL REFERENCES employees(id),
  approval_request_id  TEXT NOT NULL REFERENCES approval_requests(id),
  status               TEXT NOT NULL DEFAULT 'draft' CHECK (status IN (
                         'draft',         -- 剛建立、所有 item 都 pending
                         'in_progress',   -- 有 item done / n_a、仍有 pending
                         'completed',     -- 所有 item done / n_a
                         'locked'         -- F6 鎖定後(防匯出後竄改)
                       )),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at         TIMESTAMPTZ,
  locked_at            TIMESTAMPTZ,            -- MVP 不用、F6 補
  locked_by            TEXT REFERENCES employees(id),  -- MVP 不用、F6 補
  UNIQUE (employee_id, approval_request_id)    -- 同 resignation 不重複建檢核表
);

-- 主要查詢:某員工的離職檢核表(時間倒序、HR 點開員工檔案)
CREATE INDEX IF NOT EXISTS idx_resignation_checklists_employee
  ON resignation_checklists(employee_id, created_at DESC);

-- 由 approval_request 反查(approvals.html 點「離職檢核」按鈕用)
CREATE INDEX IF NOT EXISTS idx_resignation_checklists_request
  ON resignation_checklists(approval_request_id);


-- ── 2. resignation_checklist_items 項目表 ────────────────────────
CREATE TABLE IF NOT EXISTS resignation_checklist_items (
  id                TEXT PRIMARY KEY,
  checklist_id      TEXT NOT NULL REFERENCES resignation_checklists(id) ON DELETE CASCADE,
  category          TEXT NOT NULL CHECK (category IN (
                      '1_hr_admin',           -- HR 行政 (勞健保退保 / 文件 / 證明書)
                      '2_payroll',            -- 薪資結算 (pro-rata / 加班費 / 特休折現)
                      '3_system_access',      -- 系統權限撤銷 (auth / email / SaaS)
                      '4_schedule_attendance',-- 排班 / 出勤 / 假勤 (cleanup pending)
                      '5_org_relation',       -- 組織關係 (manager_id 轉移)
                      '6_physical_asset',     -- 實體資產回收 (電腦 / 門禁卡 / 制服)
                      '7_handover',           -- 工作交接 (清單 / 客戶 / 專案 / 面談)
                      '8_notification_audit'  -- 通知 / Audit
                    )),
  category_label    TEXT NOT NULL,            -- '1️⃣ HR 行政' 等(前端顯示用、含 emoji)
  item_seq          INTEGER NOT NULL,         -- 1-46 排序、同 category 內遞增
  item_name         TEXT NOT NULL,
  item_description  TEXT,
  regulation_basis  TEXT,                     -- '勞保條例§11' 等(顯示在標題下方淡色字)
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
                      'pending',  -- 未處理
                      'done',     -- 已完成
                      'n_a'       -- 不適用(例:無眷屬 → 健保眷屬轉出 n_a)
                    )),
  completed_at      TIMESTAMPTZ,
  completed_by      TEXT REFERENCES employees(id),
  note              TEXT NOT NULL DEFAULT ''
);

-- 主要查詢:某 checklist 的所有項目(item_seq 排序)
CREATE INDEX IF NOT EXISTS idx_resignation_checklist_items_checklist
  ON resignation_checklist_items(checklist_id, item_seq);


-- ── 3. resignation_checklist_signatures 簽名表(MVP 預留)─────────
-- API 暫不暴露、F2-F5 backlog 補。schema 先建好避免後續 migration 影響 prod。
CREATE TABLE IF NOT EXISTS resignation_checklist_signatures (
  id                  TEXT PRIMARY KEY,
  checklist_id        TEXT NOT NULL REFERENCES resignation_checklists(id) ON DELETE CASCADE,
  signer_role         TEXT NOT NULL CHECK (signer_role IN ('hr', 'manager', 'employee')),
  signer_id           TEXT REFERENCES employees(id),  -- nullable:離職員工本人簽時可能已不在 employees active 列
  signer_name         TEXT NOT NULL,
  signature_data_url  TEXT NOT NULL,                  -- base64 PNG
  signed_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_resignation_checklist_signatures_checklist
  ON resignation_checklist_signatures(checklist_id, signed_at DESC);


-- ── 4. RLS policy(對齊 docs/rls-and-auth-design-v1.md §5.1 / §5.10)──
-- 設計原則:
--   * Backend 走 supabaseAdmin(service_role)bypass RLS、policy 是 defense-in-depth
--   * 預設 deny 開頭、不留 allow_all、敏感資料(離職檢核)只開 HR
--   * 不寫 DELETE policy → 對齊 audit-permanent 設計、checklist / items / signatures 永久保留
--   * helper functions 與 §3.2 既有定義對齊:auth_is_hr_admin() / auth_employee_id()

-- resignation_checklists ──────────────────────────────────────
ALTER TABLE resignation_checklists ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS allow_all ON resignation_checklists;

-- SELECT:HR-like OR 自己那筆(F9「離職員工自己看自己檢核表」backlog 預留;
--   注意:auth_employee_id() helper 內含 WHERE status='active'、離職員工
--   auth_employee_id() 會回 NULL → self-select 自動 deny、F9 真正運作時需另走
--   backend supabaseAdmin + caller 比對、不依賴 RLS。)
CREATE POLICY resignation_checklists_select_self_or_hr
  ON resignation_checklists FOR SELECT
  USING (employee_id = auth_employee_id() OR auth_is_hr_admin());

-- INSERT:applyResignation cascade 走 supabaseAdmin、bypass RLS;policy 限 HR/admin
--   為 defense-in-depth(若未來 frontend 改 direct supabase-js 寫入會被擋)
CREATE POLICY resignation_checklists_insert_hr
  ON resignation_checklists FOR INSERT
  WITH CHECK (auth_role_in('hr', 'admin'));

-- UPDATE:HR/admin(HR 點完成 → status='completed' / locked_at)
CREATE POLICY resignation_checklists_update_hr
  ON resignation_checklists FOR UPDATE
  USING (auth_role_in('hr', 'admin'))
  WITH CHECK (auth_role_in('hr', 'admin'));

-- (無 DELETE policy = 自動 deny、audit 永久保留)


-- resignation_checklist_items ─────────────────────────────────
ALTER TABLE resignation_checklist_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS allow_all ON resignation_checklist_items;

-- SELECT:HR-only(項目細節 HR 敏感、不開員工直接 SELECT、F9 走 API 篩過)
CREATE POLICY resignation_checklist_items_select_hr
  ON resignation_checklist_items FOR SELECT
  USING (auth_is_hr_admin());

-- INSERT:HR/admin(applyResignation cascade bulk insert 走 supabaseAdmin、policy defense)
CREATE POLICY resignation_checklist_items_insert_hr
  ON resignation_checklist_items FOR INSERT
  WITH CHECK (auth_role_in('hr', 'admin'));

-- UPDATE:HR/admin(勾選狀態 / 寫備註)
CREATE POLICY resignation_checklist_items_update_hr
  ON resignation_checklist_items FOR UPDATE
  USING (auth_role_in('hr', 'admin'))
  WITH CHECK (auth_role_in('hr', 'admin'));

-- (無 DELETE policy = 自動 deny、用 status='n_a' 表「不適用」、不真刪)


-- resignation_checklist_signatures ────────────────────────────
ALTER TABLE resignation_checklist_signatures ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS allow_all ON resignation_checklist_signatures;

-- SELECT:HR/admin
CREATE POLICY resignation_checklist_signatures_select_hr
  ON resignation_checklist_signatures FOR SELECT
  USING (auth_is_hr_admin());

-- INSERT:HR/admin(F2-F4 簽名動作走 backend、走 supabaseAdmin、policy defense)
CREATE POLICY resignation_checklist_signatures_insert_hr
  ON resignation_checklist_signatures FOR INSERT
  WITH CHECK (auth_role_in('hr', 'admin'));

-- (無 UPDATE / DELETE policy = 自動 deny、對齊 F7 簽名版本控制:留 history 不覆寫)


COMMIT;


-- ═══ ③ VERIFY POST(跑後確認三表都建好)═══
SELECT table_name FROM information_schema.tables
 WHERE table_schema = 'public'
   AND table_name IN (
     'resignation_checklists',
     'resignation_checklist_items',
     'resignation_checklist_signatures'
   )
 ORDER BY table_name;
-- 預期 3 row

SELECT indexname FROM pg_indexes
 WHERE schemaname = 'public'
   AND tablename IN (
     'resignation_checklists',
     'resignation_checklist_items',
     'resignation_checklist_signatures'
   )
 ORDER BY tablename, indexname;
-- 預期至少 7 row(3 PK + 4 自定 index)

SELECT tablename, rowsecurity
  FROM pg_tables
 WHERE schemaname = 'public' AND tablename LIKE 'resignation_checklist%'
 ORDER BY tablename;
-- 預期三表 rowsecurity=true

SELECT tablename, policyname, cmd
  FROM pg_policies
 WHERE schemaname = 'public' AND tablename LIKE 'resignation_checklist%'
 ORDER BY tablename, cmd, policyname;
-- 預期 8 row:
--   resignation_checklists           : select_self_or_hr / insert_hr / update_hr  (3)
--   resignation_checklist_items      : select_hr / insert_hr / update_hr          (3)
--   resignation_checklist_signatures : select_hr / insert_hr                       (2)
-- 無 DELETE / UPDATE(signatures)policy = 自動 deny

-- 重新載 PostgREST schema cache(讓 supabase-js client 看到新表)
NOTIFY pgrst, 'reload schema';
