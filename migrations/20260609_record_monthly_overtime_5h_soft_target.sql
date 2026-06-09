-- 20260609_record_monthly_overtime_5h_soft_target.sql
-- B6 prod drift 收回 repo:補記 2026-05 月加班 5h 軟目標政策。
--
-- 背景(read-only 偵察 2026-06-09 完成):
--   2026-05-29 06:27:18+00 prod 端有人直接對 overtime_limits 動了兩步操作,沒走前端、
--   沒走 git migration,created_by=NULL:
--     (1) 把 supabase_attendance_v2_batch_a.sql:314-317 那筆「勞基法預設」公司 row 的
--         effective_to 從 NULL 切到 2026-04-30(該 row created_at=2026-04-27);
--     (2) 新增一筆「2026 內部新辦法」公司 row、effective_from=2026-05-01、effective_to=NULL,
--         daily=4 / weekly=12 / monthly=5(軟目標)/ monthly_hard_cap=46 / yearly=NULL。
--
--   政策意義:月 5h 是軟目標(monthly_limit_hours),超過 → is_over_limit=true、
--   over_limit_dimensions=['monthly'],由執行長特別核准、不擋寫入;46h 才是硬上限
--   (monthly_hard_cap_hours)。對齊「04.5 加班管理 v1.0 §六」內部文件。
--
--   discovery 過程詳見 2026-06-09 偵察:overtime_limits 兩筆 row 全表盤點 +
--   created_by/created_at audit 比對 + 確認無 per-employee override。
--
-- 本 migration 做的事:
--   (1) idempotent 截斷舊「勞基法預設」公司 row 的 effective_to 至 2026-04-30
--       (note pattern 匹配、避開 fresh build 用 BIGSERIAL id 差異)
--   (2) idempotent 新增「2026 內部新辦法」公司 row(WHERE NOT EXISTS、key=scope+effective_from)
--   ⇒ prod 已在此狀態、跑此 migration 為 NO-OP;fresh build/dev 跑會把預設政策切到新版。
--
-- 不做的事:
--   - 不指定 BIGSERIAL id(避免 fresh build 跟 prod 抓的 id 不一致);
--   - 不動任何 overtime_requests 既有資料;
--   - 不補 created_by(prod 那筆就是 NULL、保留)。
--
-- 對應 commit:chore(migrations): 補記 2026-05 月加班 5h 軟目標政策(B6 prod drift 收回 repo)

BEGIN;

-- (1) 截斷舊「勞基法預設」公司 row 至 2026-04-30
--     guard:只在 effective_to IS NULL 或 > '2026-04-30' 時動作;prod 已是 '2026-04-30' → NO-OP
UPDATE overtime_limits
   SET effective_to = DATE '2026-04-30',
       updated_at   = NOW()
 WHERE scope = 'company'
   AND note LIKE '%勞基法預設%'
   AND (effective_to IS NULL OR effective_to > DATE '2026-04-30');

-- (2) 新增「2026 內部新辦法」5h 軟目標公司 row
--     guard:WHERE NOT EXISTS 同 scope='company' 且 effective_from='2026-05-01' → 重跑 NO-OP
--     注意 chk_employee_scope CHECK 要 scope='company' 時 employee_id IS NULL,故明寫 NULL。
INSERT INTO overtime_limits (
  scope,
  employee_id,
  daily_limit_hours,
  weekly_limit_hours,
  monthly_limit_hours,
  monthly_hard_cap_hours,
  yearly_limit_hours,
  effective_from,
  effective_to,
  note
)
SELECT
  'company',
  NULL,
  4,
  12,
  5,
  46,
  NULL,
  DATE '2026-05-01',
  NULL,
  '2026 內部新辦法：月加班軟目標 5h（超過→is_over_limit→執行長特別核准）、月硬上限 46h（無工會）。對齊 04.5 加班管理 v1.0 §六'
WHERE NOT EXISTS (
  SELECT 1
    FROM overtime_limits
   WHERE scope = 'company'
     AND effective_from = DATE '2026-05-01'
);

COMMIT;

-- Verify(跑完看一眼;prod 應該維持 id=1 inactive、id=2 active 的兩筆;fresh build 則新政策 row 是第二筆):
--
-- SELECT id, scope, daily_limit_hours, weekly_limit_hours, monthly_limit_hours,
--        monthly_hard_cap_hours, effective_from, effective_to,
--        LEFT(note, 30) AS note_snip
--   FROM overtime_limits
--  WHERE scope = 'company'
--  ORDER BY effective_from;
--
-- 期望(prod 對齊):
--   id=1  4 / 12 / 46 / 54  effective_from=2026-04-27  effective_to=2026-04-30  note='勞基法預設…'
--   id=2  4 / 12 / 5  / 46  effective_from=2026-05-01  effective_to=NULL        note='2026 內部新辦法…'
