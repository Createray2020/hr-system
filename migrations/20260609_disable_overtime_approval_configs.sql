-- 20260609_disable_overtime_approval_configs.sql
-- Batch 7 收尾:把 approval_flow_configs 上的加班類別 is_active 關掉。
--
-- 背景:
--   Batch 7「加班申請改走 /overtime.html → overtime_requests 表」commit 訊息號稱已移除,
--   但實際上只動了 public/approvals.html FORM_SCHEMA 註解(:435 // overtime / overtime_pay 已移除)。
--   approval_flow_configs 表上的兩列(overtime / overtime_pay)從未被 deactivate,
--   approvals.html「+ 新增申請」picker 仍會列出來、API POST /api/approvals action=create 也沒 whitelist,
--   結果是員工點下去後表單沒任何 input(FORM_SCHEMA 沒對應 entry 但 fallback 空陣列),
--   按送出就 INSERT 一筆空 form_data={} 的 'overtime' approval_requests row。
--   這筆既不會 cascade 到 overtime_requests,attendance is_anomaly 偵測撈不到,薪資 calculator 也撈不到。
--
--   2026-06-08 prod 真的累積出 5 筆這種 row(EMP_01251002 / EMP_01251003 各 2-3 筆、全空)。
--
-- 本 migration 做的事:
--   - UPDATE approval_flow_configs SET is_active=false WHERE request_type IN ('overtime','overtime_pay')
--   - 不刪 row、不動既有 approval_requests 歷史資料(那 5 筆殘留留給 HR 個案處理)
--
-- 配套守門(同 commit):
--   - api/approvals.js  加 OVERTIME_TYPES_BLOCKED 常數
--     · action=create 攔 request_type ∈ 黑名單 → 400「加班申請請改走 /overtime.html」
--     · GET ?type=list  filter 掉黑名單 request_type(歷史殘留也不顯示)
--   - public/approvals.html  renderTypeCategories() 前 filter 掉黑名單 request_type(picker 不出現)
--
-- 注意:prod DB 已手動執行過、本檔純記錄用,fresh setup / 重灌 / dry-run prod 時跑一次就 idempotent。
--
-- 對應 commit:fix(approvals): 加班類申請禁入 approval_requests(補完 Batch 7 漏掉的 DB config + server/前端守門)

BEGIN;

UPDATE approval_flow_configs
   SET is_active = false
 WHERE request_type IN ('overtime', 'overtime_pay');

COMMIT;

-- Verify(跑完看一眼、應該 is_active 全 false):
-- SELECT request_type, type_name, is_active
--   FROM approval_flow_configs
--  WHERE request_type IN ('overtime', 'overtime_pay');
