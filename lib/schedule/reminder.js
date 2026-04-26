// lib/schedule/reminder.js — cron：26 號排班送出提醒
//
// 對應設計文件：docs/attendance-system-design-v1.md §6.4
// 對應實作計畫：docs/attendance-system-implementation-plan-v1.md §5.7
//
// cron schedule：每月 26 日 09:00（透過 api/cron-schedule-reminder.js）
//
// 找出下個月 status='draft' 的 schedule_periods，對員工發站內通知。

/**
 * Repo 介面契約：
 *   findEmployeesNeedingReminder(year, month): Promise<Array<{ id, name, ... }>>
 *     找該年月下 status='draft' 的 schedule_periods 對應員工
 *   sendReminderNotification(employee, year, month): Promise<{ ok: boolean }>
 *     發站內通知（透過 lib/push.js）
 */

export async function runScheduleReminder(repo, today) {
  if (!repo) throw new Error('repo is required');
  if (typeof repo.findEmployeesNeedingReminder !== 'function') {
    throw new Error('repo.findEmployeesNeedingReminder is required');
  }
  if (typeof repo.sendReminderNotification !== 'function') {
    throw new Error('repo.sendReminderNotification is required');
  }
  if (!today) throw new Error('today is required');

  const { year, month } = nextMonth(today);

  const employees = await repo.findEmployeesNeedingReminder(year, month);
  let remindedCount = 0;
  for (const emp of (employees || [])) {
    const r = await repo.sendReminderNotification(emp, year, month);
    if (r && r.ok) remindedCount += 1;
  }
  return { reminded_count: remindedCount, year, month };
}

/**
 * 從 'YYYY-MM-DD' 取下個月的 { year, month }。
 * 用 UTC 處理避開 timezone DST。
 */
export function nextMonth(today) {
  const m = String(today).match(/^(\d{4})-(\d{2})-\d{2}$/);
  if (!m) throw new Error(`invalid today format: ${today}`);
  const y = parseInt(m[1]);
  const mm = parseInt(m[2]);
  if (mm === 12) return { year: y + 1, month: 1 };
  return { year: y, month: mm + 1 };
}
