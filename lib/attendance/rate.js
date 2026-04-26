// lib/attendance/rate.js — 實際出席率計算 stub(純函式 + repo 注入式)
//
// 對應設計文件:docs/attendance-system-design-v1.md §10
// 對應實作計畫:docs/attendance-system-implementation-plan-v1.md §10.4
//
// 本批為 stub:公式有但細節等績效模組對齊。
// 算法步驟(規範 §10.4):
//   1. 算當月應出勤工時(扣週末 + 國定假日)
//   2. 算當月實際出席工時(attendance.work_hours 加總)
//   3. 扣除遲到早退分鐘的工時
//   4. 不扣請假類型 affects_attendance_rate=false 的時段
// 回傳:{ rate, total_required, total_attended, deductions }
//
// TODO(績效模組):
//   - 應出勤工時定義:採「週日為休、週六為休、national_holiday 為休」抑或依排班定義?
//     本 stub 用「該月所有工作日(Mon-Fri)+ 扣 national_holiday」粗算,等績效模組對齊
//   - finalized_hours vs days 換算
//   - 不滿月在職員工(到職/離職)的 prorated 處理

const HOURS_PER_DAY = 8;

/**
 * Repo 介面契約:
 *   findAttendanceByEmployeeMonth({ employee_id, year, month }): Array<attendance>
 *   findHolidaysByMonth(year, month): Array<{ date, holiday_type }>
 *     用 date 範圍查當月 holidays
 *   findApprovedLeavesByEmployeeMonth({ employee_id, year, month }): Array<{
 *     hours, finalized_hours, days, affects_attendance_rate
 *   }>
 */

export async function calculateAttendanceRate(repo, { employee_id, year, month }) {
  requireRepo(repo, [
    'findAttendanceByEmployeeMonth',
    'findHolidaysByMonth',
    'findApprovedLeavesByEmployeeMonth',
  ]);
  if (!employee_id) throw new Error('employee_id required');
  if (!Number.isInteger(year))  throw new Error('year required');
  if (!Number.isInteger(month) || month < 1 || month > 12) throw new Error('month invalid');

  // 1. 應出勤工時:粗算 = 當月工作日(Mon-Fri) - national_holiday × 8 小時
  const holidays = await repo.findHolidaysByMonth(year, month);
  const holidayDates = new Set(
    (holidays || [])
      .filter(h => h.holiday_type === 'national')
      .map(h => String(h.date).slice(0, 10)),
  );
  const workdays = countWorkdaysInMonth(year, month, holidayDates);
  const totalRequiredHours = workdays * HOURS_PER_DAY;

  // 2. 實際出席工時(attendance.work_hours 加總)
  const attendances = await repo.findAttendanceByEmployeeMonth({ employee_id, year, month });
  let attendedHours = 0;
  let lateMinutes = 0;
  let earlyLeaveMinutes = 0;
  for (const a of (attendances || [])) {
    attendedHours += Number(a.work_hours) || 0;
    lateMinutes += Number(a.late_minutes) || 0;
    earlyLeaveMinutes += Number(a.early_leave_minutes) || 0;
  }

  // 3. 扣除遲到早退的工時(分鐘 / 60)
  const lateHours = lateMinutes / 60;
  const earlyHours = earlyLeaveMinutes / 60;
  const adjustedAttended = Math.max(0, attendedHours - lateHours - earlyHours);

  // 4. affects_attendance_rate=false 的請假時段不扣應出勤
  const leaves = await repo.findApprovedLeavesByEmployeeMonth({ employee_id, year, month });
  let exemptHours = 0;
  for (const lv of (leaves || [])) {
    if (lv.affects_attendance_rate === false) {
      const h = lv.finalized_hours != null
        ? Number(lv.finalized_hours)
        : (lv.hours != null ? Number(lv.hours) : (Number(lv.days) || 0) * HOURS_PER_DAY);
      exemptHours += h;
    }
  }
  const adjustedRequired = Math.max(0, totalRequiredHours - exemptHours);

  const rate = adjustedRequired > 0
    ? Math.min(1, Math.max(0, adjustedAttended / adjustedRequired))
    : 0;

  return {
    rate: round3(rate),
    total_required: round2(totalRequiredHours),
    total_attended: round2(attendedHours),
    deductions: {
      late_hours: round2(lateHours),
      early_leave_hours: round2(earlyHours),
      adjusted_attended: round2(adjustedAttended),
      exempt_hours_from_no_rate_leaves: round2(exemptHours),
      adjusted_required: round2(adjustedRequired),
      workdays,
      national_holidays_excluded: holidayDates.size,
    },
    note: 'stub:公式有但細節待績效模組對齊',
  };
}

// ─── helpers ─────────────────────────────────────────────────

function requireRepo(repo, methods) {
  if (!repo) throw new Error('repo required');
  for (const m of methods) {
    if (typeof repo[m] !== 'function') throw new Error(`repo.${m} is required`);
  }
}

/**
 * 算當月 Mon-Fri 工作日,扣掉 national holiday(用 UTC 比對日期字串避免時區誤差)。
 */
export function countWorkdaysInMonth(year, month, holidayDateSet = new Set()) {
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  let count = 0;
  for (let d = 1; d <= lastDay; d++) {
    const dt = new Date(Date.UTC(year, month - 1, d));
    const dow = dt.getUTCDay(); // 0=Sun, 6=Sat
    if (dow === 0 || dow === 6) continue;
    const ds = `${year}-${String(month).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    if (holidayDateSet.has(ds)) continue;
    count += 1;
  }
  return count;
}

function round2(n) { return Math.round(Number(n) * 100) / 100; }
function round3(n) { return Math.round(Number(n) * 1000) / 1000; }
