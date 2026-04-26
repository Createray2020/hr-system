// lib/leave/types.js — 請假類型查詢輔助（純函式 + repo 注入式）
//
// 對應設計文件：docs/attendance-system-design-v1.md §4.3.1
// 對應實作計畫：docs/attendance-system-implementation-plan-v1.md §7

/**
 * Repo 介面契約：
 *   findLeaveType(code): Promise<{
 *     code, name_zh, is_paid, pay_rate,
 *     affects_attendance_bonus, affects_attendance_rate,
 *     has_balance, legal_max_days_per_year, is_active,
 *     display_order, description, legal_reference
 *   } | null>
 *   listActiveLeaveTypes(): Promise<Array<{...}>>
 */

export async function getLeaveType(repo, code) {
  if (!repo || typeof repo.findLeaveType !== 'function') {
    throw new Error('repo.findLeaveType is required');
  }
  if (!code) return null;
  const t = await repo.findLeaveType(code);
  if (!t || t.is_active === false) return null;
  return t;
}

export async function listLeaveTypes(repo) {
  if (!repo || typeof repo.listActiveLeaveTypes !== 'function') {
    throw new Error('repo.listActiveLeaveTypes is required');
  }
  return await repo.listActiveLeaveTypes();
}

/**
 * 判斷請假類型是否需要扣餘額。
 * annual / comp 走餘額扣減；其他類型不扣（only legal_max_days_per_year 限制）。
 */
export function requiresBalance(leaveType) {
  return !!leaveType && leaveType.has_balance === true;
}

/**
 * 判斷該類型該日扣減去哪個 balance pool。
 * - 'annual'：扣 annual_leave_records
 * - 'comp'  ：扣 comp_time_balance（FIFO 取最舊未過期）
 * - null     ：不扣餘額
 */
export function getBalancePool(leaveType) {
  if (!leaveType || !leaveType.has_balance) return null;
  if (leaveType.code === 'annual') return 'annual';
  if (leaveType.code === 'comp')   return 'comp';
  return null;
}
