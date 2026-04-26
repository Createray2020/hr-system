// lib/comp-time/expiry-warning.js — cron:補休失效預警(純函式 + repo 注入式)
//
// 對應設計文件:docs/attendance-system-design-v1.md §6.4
// 對應實作計畫:docs/attendance-system-implementation-plan-v1.md §8.5
//
// cron schedule:每天 02:00(透過 api/cron-comp-expiry-warning.js)
//
// 流程:
//   1. 讀 system_overtime_settings.comp_expiry_warning_days(預設 30)
//   2. 找 status='active' AND expires_at = today + warning_days 的 comp_time_balance
//   3. 對每筆觸發推播給該員工

/**
 * Repo 介面契約:
 *   getSystemOvertimeSettings(): { comp_expiry_warning_days, ... } | null
 *   findCompBalancesExpiringOn(date): Array<comp_time_balance>
 *     status='active' AND expires_at = date(精確日匹配,避免每天重複預警)
 *   notifyExpiryWarning({ employee_id, comp_id, expires_at, remaining_hours }): { ok }
 */

export async function runCompExpiryWarning(repo, today) {
  requireRepo(repo, [
    'getSystemOvertimeSettings',
    'findCompBalancesExpiringOn',
    'notifyExpiryWarning',
  ]);
  if (!today) throw new Error('today required');

  const settings = await repo.getSystemOvertimeSettings() || {};
  const days = Number.isInteger(settings.comp_expiry_warning_days)
    ? settings.comp_expiry_warning_days : 30;

  const target = addDays(today, days);
  const expiring = await repo.findCompBalancesExpiringOn(target);

  let warning_sent_count = 0;
  for (const r of (expiring || [])) {
    const remainingHours = Math.max(0, Number(r.earned_hours) - Number(r.used_hours));
    if (remainingHours <= 0) continue; // 已用完不預警
    const ok = await repo.notifyExpiryWarning({
      employee_id: r.employee_id,
      comp_id: r.id,
      expires_at: r.expires_at,
      remaining_hours: remainingHours,
    });
    if (ok && ok.ok) warning_sent_count += 1;
  }

  return { warning_sent_count, target_date: target, warning_days: days, today };
}

function requireRepo(repo, methods) {
  if (!repo) throw new Error('repo required');
  for (const m of methods) {
    if (typeof repo[m] !== 'function') throw new Error(`repo.${m} is required`);
  }
}

function addDays(date, n) {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
