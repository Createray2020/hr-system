// lib/attendance/bonus.js — 全勤獎金扣除比例計算(純函式 + repo 注入式)
//
// 對應設計文件:docs/attendance-system-design-v1.md §4.5 / §10
// 對應實作計畫:docs/attendance-system-implementation-plan-v1.md §10.3
//
// 規則(規範 §10.3 + 2026/1/1 勞工請假規則 §9 比例原則):
//   - per_day_rate 動態 = 1 / 該月應出勤日(扣國定假日 / Mon-Fri 起算)
//   - 三層加總:
//     a. 曠職天數 × per_day_rate
//     b. 影響全勤的請假類型(leave_types.affects_attendance_bonus=true) × per_day_rate
//     c. attendance_penalty_records 中 penalty_type='deduct_attendance_bonus_pct' → 加總百分比
//   - 比例上限 1.0(扣到 0 為止)

/**
 * Repo 介面契約:
 *   findPenaltyRecordsByEmployeeMonth({ employee_id, year, month }): Array<row>
 *     status='pending' 或 'applied' 的 records(被 'waived' 的不算)
 *   findApprovedAttendanceBonusLeaves({ employee_id, year, month }): Array<{
 *     leave_type, hours, finalized_hours, days, affects_attendance_bonus
 *   }>
 *     回該員工該月已 approved 且 leave_types.affects_attendance_bonus=true 的請假
 *   findAbsentDaysByEmployeeMonth({ employee_id, year, month }): number
 *     從 attendance 表算當月 status='absent' 的 distinct 天數
 *   findHolidaysByMonth(year, month): Array<{ date, holiday_type }>
 *     當月 holidays(用 makeup_workday 以外的日期判定為非工作日)
 *
 * 注意:呼叫端要保證請假已 approved 才算入。
 */

import { countWorkdaysInMonth } from './rate.js';

const HOURS_PER_DAY = 8;

/**
 * @returns {{ deduction_rate, breakdown }}  deduction_rate 介於 0~1
 */
export async function calculateAttendanceBonusDeduction(repo, { employee_id, year, month }) {
  requireRepo(repo, [
    'findPenaltyRecordsByEmployeeMonth',
    'findApprovedAttendanceBonusLeaves',
    'findAbsentDaysByEmployeeMonth',
    'findHolidaysByMonth',
  ]);
  if (!employee_id) throw new Error('employee_id required');
  if (!Number.isInteger(year))  throw new Error('year required');
  if (!Number.isInteger(month) || month < 1 || month > 12) throw new Error('month invalid');

  // C 項：per_day_rate 動態 = 1/該月應出勤日(2026/1/1 勞工請假規則 §9 比例原則)
  const holidays = await repo.findHolidaysByMonth(year, month);
  const holidayDates = new Set(
    (holidays || [])
      .filter(h => h.holiday_type !== 'makeup_workday')
      .map(h => String(h.date).slice(0, 10)),
  );
  const workDays = countWorkdaysInMonth(year, month, holidayDates);
  const perDayRate = workDays > 0 ? (1 / workDays) : 0;

  // a. 曠職天數扣除比例
  const absentDays = await repo.findAbsentDaysByEmployeeMonth({ employee_id, year, month });
  const fromAbsence = (Number(absentDays) || 0) * perDayRate;

  // b. 影響全勤的請假類型(已 approved)→ 比例
  const leaves = await repo.findApprovedAttendanceBonusLeaves({ employee_id, year, month });
  let leaveDays = 0;
  for (const lv of (leaves || [])) {
    if (lv.affects_attendance_bonus !== true) continue;
    const days = lv.finalized_hours != null
      ? Number(lv.finalized_hours) / HOURS_PER_DAY
      : (lv.hours != null ? Number(lv.hours) / HOURS_PER_DAY : Number(lv.days) || 0);
    leaveDays += days;
  }
  // 同樣用「曠職一天的扣除比例」對應請假天數(規範:影響全勤的請假類型用同樣的比例規則)
  const fromLeaves = leaveDays * perDayRate;

  // c. attendance_penalty_records 中 penalty_type='deduct_attendance_bonus_pct' → 加總
  const penaltyRecords = await repo.findPenaltyRecordsByEmployeeMonth({ employee_id, year, month });
  let fromPenalty = 0;
  for (const rec of (penaltyRecords || [])) {
    if (rec.status === 'waived') continue;
    if (rec.penalty_type !== 'deduct_attendance_bonus_pct') continue;
    // penalty_amount 存的是「百分比」:可能是 30 (=30%) 或 0.3 (=30%) 兩種習慣
    // 採用較小數值假設:>1 視為百分比 100 進制(/100),<=1 視為小數
    const raw = Number(rec.penalty_amount) || 0;
    fromPenalty += raw > 1 ? raw / 100 : raw;
  }

  const total = fromAbsence + fromLeaves + fromPenalty;
  const deduction_rate = Math.min(1, Math.max(0, total));

  return {
    deduction_rate: round3(deduction_rate),
    breakdown: {
      absent_days: Number(absentDays) || 0,
      per_day_rate: round3(perDayRate),
      workdays_in_month: workDays,
      from_absence: round3(fromAbsence),
      leave_days: round3(leaveDays),
      from_leaves: round3(fromLeaves),
      from_penalty_records: round3(fromPenalty),
      total_before_cap: round3(total),
    },
  };
}

// ─── helpers ─────────────────────────────────────────────────

function requireRepo(repo, methods) {
  if (!repo) throw new Error('repo required');
  for (const m of methods) {
    if (typeof repo[m] !== 'function') throw new Error(`repo.${m} is required`);
  }
}

function round3(n) {
  return Math.round(Number(n) * 1000) / 1000;
}
