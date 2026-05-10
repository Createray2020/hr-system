-- 驗證 2.7.9 Part B: FK 改 ON DELETE SET NULL 已生效
--
-- 跑完 migrations/2026_05_10_fk_on_delete_set_null.sql 之後跑此 SQL、
-- 兩條 FK 的 confdeltype 都應該是 'n' (= NO ACTION 改成 SET NULL 後 PG 內部記法)。
-- 若還是 'a' (NO ACTION 預設) 表示 migration 沒生效。

SELECT
  c.conname                 AS constraint_name,
  t.relname                 AS table_name,
  rt.relname                AS referenced_table,
  CASE c.confdeltype
    WHEN 'a' THEN 'NO ACTION'
    WHEN 'r' THEN 'RESTRICT'
    WHEN 'c' THEN 'CASCADE'
    WHEN 'n' THEN 'SET NULL'
    WHEN 'd' THEN 'SET DEFAULT'
  END                        AS on_delete_action
FROM pg_constraint c
JOIN pg_class t  ON c.conrelid  = t.oid
JOIN pg_class rt ON c.confrelid = rt.oid
WHERE c.conname IN (
  'fk_overtime_requests_salary',
  'fk_penalty_records_salary'
);

-- expect: 2 rows、on_delete_action 都是 'SET NULL'
