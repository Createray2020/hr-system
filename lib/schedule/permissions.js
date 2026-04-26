// lib/schedule/permissions.js — 排班編輯權限判定（純函式）
//
// 對應設計文件：docs/attendance-system-design-v1.md §4.2.1 / §9.3 / §9.4
// 對應實作計畫：docs/attendance-system-implementation-plan-v1.md §5.3
//
// 兩個函式：
//   canEmployeeEditSchedule(period, employee_id, today) — 員工自助編輯權限
//   canManagerEditSchedule(period, manager, today)      — 主管編輯權限 + isLateChange 判定

/**
 * 員工只能在 status='draft' 且 employee_id 是自己時可改；
 * 月份開始後永遠不能改（即使 status 還是 draft，這種情況是員工沒按時送出）。
 *
 * @param {{ employee_id: string, status: string, period_start: string }} period
 * @param {string} employee_id
 * @param {string} today  'YYYY-MM-DD'
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function canEmployeeEditSchedule(period, employee_id, today) {
  if (!period) return { ok: false, reason: 'NO_PERIOD' };
  if (!employee_id) return { ok: false, reason: 'NO_EMPLOYEE_ID' };
  if (period.employee_id !== employee_id) return { ok: false, reason: 'NOT_OWN_PERIOD' };
  if (period.status !== 'draft') return { ok: false, reason: 'NOT_DRAFT' };
  if (period.period_start && String(today) >= period.period_start) {
    return { ok: false, reason: 'PERIOD_STARTED' };
  }
  return { ok: true };
}

/**
 * 主管任何時候都可改（包含 locked），但需要是該員工的主管或 HR。
 *
 * isLateChange = true 代表「today 在 period 範圍內」，呼叫端應據此設定
 * change_type='late_change' 並觸發即時推播。不限 status='locked'：approved
 * 但月份已開始（cron 還沒跑到 locked）的情境，主管當天改實務上仍算「工作日當天」。
 *
 * 注意：本函式以 period 級別判定 isLateChange。若呼叫端要更精準（例如「today 是
 * 該筆 schedule 的 work_date 才算 late」），可在 API handler 層另做檢查。
 *
 * @param {{ employee_id: string, status: string, period_start: string, period_end: string }} period
 * @param {{ id: string, role: string, is_manager: boolean, manages_employee_id?: string }} manager
 * @param {string} today  'YYYY-MM-DD'
 * @returns {{ ok: boolean, isLateChange: boolean, reason?: string }}
 */
export function canManagerEditSchedule(period, manager, today) {
  if (!period)  return { ok: false, isLateChange: false, reason: 'NO_PERIOD' };
  if (!manager) return { ok: false, isLateChange: false, reason: 'NO_MANAGER' };

  const isHR = manager.role === 'hr' || manager.role === 'admin';
  const isDirectManager =
    manager.is_manager === true && manager.manages_employee_id === period.employee_id;

  if (!isHR && !isDirectManager) {
    return { ok: false, isLateChange: false, reason: 'NOT_MANAGER_OR_HR' };
  }

  const t = String(today);
  // isLateChange 條件：today 在 period 範圍內（不限 status）
  // 因為 approved + 月份已開始（cron 還沒鎖到 locked）主管當天改，實務上仍算「工作日當天」
  const inPeriodRange =
    !!period.period_start && !!period.period_end &&
    t >= period.period_start && t <= period.period_end;

  return { ok: true, isLateChange: !!inPeriodRange };
}
