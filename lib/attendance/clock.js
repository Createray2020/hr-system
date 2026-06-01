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
//
// GPS Phase A:可選 geo / locations 參數、寫 attendance row 的 GPS 欄位 + gps_flag。
//   geo === undefined → 不動 GPS 欄位(向後相容、既有 caller 不需改)
//   geo === null      → gps_flag='denied'、lat/lng 全 NULL
//   geo = { lat, lng, accuracy } → 走 validateGeofence(soft mode、不擋打卡)
//   locations 沒傳但 geo !== undefined → lib 自己 call repo.findActiveOfficeLocations()

import { validateGeofence } from './geo.js';

// 超時偵測門檻：work_hours > 此值且當日無 status='approved' 的 overtime_requests 即標 is_anomaly。
// 9.5h ≈ 扣 1h 午休後實際 >8.5h、視為超時。anomaly_note 用「超時：」前綴識別自動標記,
// 不蓋掉 HR 手動的 anomaly_note。可日後依政策調整。
export const OVERTIME_ANOMALY_HOURS = 9.5;
export const OVERTIME_ANOMALY_NOTE_PREFIX = '超時：';

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
 *     只回 schedule_periods.status IN ('published','locked','approved') 的 schedules
 *     （published = 主管已對員工公告；locked = 當月開始後鎖定；approved = 向後相容）
 *   findHolidayByDate(date): { id, holiday_type } | null
 *   findAttendanceByDateSegment(employee_id, date, segment_no): row | null
 *   findOpenAttendanceForEmployee(employee_id, candidate_dates: string[]): row | null
 *     找 candidate_dates 中有 clock_in 但無 clock_out 的最新一筆
 *   findScheduleById(id): schedule row | null
 *   findApprovedOvertimeRequestByDate(employee_id, date): row | null
 *     回 overtime_requests where status='approved' AND overtime_date=date 的任一筆(maybeSingle)
 *     給超時偵測用:有核准加班 → 不標 is_anomaly
 *   upsertAttendance(row): inserted/updated row
 *   updateAttendance(id, patch): updated row
 *   nowIso(): string  — 可選，預設用 new Date().toISOString()
 *
 *   findActiveOfficeLocations(): Array<{ id, lat, lng, radius_m }>  — 可選(GPS Phase A)
 *     只在 geo !== undefined 且 locations 沒傳時被呼叫;
 *     repo 沒實作此 method 時 fallback 視為空陣列(validateGeofence 回 'outside'、soft mode 仍 ok)
 */

/**
 * GPS Phase A:整合 geo / locations、回傳要 merge 進 attendance row 的 GPS 欄位 patch。
 * - geo === undefined → 回 {}(不動 GPS 欄位、向後相容)
 * - geo === null → gps_flag='denied'、其他 GPS 欄位 NULL
 * - geo = { lat, lng, accuracy } → 走 validateGeofence(soft mode)
 *
 * 欄位 prefix:'in' → clock_in_*、'out' → clock_out_*
 */
async function buildGpsPatch(repo, prefix, geo, locations) {
  if (geo === undefined) return {};
  // 撈 locations(若 caller 沒傳)
  let locs = locations;
  if (locs === undefined) {
    if (typeof repo.findActiveOfficeLocations === 'function') {
      locs = await repo.findActiveOfficeLocations();
    } else {
      locs = [];
    }
  }
  // denied(geo=null)→ flag='denied'、座標全 NULL
  if (geo === null) {
    return {
      [`clock_${prefix}_lat`]:         null,
      [`clock_${prefix}_lng`]:         null,
      [`clock_${prefix}_accuracy`]:    null,
      [`clock_${prefix}_distance_m`]:  null,
      [`clock_${prefix}_location_id`]: null,
      gps_flag: 'denied',
    };
  }
  // 一般 case:跑 validateGeofence
  const result = validateGeofence({
    lat: geo.lat ?? null,
    lng: geo.lng ?? null,
    accuracy: geo.accuracy ?? null,
    locations: locs,
    mode: 'soft',  // Phase A 不擋打卡
  });
  return {
    [`clock_${prefix}_lat`]:         geo.lat ?? null,
    [`clock_${prefix}_lng`]:         geo.lng ?? null,
    [`clock_${prefix}_accuracy`]:    geo.accuracy ?? null,
    [`clock_${prefix}_distance_m`]:  result.distance_m,
    [`clock_${prefix}_location_id`]: result.location_id,
    gps_flag: result.flag,
  };
}

/**
 * 員工打上班卡。
 *
 * @param {Object} repo
 * @param {{ employee_id: string, timestamp: string, geo?, locations? }} args
 *   geo:GPS Phase A optional({ lat, lng, accuracy } / null / undefined)
 *   locations:optional 公司據點陣列、沒傳時 lib 自己撈
 * @returns 新建/更新的 attendance row
 * @throws NoScheduleError | AlreadyClockedInError
 */
export async function clockIn(repo, { employee_id, timestamp, geo, locations }) {
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
  const earlyArrivalMinutes = calculateEarlyArrivalMinutes(timestamp, date, segment.start_time);

  const holiday = await repo.findHolidayByDate(date);
  const isHolidayWork = !!holiday &&
    (holiday.holiday_type === 'national' ||
     holiday.holiday_type === 'company' ||
     holiday.holiday_type === 'flexible');

  // GPS Phase A:geo 處理(soft mode、不擋打卡)
  const gpsPatch = await buildGpsPatch(repo, 'in', geo, locations);

  const row = {
    id: existing?.id || `A_${employee_id}_${date.replace(/-/g, '')}_${segment.segment_no}`,
    employee_id,
    work_date: date,
    schedule_id: segment.id,
    segment_no: segment.segment_no,
    clock_in: timestamp,
    clock_out: existing?.clock_out || null,
    late_minutes: lateMinutes,
    early_arrival_minutes: earlyArrivalMinutes,
    early_leave_minutes: existing?.early_leave_minutes || 0,
    status: lateMinutes > 0 ? 'late' : 'normal',
    is_holiday_work: isHolidayWork,
    holiday_id: holiday?.id || null,
    is_anomaly: existing?.is_anomaly || false,
    anomaly_note: existing?.anomaly_note || null,
    ...gpsPatch,
  };

  return await repo.upsertAttendance(row);
}

/**
 * 員工打下班卡。
 *
 * @param {Object} repo
 * @param {{ employee_id: string, timestamp: string, geo?, locations? }} args
 *   geo / locations 行為同 clockIn(GPS Phase A、寫 clock_out_*)
 * @returns 更新後的 attendance row
 * @throws NoOpenAttendanceError
 */
export async function clockOut(repo, { employee_id, timestamp, geo, locations }) {
  requireRepo(repo, ['findOpenAttendanceForEmployee', 'findScheduleById', 'updateAttendance', 'findApprovedOvertimeRequestByDate']);
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

  // GPS Phase A:geo 處理、gps_flag 覆寫(語意=最近一次打卡狀況)
  const gpsPatch = await buildGpsPatch(repo, 'out', geo, locations);

  const patch = {
    clock_out: timestamp,
    work_hours: workHours,
    overtime_hours: overtimeHours,
    early_leave_minutes: earlyLeaveMinutes,
    status: nextStatus,
    ...gpsPatch,
  };

  // 超時偵測:work_hours > 9.5 + 當日無 status='approved' 加班申請 → 自動標 is_anomaly。
  // - <= 9.5:不動 is_anomaly(不蓋掉 HR 手動標)
  // - 有核准加班:不標(視為合法超時)
  // - anomaly_note 只覆寫 null 或自己標的(「超時：」前綴),HR 手填的留著
  if (workHours > OVERTIME_ANOMALY_HOURS) {
    const approved = await repo.findApprovedOvertimeRequestByDate(employee_id, open.work_date);
    if (!approved) {
      patch.is_anomaly = true;
      const existingNote = open.anomaly_note;
      if (!existingNote || String(existingNote).startsWith(OVERTIME_ANOMALY_NOTE_PREFIX)) {
        patch.anomaly_note = `${OVERTIME_ANOMALY_NOTE_PREFIX}${workHours}h、無核准加班申請`;
      }
    }
  }

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
  // timestamp 跟 date 都用 Taipei wall-clock 解、避免 UTC ISO('Z' 結尾)被 regex
  // 抓成 UTC HH:MM 跟 wall-clock startTime 比錯。
  const tDateStr = isoToTaipeiDateString(timestamp);
  if (tDateStr !== date) return 0;
  return Math.max(0, t - s);
}

/**
 * 早到分鐘:clock_in 早於 schedule.start_time 的差。max(0, s - t)。
 * 純 audit、不影響 status / late / overtime(由 calculateLateMinutes / clockOut 各自負責)。
 *
 * 跨日班(start_time 22:00、員工 21:30 來)— 跟 calculateLateMinutes 同樣用 Taipei wall-clock 比、
 * 如果跨日 timestamp 在前一天日期、回 0(不應該發生、是 schedule 排錯)。
 */
export function calculateEarlyArrivalMinutes(timestamp, date, startTime) {
  const t = isoToMinutesOfDay(timestamp);
  const s = parseTimeToMin(startTime);
  if (s == null) return 0;
  const tDateStr = isoToTaipeiDateString(timestamp);
  if (tDateStr !== date) return 0;
  return Math.max(0, s - t);
}

export function calculateEarlyLeaveMinutes(timestamp, workDate, endTime, crossesMidnight) {
  const t = isoToMinutesOfDay(timestamp);
  const e = parseTimeToMin(endTime);
  if (e == null) return 0;

  const tDateStr = isoToTaipeiDateString(timestamp);
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

// 台灣固定 +08:00、無 DST、hardcode。timezone-aware ISO 解析共用 helper。
const TAIWAN_TZ_OFFSET_MS = 8 * 3600 * 1000;

/**
 * 把 ISO timestamp(可能是 UTC 'Z' 或 +08:00 顯式)轉成「台灣 wall-clock 當天分鐘數」。
 * UTC 'Z' / +00 / +08 / 等所有 timezone 形式輸入應回相同值。
 * 給 calculateLateMinutes / calculateEarlyLeaveMinutes / recompute.js 共用。
 */
export function isoToMinutesOfDay(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 0;
  const taipei = new Date(date.getTime() + TAIWAN_TZ_OFFSET_MS);
  return taipei.getUTCHours() * 60 + taipei.getUTCMinutes();
}

/**
 * 把 ISO timestamp 轉成「台灣 wall-clock 當天日期」'YYYY-MM-DD'。
 * 用於 cross-midnight 邊界判斷:UTC 16:30 = 台灣隔天 00:30、不能直接 .slice(0,10)。
 */
export function isoToTaipeiDateString(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const t = new Date(date.getTime() + TAIWAN_TZ_OFFSET_MS);
  const y = t.getUTCFullYear();
  const m = String(t.getUTCMonth() + 1).padStart(2, '0');
  const d = String(t.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
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

function subtractDay(date) {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}
