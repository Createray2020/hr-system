// lib/attendance/bonus.js — 全勤獎金扣除比例計算(純函式 + repo 注入式)
//
// 對應設計文件:docs/attendance-system-design-v1.md §4.5 / §10
// 對應實作計畫:docs/attendance-system-implementation-plan-v1.md §10.3
//
// 規則(規範 §10.3):
//   - 比例規則從 attendance_penalty_records 讀(本函式只加總,不寫死「曠職一天扣 30%」)
//   - 三層加總:
//     a. 曠職天數 → 比例(從 attendance_penalty_records 中 trigger_type='absent' 的 records)
//     b. 影響全勤的請假類型(leave_types.affects_attendance_bonus=true)→ 比例
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
 *   getAbsentDayDeductionRate(): number
 *     全公司預設「曠職一天的扣除比例」(從 attendance_penalties 中 trigger_type='absent'
 *     且 penalty_type='deduct_attendance_bonus_pct' 的規則讀;沒設則 0)
 *
 * 注意:呼叫端要保證請假已 approved 才算入。
 */

const HOURS_PER_DAY = 8;

/**
 * @returns {{ deduction_rate, breakdown }}  deduction_rate 介於 0~1
 */
export async function calculateAttendanceBonusDeduction(repo, { employee_id, year, month }) {
  requireRepo(repo, [
    'findPenaltyRecordsByEmployeeMonth',
    'findApprovedAttendanceBonusLeaves',
    'findAbsentDaysByEmployeeMonth',
    'getAbsentDayDeductionRate',
  ]);
  if (!employee_id) throw new Error('employee_id required');
  if (!Number.isInteger(year))  throw new Error('year required');
  if (!Number.isInteger(month) || month < 1 || month > 12) throw new Error('month invalid');

  // a. 曠職天數扣除比例
  const absentDays = await repo.findAbsentDaysByEmployeeMonth({ employee_id, year, month });
  const perDayRate = await repo.getAbsentDayDeductionRate();
  const fromAbsence = (Number(absentDays) || 0) * (Number(perDayRate) || 0);

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
  const fromLeaves = leaveDays * (Number(perDayRate) || 0);

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
      absent_day_rate: Number(perDayRate) || 0,
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
