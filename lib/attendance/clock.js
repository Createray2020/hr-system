// lib/attendance/clock.js — 打卡邏輯（純函式 + repo 注入式）
//
// 對應設計文件：docs/attendance-system-design-v1.md §4.2.4 / §5
// 對應實作計畫：docs/attendance-system-implementation-plan-v1.md §6.2
//
// 設計規則：
//   1. 沒 schedule 一律拒絕（throw NoScheduleError），不寬限
//   2. timestamp 由呼叫端（API handler）用 server time 提供，本檔不接受 client 傳
//   3. 多段班：找對應的 segment（時間落在哪段裡）；若不在任一段內，選最接近 start_time
//      的那段（避免員工早到 / 晚到打卡時被拒絕）
//   4. 國定假日 → is_holiday_work=true、holiday_id=該天 id

export class NoScheduleError extends Error {
  constructor(msg)        { super(msg); this.name = 'NoScheduleError'; }
}
export class AlreadyClockedInError extends Error {
  constructor(msg)        { super(msg); this.name = 'AlreadyClockedInError'; }
}
export class NoOpenAttendanceError extends Error {
  constructor(msg)        { super(msg); this.name = 'NoOpenAttendanceError'; }
}

/**
 * Repo 介面契約：
 *   findSchedulesForDate(employee_id, date): Array<{ id, segment_no, start_time, end_time, crosses_midnight, scheduled_work_minutes, period_id }>
 *     只回 schedule_periods.status IN ('approved','locked') 的 schedules
 *   findHolidayByDate(date): { id, holiday_type } | null
 *   findAttendanceByDateSegment(employee_id, date, segment_no): row | null
 *   findOpenAttendanceForEmployee(employee_id, candidate_dates: string[]): row | null
 *     找 candidate_dates 中有 clock_in 但無 clock_out 的最新一筆
 *   findScheduleById(id): schedule row | null
 *   upsertAttendance(row): inserted/updated row
 *   updateAttendance(id, patch): updated row
 *   nowIso(): string  — 可選，預設用 new Date().toISOString()
 */

/**
 * 員工打上班卡。
 *
 * @param {Object} repo
 * @param {{ employee_id: string, timestamp: string }} args  timestamp = ISO string
 * @returns 新建/更新的 attendance row
 * @throws NoScheduleError | AlreadyClockedInError
 */
export async function clockIn(repo, { employee_id, timestamp }) {
  requireRepo(repo, ['findSchedulesForDate', 'findHolidayByDate', 'findAttendanceByDateSegment', 'upsertAttendance']);
  if (!employee_id) throw new Error('employee_id required');
  if (!timestamp)   throw new Error('timestamp required');

  const date = timestamp.slice(0, 10);
  const schedules = await repo.findSchedulesForDate(employee_id, date);
  if (!schedules || schedules.length === 0) {
    throw new NoScheduleError(`no schedule for ${employee_id} on ${date}`);
  }

  const segment = pickSegmentForClockIn(schedules, timestamp);

  const existing = await repo.findAttendanceByDateSegment(employee_id, date, segment.segment_no);
  if (existing && existing.clock_in) {
    throw new AlreadyClockedInError(
      `already clocked in for ${employee_id} ${date} segment ${segment.segment_no}`,
    );
  }

  const lateMinutes = calculateLateMinutes(timestamp, date, segment.start_time);

  const holiday = await repo.findHolidayByDate(date);
  const isHolidayWork = !!holiday &&
    (holiday.holiday_type === 'national' ||
     holiday.holiday_type === 'company' ||
     holiday.holiday_type === 'flexible');

  const row = {
    id: existing?.id || `A_${employee_id}_${date.replace(/-/g, '')}_${segment.segment_no}`,
    employee_id,
    work_date: date,
    schedule_id: segment.id,
    segment_no: segment.segment_no,
    clock_in: timestamp,
    clock_out: existing?.clock_out || null,
    late_minutes: lateMinutes,
    early_leave_minutes: existing?.early_leave_minutes || 0,
    status: lateMinutes > 0 ? 'late' : 'normal',
    is_holiday_work: isHolidayWork,
    holiday_id: holiday?.id || null,
    is_anomaly: existing?.is_anomaly || false,
    anomaly_note: existing?.anomaly_note || null,
  };

  return await repo.upsertAttendance(row);
}

/**
 * 員工打下班卡。
 *
 * @param {Object} repo
 * @param {{ employee_id: string, timestamp: string }} args
 * @returns 更新後的 attendance row
 * @throws NoOpenAttendanceError
 */
export async function clockOut(repo, { employee_id, timestamp }) {
  requireRepo(repo, ['findOpenAttendanceForEmployee', 'findScheduleById', 'updateAttendance']);
  if (!employee_id) throw new Error('employee_id required');
  if (!timestamp)   throw new Error('timestamp required');

  // 跨日班：找今天 + 前一天的 open attendance
  const date = timestamp.slice(0, 10);
  const yesterday = subtractDay(date);
  const open = await repo.findOpenAttendanceForEmployee(employee_id, [date, yesterday]);
  if (!open) {
    throw new NoOpenAttendanceError(
      `no open attendance for ${employee_id} on ${date} or ${yesterday}`,
    );
  }

  const clockInIso = open.clock_in;
  const ms = new Date(timestamp) - new Date(clockInIso);
  const workHours = ms > 0 ? Math.round((ms / 3600000) * 100) / 100 : 0;

  const sched = open.schedule_id ? await repo.findScheduleById(open.schedule_id) : null;
  const scheduledMinutes = sched?.scheduled_work_minutes || 0;
  const scheduledHours = scheduledMinutes / 60;
  const overtimeHours = Math.max(0, Math.round((workHours - scheduledHours) * 100) / 100);

  const earlyLeaveMinutes = sched
    ? calculateEarlyLeaveMinutes(timestamp, open.work_date, sched.end_time, sched.crosses_midnight)
    : 0;

  let nextStatus = open.status;
  if (earlyLeaveMinutes > 0 && nextStatus === 'normal') nextStatus = 'early_leave';

  const patch = {
    clock_out: timestamp,
    work_hours: workHours,
    overtime_hours: overtimeHours,
    early_leave_minutes: earlyLeaveMinutes,
    status: nextStatus,
  };

  return await repo.updateAttendance(open.id, patch);
}

// ─── helpers (exported for tests) ────────────────────────────

/**
 * 多段班中,挑出 timestamp 對應的 segment。
 * 規則:
 *   1. 若 timestamp 落在某段 [start, end] 內 → 該段
 *   2. 否則挑「start_time 最接近 timestamp 但 ≤ timestamp」的段
 *   3. 否則(timestamp 早於所有段)→ 第一段(避免拒絕早到員工)
 */
export function pickSegmentForClockIn(schedules, timestamp) {
  const tMin = isoToMinutesOfDay(timestamp);

  for (const s of schedules) {
    const start = parseTimeToMin(s.start_time);
    let end = parseTimeToMin(s.end_time);
    if (start == null || end == null) continue;
    if (s.crosses_midnight || end < start) end += 24 * 60;
    const t = (s.crosses_midnight && tMin < start) ? tMin + 24 * 60 : tMin;
    if (t >= start && t <= end) return s;
  }

  // 沒落在任一段:挑「最接近 start_time 但 ≤ timestamp」的段
  const earlier = schedules
    .map(s => ({ s, start: parseTimeToMin(s.start_time) }))
    .filter(x => x.start != null && x.start <= tMin)
    .sort((a, b) => b.start - a.start);
  if (earlier.length) return earlier[0].s;

  // 全部段都晚於 timestamp → 第一段（早到打卡）
  return schedules[0];
}

export function calculateLateMinutes(timestamp, date, startTime) {
  const t = isoToMinutesOfDay(timestamp);
  const s = parseTimeToMin(startTime);
  if (s == null) return 0;
  // 注意：timestamp 是 UTC ISO,但 date+startTime 隱含本地時區。
  // 此函式假設呼叫端送的 timestamp 已轉成「該員工所在時區的 wall-clock」字面值
  // 否則跨時區計算會偏差。本系統 timezone 統一台灣時間,呼叫端負責對齊。
  const tDateStr = timestamp.slice(0, 10);
  if (tDateStr !== date) return 0;
  return Math.max(0, t - s);
}

export function calculateEarlyLeaveMinutes(timestamp, workDate, endTime, crossesMidnight) {
  const t = isoToMinutesOfDay(timestamp);
  const e = parseTimeToMin(endTime);
  if (e == null) return 0;

  const tDateStr = timestamp.slice(0, 10);
  if (crossesMidnight) {
    // 跨日班 end_time 是隔日的時間（如 06:00）
    if (tDateStr === workDate) {
      // 還在當天就打卡下班 → 一定算早退（24:00 之前)
      return Math.max(0, (24 * 60) + e - t);
    }
    // 隔日打卡：比 end_time 早多少
    return Math.max(0, e - t);
  } else {
    if (tDateStr !== workDate) return 0; // 隔日打卡不算這個 case 的早退
    return Math.max(0, e - t);
  }
}

// ─── internal ─────────────────────────────────────────────

function requireRepo(repo, methods) {
  if (!repo) throw new Error('repo required');
  for (const m of methods) {
    if (typeof repo[m] !== 'function') {
      throw new Error(`repo.${m} is required`);
    }
  }
}

function parseTimeToMin(t) {
  if (t == null || t === '') return null;
  const m = String(t).trim().match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (!m) return null;
  const h = parseInt(m[1]);
  const mn = parseInt(m[2]);
  if (h < 0 || h > 23 || mn < 0 || mn > 59) return null;
  return h * 60 + mn;
}

function isoToMinutesOfDay(iso) {
  // 接受 'YYYY-MM-DDTHH:MM:SS...' 或 'YYYY-MM-DD HH:MM:SS'
  const m = String(iso).match(/T?(\d{2}):(\d{2})/);
  if (!m) return 0;
  return parseInt(m[1]) * 60 + parseInt(m[2]);
}

function subtractDay(date) {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}
