// lib/overtime/comp-conversion.js — 加班通過 → 補休餘額轉換(純函式 + repo 注入式)
//
// 對應設計文件:docs/attendance-system-design-v1.md §4.4 / §4.3.4
// 對應實作計畫:docs/attendance-system-implementation-plan-v1.md §9.5
//
// 規則(規範 §9.5):
//   - 加班通過且 compensation_type='comp_leave' → 觸發
//   - earned_hours = overtimeRequest.hours(1:1 換算,**不依倍率**)
//   - earned_at = overtimeRequest.overtime_date 當日 00:00(台灣時區)
//   - expires_at = earned_at + 1 year(由 grantCompTime 自動算)
//   - 寫入後 update overtime_requests.comp_balance_id
//
// 不重發明輪子:直接 import grantCompTime from lib/comp-time/balance.js,Batch 6 已實作。

import { grantCompTime } from '../comp-time/balance.js';

/**
 * Repo 介面契約:
 *   (繼承 grantCompTime 需要的:insertCompBalance, insertBalanceLog)
 *   updateOvertimeCompBalanceId(request_id, comp_balance_id): updated row
 *
 * 呼叫端要保證 overtimeRequest 為 status='approved' 且 compensation_type='comp_leave'
 * 才呼叫此函式。本函式不重複檢查狀態(避免跟 state machine 重複邏輯)。
 */
export async function convertOvertimeToCompTime(repo, overtimeRequest) {
  if (!repo || typeof repo.updateOvertimeCompBalanceId !== 'function') {
    throw new Error('repo.updateOvertimeCompBalanceId is required');
  }
  if (!overtimeRequest) throw new Error('overtimeRequest required');
  if (overtimeRequest.compensation_type !== 'comp_leave') {
    throw new Error(`compensation_type must be 'comp_leave', got '${overtimeRequest.compensation_type}'`);
  }
  if (!overtimeRequest.id || !overtimeRequest.employee_id || !overtimeRequest.overtime_date) {
    throw new Error('overtimeRequest must have id / employee_id / overtime_date');
  }
  if (!Number.isFinite(+overtimeRequest.hours) || +overtimeRequest.hours <= 0) {
    throw new Error('overtimeRequest.hours must be positive');
  }

  const earnedAt = `${overtimeRequest.overtime_date}T00:00:00+08:00`;

  const created = await grantCompTime(repo, {
    employee_id: overtimeRequest.employee_id,
    hours:       Number(overtimeRequest.hours),
    source_overtime_request_id: overtimeRequest.id,
    earned_at:   earnedAt,
    changed_by:  overtimeRequest.manager_id ||
                 overtimeRequest.ceo_id ||
                 overtimeRequest.employee_id,
    // expires_at 不傳:grantCompTime 自動 earned_at + 1 year
  });

  if (!created || !created.id) {
    throw new Error('grantCompTime did not return a record with id');
  }

  await repo.updateOvertimeCompBalanceId(overtimeRequest.id, created.id);
  return created;
}
