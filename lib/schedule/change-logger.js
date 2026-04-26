// lib/schedule/change-logger.js — schedule_change_logs 寫入（純函式 + repo 介面）
//
// 對應設計文件：docs/attendance-system-design-v1.md §4.2.3
// 對應實作計畫：docs/attendance-system-implementation-plan-v1.md §5.6

const CHANGE_TYPES = Object.freeze([
  'employee_draft',
  'employee_submit',
  'manager_adjust',
  'manager_approve',
  'system_lock',
  'late_change',
]);

/**
 * Repo 介面契約（呼叫方需提供）：
 *   insertScheduleChangeLog(row): Promise<{ id: number, ... }>
 *
 * row 結構直接對應 schedule_change_logs 欄位。
 */

/**
 * 寫入一筆 schedule_change_log。
 *
 * isLateChange=true 時 notification_sent 設為 false（讓後續推播 / cron 可掃）；
 * 其他情況 notification_sent=true（partial index 不會掃到，無實際影響）。
 *
 * 注意：呼叫端決定 change_type；本函式不會自動把 manager_adjust 升級為 late_change。
 *      若主管當天改要走推播路徑，呼叫端應傳 change_type='late_change' + isLateChange=true。
 */
export async function logScheduleChange(repo, {
  schedule_id,
  employee_id,
  change_type,
  changed_by,
  before_data,
  after_data,
  reason,
  isLateChange,
}) {
  if (!repo || typeof repo.insertScheduleChangeLog !== 'function') {
    throw new Error('repo.insertScheduleChangeLog is required');
  }
  if (!CHANGE_TYPES.includes(change_type)) {
    throw new Error(`invalid change_type: ${change_type}`);
  }
  if (!employee_id) throw new Error('employee_id required');
  if (!changed_by)  throw new Error('changed_by required');

  const row = {
    schedule_id: schedule_id || null,
    employee_id,
    change_type,
    changed_by,
    before_data: before_data ?? null,
    after_data:  after_data  ?? null,
    reason: reason || null,
    notification_sent: !isLateChange,
  };
  return await repo.insertScheduleChangeLog(row);
}

export { CHANGE_TYPES };
