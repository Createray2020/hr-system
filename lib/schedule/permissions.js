// lib/schedule/permissions.js — 排班編輯權限判定（純函式）
//
// 對應設計文件：docs/attendance-system-design-v1.md §4.2.1 / §9.3 / §9.4
// 對應實作計畫：docs/attendance-system-implementation-plan-v1.md §5.3
//
// 兩個函式：
//   canEmployeeEditSchedule(period, employee_id, today) — 員工自助編輯權限
//   canManagerEditSchedule(period, manager, today)      — 主管編輯權限 + isLateChange 判定

import { isBackofficeRole } from '../roles.js';

/**
 * 員工只能在 status='draft' 且 employee_id 是自己時可改；
 * 月份開始後永遠不能改（即使 status 還是 draft，這種情況是員工沒按時送出）。
 *
 * @param {{ employee_id: string, status: string, period_start: string, wish_deadline?: string }} period
 * @param {string} employee_id
 * @param {string} today  'YYYY-MM-DD'
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function canEmployeeEditSchedule(period, employee_id, today) {
  if (!period) return { ok: false, reason: 'NO_PERIOD' };
  if (!employee_id) return { ok: false, reason: 'NO_EMPLOYEE_ID' };
  if (period.employee_id !== employee_id) return { ok: false, reason: 'NOT_OWN_PERIOD' };
  if (period.status !== 'draft') return { ok: false, reason: 'NOT_DRAFT' };
  // C6:員工 wish 截止日已過 → 擋 (NULL 不擋、向後相容舊 period)
  if (period.wish_deadline && String(today) > String(period.wish_deadline)) {
    return { ok: false, reason: 'WISH_DEADLINE_PASSED' };
  }
  if (period.period_start && String(today) >= period.period_start) {
    return { ok: false, reason: 'PERIOD_STARTED' };
  }
  return { ok: true };
}

/**
 * 主管在 published 之前任何時候都可改、published 之後 work_date >= 明天才可改、HR/CEO/chairman 不限。
 *
 * isLateChange = true 代表「today 在 period 範圍內」，呼叫端應據此設定
 * change_type='late_change' 並觸發即時推播。不限 status='locked'：approved
 * 但月份已開始（cron 還沒跑到 locked）的情境，主管當天改實務上仍算「工作日當天」。
 *
 * 注意：本函式以 period 級別判定 isLateChange。若呼叫端要更精準（例如「today 是
 * 該筆 schedule 的 work_date 才算 late」），可在 API handler 層另做檢查。
 *
 * @param {{ employee_id: string, status: string, period_start: string, period_end: string }} period
 * @param {{ id: string, role: string, is_manager: boolean, in_same_dept?: boolean }} manager
 * @param {string} today  'YYYY-MM-DD'
 * @param {string} [workDate]  'YYYY-MM-DD'  目標 schedule 的 work_date（C5：published 後檢查）
 * @returns {{ ok: boolean, isLateChange: boolean, reason?: string }}
 */
export function canManagerEditSchedule(period, manager, today, workDate) {
  if (!period)  return { ok: false, isLateChange: false, reason: 'NO_PERIOD' };
  if (!manager) return { ok: false, isLateChange: false, reason: 'NO_MANAGER' };

  const isHR = isBackofficeRole(manager);
  const isInSameDept =
    manager.is_manager === true && manager.in_same_dept === true;

  if (!isHR && !isInSameDept) {
    return { ok: false, isLateChange: false, reason: 'NOT_MANAGER_OR_HR' };
  }

  // C5：published 之後主管只能改未來、HR/CEO/chairman 不受限
  // 'published' 為 v2.5 規格用詞、目前 schema 仍是 approved/locked、三者都涵蓋
  const isPublished =
    period.status === 'published' ||
    period.status === 'approved' ||
    period.status === 'locked';
  if (!isHR && isPublished && workDate && String(workDate) <= String(today)) {
    return { ok: false, isLateChange: false, reason: 'MANAGER_LATE_DENIED' };
  }

  const t = String(today);
  // isLateChange 條件：today 在 period 範圍內（不限 status）
  // 因為 approved + 月份已開始（cron 還沒鎖到 locked）主管當天改，實務上仍算「工作日當天」
  const inPeriodRange =
    !!period.period_start && !!period.period_end &&
    t >= period.period_start && t <= period.period_end;

  return { ok: true, isLateChange: !!inPeriodRange };
}

/**
 * G1:員工自助 shift 限制 — 員工 isSelf 時、只能送「希望休假」(ST003 + note='__OFF__')
 * 或 null/空(清除/留空 cell)。送 ST001/ST002/其他 shift_type → 拒絕。
 * 主管/HR 代操作(isSelf=false)由呼叫端跳過此檢查。
 *
 * @param {{ shift_type_id?: string|null, note?: string }} body  req.body
 * @returns {{ ok: true } | { ok: false, reason: 'EMPLOYEE_SHIFT_RESTRICTED' }}
 */
export function checkEmployeeShiftRestricted(body) {
  const stid = body?.shift_type_id;
  // null / undefined / 空字串 → 清除或不動,合法
  if (!stid) return { ok: true };
  // ST003 + note='__OFF__' → 休假,唯一合法 shift_type
  if (stid === 'ST003' && body.note === '__OFF__') return { ok: true };
  return { ok: false, reason: 'EMPLOYEE_SHIFT_RESTRICTED' };
}
