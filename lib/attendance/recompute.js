// lib/attendance/recompute.js — 給定 attendance row + schedule、算正確 status / late / early
//
// 純函式、不動 DB。給:
//   - api/attendance/index.js 人工補登:caller 沒給 status 時自動算
//   - scripts/recompute_attendance.mjs:backfill 修補既有錯誤 row
//   共用算法、跟 lib/attendance/clock.js::clockIn / clockOut 同一條 timezone-aware path。
//
// 規則:
//   - schedule 為 null:不算 late / early(都 0)、status 維持原值
//   - status='leave' / 'holiday' / 'absent':保留原值不動
//     (這些是 cron-absence-detection / 假單核准 / 假日寫的、不該被打卡覆寫)
//   - 否則依 calculateLateMinutes / calculateEarlyLeaveMinutes 結果:
//       late > 0 → 'late' (early_leave_minutes 仍寫進)
//       early > 0 → 'early_leave'
//       都 0 → 'normal'

import { calculateLateMinutes, calculateEarlyLeaveMinutes } from './clock.js';

const PRESERVED_STATUSES = new Set(['leave', 'holiday', 'absent']);

/**
 * @param {{ clock_in?: string|null, clock_out?: string|null, work_date: string, status?: string }} row
 * @param {{ start_time: string, end_time: string, crosses_midnight?: boolean }|null} schedule
 * @returns {{ late_minutes: number, early_leave_minutes: number, status: string }}
 */
export function recomputeAttendanceStatus(row, schedule) {
  const { clock_in, clock_out, work_date, status: existingStatus } = row;

  let lateMinutes = 0, earlyLeaveMinutes = 0;
  if (schedule && clock_in) {
    lateMinutes = calculateLateMinutes(clock_in, work_date, schedule.start_time);
  }
  if (schedule && clock_out) {
    earlyLeaveMinutes = calculateEarlyLeaveMinutes(
      clock_out, work_date, schedule.end_time, !!schedule.crosses_midnight,
    );
  }

  // 不覆寫 leave / holiday / absent — 但仍回傳重算的分鐘數(caller 可選擇要不要寫)
  if (PRESERVED_STATUSES.has(existingStatus)) {
    return { late_minutes: lateMinutes, early_leave_minutes: earlyLeaveMinutes, status: existingStatus };
  }

  let status;
  if (lateMinutes > 0) status = 'late';
  else if (earlyLeaveMinutes > 0) status = 'early_leave';
  else status = 'normal';

  return { late_minutes: lateMinutes, early_leave_minutes: earlyLeaveMinutes, status };
}
