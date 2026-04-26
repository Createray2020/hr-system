// lib/schedule/lock-sweep.js — cron：自動鎖定到期排班週期
//
// 對應設計文件：docs/attendance-system-design-v1.md §6.4 / §9
// 對應實作計畫：docs/attendance-system-implementation-plan-v1.md §5.5
//
// cron schedule：每天 00:30 跑一次（透過 api/cron-schedule-lock.js）

/**
 * Repo 介面契約：
 *   findApprovedPeriodsToLock(today): Promise<Array<{ id, employee_id, period_start, ... }>>
 *     找 status='approved' 且 period_start <= today 的週期
 *   lockPeriod(periodId, today): Promise<{ ok: boolean }>
 *     更新 status='locked' + locked_at = now
 *   logChange(row): Promise<*>
 *     寫一筆 schedule_change_logs（change_type='system_lock'）
 */

export async function runLockSweep(repo, today) {
  if (!repo) throw new Error('repo is required');
  if (typeof repo.findApprovedPeriodsToLock !== 'function') {
    throw new Error('repo.findApprovedPeriodsToLock is required');
  }
  if (typeof repo.lockPeriod !== 'function') {
    throw new Error('repo.lockPeriod is required');
  }
  if (typeof repo.logChange !== 'function') {
    throw new Error('repo.logChange is required');
  }
  if (!today) throw new Error('today is required');

  const periods = await repo.findApprovedPeriodsToLock(today);
  let lockedCount = 0;
  for (const p of (periods || [])) {
    const r = await repo.lockPeriod(p.id, today);
    if (!r || !r.ok) continue;
    lockedCount += 1;
    await repo.logChange({
      schedule_id: null,
      employee_id: p.employee_id,
      change_type: 'system_lock',
      changed_by: p.employee_id, // schema 要求 changed_by NOT NULL FK employees；system 用該員工本人佔位
      before_data: { status: 'approved', period_id: p.id },
      after_data:  { status: 'locked',   period_id: p.id },
      reason: `auto-lock on ${today}`,
      notification_sent: true,
    });
  }
  return { locked_count: lockedCount };
}
