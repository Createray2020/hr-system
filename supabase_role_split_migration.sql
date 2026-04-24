-- ============================================================
--  role / is_manager 切分遷移
--  目的：把「權限身份（role）」與「是否為主管（is_manager）」拆開
--  role   最終合法值：employee / hr / ceo / chairman / admin
--  is_manager 獨立管理部門主管身份（影響薪資加給、組織圖顯示、後台存取）
--
--  ⚠ 本檔案「分段執行」，不要整檔一鍵貼上跑完。
--    依 Batch 3 → Safety net → Batch 4 順序，逐段執行並驗收。
-- ============================================================


-- ── Batch 3: 資料 UPDATE ─────────────────────────────────────
-- 不可逆步驟。執行前確認內容，prod 觀察期結束才可繼續 Batch 4。
-- 劉嘉昕 (EMP_01250501): role manager → employee；is_manager 維持 true
-- 盧嘉凌 (EMP_01251001): role manager → hr；      is_manager 維持 true

UPDATE employees SET role='employee' WHERE id='EMP_01250501';
UPDATE employees SET role='hr'       WHERE id='EMP_01251001';

-- 驗收：
-- SELECT id, name, role, is_manager FROM employees
-- WHERE id IN ('EMP_01250501','EMP_01251001');
-- 預期：EMP_01250501 → employee / true；EMP_01251001 → hr / true


-- ── Safety net（在 Batch 2 deploy 完成後執行即可，可早於 Batch 4）──
-- 把所有被 departments.manager_id 指到的人 is_manager 補成 true。
-- prod 現況預期為 no-op（0 row affected），保留作 Batch 2 上線的防呆。

UPDATE employees
SET is_manager = true
WHERE id IN (
  SELECT DISTINCT manager_id FROM departments WHERE manager_id IS NOT NULL
)
AND is_manager = false;

-- 診斷用（只查，不動）：列出「無 department 指派但 is_manager=true」的員工。
-- 這類人不會自動降級（會影響薪資加給），需人工判斷。
-- SELECT id, name, role, dept, is_manager FROM employees
--  WHERE is_manager = true
--    AND id NOT IN (SELECT manager_id FROM departments WHERE manager_id IS NOT NULL);


-- ── Batch 4: CHECK 收斂 ──────────────────────────────────────
-- 執行前 precheck（手動跑，確認只回 5 合法值才往下跑 ALTER）：
-- SELECT DISTINCT role FROM employees;
-- 預期只出現：employee / hr / ceo / chairman / admin

-- prod 現無 CHECK，DROP IF EXISTS 為 no-op
ALTER TABLE employees DROP CONSTRAINT IF EXISTS employees_role_check;

ALTER TABLE employees
  ADD CONSTRAINT employees_role_check
  CHECK (role IN ('employee','hr','ceo','chairman','admin'));

-- 驗收：
-- SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--  WHERE conrelid='employees'::regclass AND contype='c';
-- 應回 1 row，定義為 CHECK (role = ANY (ARRAY['employee'::text, 'hr'::text, 'ceo'::text, 'chairman'::text, 'admin'::text]))
