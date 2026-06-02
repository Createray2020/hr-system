#!/usr/bin/env node
// scripts/backfill_2026_05_lianxian.mjs
// 連線前線部 2026-05 考勤核對回灌（dry-run / apply）
//
// 資料來源：scripts/data/backfill_2026_05_lianxian.json
// 共 52 列、7 種 action：
//   LEAVE_FULL / LEAVE_PARTIAL / BACKFILL_NOTED / BACKFILL_SCHED /
//   FIX_SCHED_WINDOW / MARK_OFF / ATT_NORMAL_KEEP_PUNCH
//
// 用法：
//   # dry-run（預設、零寫入）：
//   node --env-file=.env.local scripts/backfill_2026_05_lianxian.mjs
//   # 實寫：
//   node --env-file=.env.local scripts/backfill_2026_05_lianxian.mjs --apply
//   # 覆寫 RUNNER：
//   node --env-file=.env.local scripts/backfill_2026_05_lianxian.mjs --runner=EMP_xxxx
//
// 規範：
//   - attendance.id = `A_${employee_id}_${YYYYMMDD}_${segment_no}`
//   - schedule 必須 status IN ('published','locked','approved') 才採用
//   - 台北固定 UTC+8、無 DST
//   - 每筆寫入 attendance.note prepend：`[YYYY-MM-DD 回灌] {action} by {RUNNER_EMP}`
//   - 不呼叫 salary recalculate、不碰 salary_records / payroll_periods
//   - comp / annual 餘額：用 lib/leave/balance.js 官方函式扣（apply mode 才扣）
//   - schedule_change_logs.change_type='manager_adjust'（FIX_SCHED_WINDOW 用、CHECK 已允許）

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';
import { recomputeAttendanceStatus } from '../lib/attendance/recompute.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── CLI ──────────────────────────────────────────────────
const args = process.argv.slice(2);
const flags = { apply: false, runner: null };
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--apply') flags.apply = true;
  else if (args[i].startsWith('--runner=')) flags.runner = args[i].slice('--runner='.length);
  else if (args[i] === '--runner' && args[i + 1]) flags.runner = args[++i];
}
const RUNNER_EMP = flags.runner || process.env.BACKFILL_RUNNER || 'EMP_01250901';
const APPLY = flags.apply;
const MODE = APPLY ? 'APPLY' : 'DRY-RUN';
const SCHEDULE_CHANGE_TYPE = 'manager_adjust';

// ─── env ──────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌ 缺 SUPABASE_URL 或 SUPABASE_SERVICE_KEY,請用 --env-file=.env.local 跑');
  process.exit(1);
}
const sb = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });

// ─── 時區 helpers(台北固定 +08:00、無 DST)──────────────────
function isoFromTaipei(date, hhmm, { nextDay = false } = {}) {
  // date='YYYY-MM-DD', hhmm='HH:MM' or 'HH:MM:SS'
  // 把「台北 wall-clock」轉成 UTC ISO('Z' 結尾)
  let d = date;
  if (nextDay) {
    const t = new Date(`${date}T00:00:00+08:00`);
    t.setUTCDate(t.getUTCDate() + 1);
    d = t.toISOString().slice(0, 10);
  }
  const time = hhmm.length === 5 ? `${hhmm}:00` : hhmm;
  return new Date(`${d}T${time}+08:00`).toISOString();
}
function todayTaipeiDate() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
}
function timeStrToMin(t) {
  if (!t) return null;
  const m = String(t).match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  return parseInt(m[1]) * 60 + parseInt(m[2]);
}
function minToHHMM(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
}
function workHoursBetween(ciIso, coIso) {
  if (!ciIso || !coIso) return 0;
  const ms = new Date(coIso) - new Date(ciIso);
  if (ms <= 0) return 0;
  return Math.round((ms / 3600000) * 100) / 100;
}

// ─── DB helpers ───────────────────────────────────────────
const attendanceId = (emp, date, seg) => `A_${emp}_${date.replace(/-/g, '')}_${seg}`;

async function findSchedule(emp, date, segment_no) {
  const { data, error } = await sb.from('schedules')
    .select('id, employee_id, work_date, segment_no, shift_type_id, start_time, end_time, crosses_midnight, scheduled_work_minutes, period_id')
    .eq('employee_id', emp).eq('work_date', date).eq('segment_no', segment_no)
    .maybeSingle();
  if (error) throw new Error(`findSchedule ${emp} ${date}: ${error.message}`);
  if (!data) return null;
  if (!data.period_id) return null;
  const { data: p } = await sb.from('schedule_periods').select('status').eq('id', data.period_id).maybeSingle();
  if (!p || !['published', 'locked', 'approved'].includes(p.status)) return null;
  return data;
}

async function findAttendance(emp, date, seg) {
  const id = attendanceId(emp, date, seg);
  const { data, error } = await sb.from('attendance').select('*').eq('id', id).maybeSingle();
  if (error) throw new Error(`findAttendance ${id}: ${error.message}`);
  return data || null;
}

async function findApprovedLeaveCovering(emp, date) {
  const dayStart = `${date}T00:00:00+08:00`;
  const dayEnd   = `${date}T23:59:59+08:00`;
  const { data, error } = await sb.from('leave_requests')
    .select('id, leave_type, status, start_at, end_at, days, hours')
    .eq('employee_id', emp).is('deleted_at', null)
    .in('status', ['approved', 'archived'])
    .lte('start_at', dayEnd).gte('end_at', dayStart);
  if (error) throw new Error(`findApprovedLeaveCovering ${emp} ${date}: ${error.message}`);
  return data || [];
}

// 用 start_date/end_date(DATE 欄)+ leave_type 比對涵蓋該日的 approved/archived 單。
// 比 findApprovedLeaveCovering 嚴格:同假別才當 dup、且用 DATE 比避免 timezone 邊界誤判。
// 'archived' 是 HR-final 狀態(approved → archived),在「dup 不重複建」語意上等同 approved。
async function findCoveringApprovedLeave(emp, work_date, leave_type) {
  const { data, error } = await sb.from('leave_requests')
    .select('id, leave_type, status, start_date, end_date')
    .eq('employee_id', emp).eq('leave_type', leave_type)
    .in('status', ['approved', 'archived'])
    .is('deleted_at', null)
    .lte('start_date', work_date).gte('end_date', work_date)
    .limit(1).maybeSingle();
  if (error) throw new Error(`findCoveringApprovedLeave ${emp} ${work_date} ${leave_type}: ${error.message}`);
  return data?.id || null;
}

async function findCompTotalRemaining(emp) {
  const { data, error } = await sb.from('comp_time_balance')
    .select('earned_hours, used_hours, status')
    .eq('employee_id', emp).eq('status', 'active');
  if (error) throw new Error(`findCompTotalRemaining ${emp}: ${error.message}`);
  return (data || []).reduce((s, b) => s + (Number(b.earned_hours) - Number(b.used_hours)), 0);
}

// ─── 主流程 ───────────────────────────────────────────────
const JSON_PATH = path.join(__dirname, 'data', 'backfill_2026_05_lianxian.json');
const items = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
const AUDIT_TODAY = todayTaipeiDate();
const NOTE_PREFIX_FN = (action) => `[${AUDIT_TODAY} 回灌] ${action} by ${RUNNER_EMP}`;
const BATCH_BASE_MS = Date.now();
const mkLeaveId = (i) => `L${BATCH_BASE_MS + i}_${items[i].employee_id}`;

console.log(`════════════════════════════════════════════════════════════════`);
console.log(`backfill_2026_05_lianxian.mjs  mode=${MODE}  runner=${RUNNER_EMP}`);
console.log(`json: ${JSON_PATH}  items: ${items.length}`);
console.log(`════════════════════════════════════════════════════════════════\n`);

const summary = {};  // by emp: { work_hours_delta, absent_removed, leaves: {type: {days,hours}} }
const errors = [];
const warnings = [];

function bump(emp, field, value) {
  if (!summary[emp]) summary[emp] = { work_hours_delta: 0, absent_removed: 0, leaves: {} };
  if (field === 'leaves') {
    const { type, days, hours } = value;
    if (!summary[emp].leaves[type]) summary[emp].leaves[type] = { days: 0, hours: 0 };
    summary[emp].leaves[type].days += days;
    summary[emp].leaves[type].hours += hours;
  } else {
    summary[emp][field] += value;
  }
}

function fmtPunch(iso) {
  if (!iso) return 'null';
  const d = new Date(iso);
  const taipei = new Date(d.getTime() + 8 * 3600000);
  return taipei.toISOString().slice(0, 16).replace('T', ' ');
}

// ─── 動作分流 ────────────────────────────────────────────
async function handleBackfillSched(item, i) {
  const { employee_id: emp, work_date, segment_no } = item;
  const sched = await findSchedule(emp, work_date, segment_no);
  if (!sched) return { error: '找不到 published/locked/approved 排班' };
  if (!sched.start_time || !sched.end_time) return { error: '排班 start_time/end_time 為 null' };

  const startStr = String(sched.start_time).slice(0, 5);  // 'HH:MM'
  const endStr   = String(sched.end_time).slice(0, 5);
  const ciIso = isoFromTaipei(work_date, startStr);
  const coIso = isoFromTaipei(work_date, endStr, { nextDay: !!sched.crosses_midnight });

  const existing = await findAttendance(emp, work_date, segment_no);
  const before = existing
    ? { status: existing.status, clock_in: existing.clock_in, clock_out: existing.clock_out, work_hours: existing.work_hours }
    : null;

  const newCi = existing?.clock_in || ciIso;
  const newCo = existing?.clock_out || coIso;
  // 補打卡是「重新建立打卡事實」、要清掉 cron 之前因為沒打卡而標的 'absent'。
  // 故傳 status='normal'、繞過 recompute 的 PRESERVED_STATUSES(absent/leave/holiday)。
  const r = recomputeAttendanceStatus(
    { clock_in: newCi, clock_out: newCo, work_date, status: 'normal' },
    { start_time: sched.start_time, end_time: sched.end_time, crosses_midnight: !!sched.crosses_midnight },
  );
  const workHours = workHoursBetween(newCi, newCo);
  const row = {
    id: existing?.id || attendanceId(emp, work_date, segment_no),
    employee_id: emp, work_date,
    schedule_id: sched.id, segment_no,
    clock_in: newCi, clock_out: newCo,
    late_minutes: r.late_minutes, early_arrival_minutes: r.early_arrival_minutes,
    early_leave_minutes: r.early_leave_minutes,
    work_hours: workHours, overtime_hours: existing?.overtime_hours ?? 0,
    status: r.status, is_holiday_work: existing?.is_holiday_work ?? false,
    holiday_id: existing?.holiday_id ?? null,
    is_anomaly: existing?.is_anomaly ?? false, anomaly_note: existing?.anomaly_note ?? null,
    note: `${NOTE_PREFIX_FN('BACKFILL_SCHED')}${existing?.note ? '\n' + existing.note : ''}`,
  };

  // delta
  if (before?.status === 'absent') bump(emp, 'absent_removed', 1);
  bump(emp, 'work_hours_delta', workHours - (Number(before?.work_hours) || 0));

  return {
    before, after: { status: row.status, clock_in: row.clock_in, clock_out: row.clock_out, work_hours: row.work_hours },
    write: async () => { await upsertAttendance(row); },
  };
}

async function handleBackfillNoted(item) {
  const { employee_id: emp, work_date, segment_no, ci, co } = item;
  if (!ci || !co) return { error: '缺 ci/co' };
  const sched = await findSchedule(emp, work_date, segment_no);
  // sched 可能不存在(離職員工某些天可能沒排班)— 仍允許寫打卡、但 recompute 結果 status='normal'
  const ciMin = timeStrToMin(ci);
  const coMin = timeStrToMin(co);
  const coNextDay = coMin <= ciMin;
  const ciIso = isoFromTaipei(work_date, ci);
  const coIso = isoFromTaipei(work_date, co, { nextDay: coNextDay });

  const existing = await findAttendance(emp, work_date, segment_no);
  const before = existing
    ? { status: existing.status, clock_in: existing.clock_in, clock_out: existing.clock_out, work_hours: existing.work_hours }
    : null;

  // BACKFILL_NOTED 寫入新的 ci/co、要清 absent;recompute 內 PRESERVED 邏輯不適用此情境
  const r = sched
    ? recomputeAttendanceStatus(
        { clock_in: ciIso, clock_out: coIso, work_date, status: 'normal' },
        { start_time: sched.start_time, end_time: sched.end_time, crosses_midnight: !!sched.crosses_midnight },
      )
    : { status: 'normal', late_minutes: 0, early_arrival_minutes: 0, early_leave_minutes: 0 };
  const workHours = workHoursBetween(ciIso, coIso);
  const row = {
    id: existing?.id || attendanceId(emp, work_date, segment_no),
    employee_id: emp, work_date,
    schedule_id: sched?.id || existing?.schedule_id || null,
    segment_no, clock_in: ciIso, clock_out: coIso,
    late_minutes: r.late_minutes, early_arrival_minutes: r.early_arrival_minutes,
    early_leave_minutes: r.early_leave_minutes,
    work_hours: workHours, overtime_hours: existing?.overtime_hours ?? 0,
    status: r.status, is_holiday_work: existing?.is_holiday_work ?? false,
    holiday_id: existing?.holiday_id ?? null,
    is_anomaly: existing?.is_anomaly ?? false, anomaly_note: existing?.anomaly_note ?? null,
    note: `${NOTE_PREFIX_FN('BACKFILL_NOTED')}${existing?.note ? '\n' + existing.note : ''}`,
  };
  if (before?.status === 'absent') bump(emp, 'absent_removed', 1);
  bump(emp, 'work_hours_delta', workHours - (Number(before?.work_hours) || 0));

  return {
    before, after: { status: row.status, clock_in: row.clock_in, clock_out: row.clock_out, work_hours: row.work_hours },
    warnings: sched ? [] : ['排班缺、status 預設 normal、不算 late/early'],
    write: async () => { await upsertAttendance(row); },
  };
}

async function handleLeaveFull(item, i) {
  const { employee_id: emp, work_date, segment_no, leave_type } = item;
  const sched = await findSchedule(emp, work_date, segment_no);
  const startStr = (sched?.start_time ? String(sched.start_time).slice(0, 5) : '09:00');
  const endStr   = (sched?.end_time   ? String(sched.end_time).slice(0, 5)   : '18:00');
  const startAt = isoFromTaipei(work_date, startStr);
  const endAt   = isoFromTaipei(work_date, endStr, { nextDay: !!sched?.crosses_midnight });

  // 既有 covering 同型 approved leave 檢查(idempotent dup skip)
  const dupId = await findCoveringApprovedLeave(emp, work_date, leave_type);
  const leaveId = dupId ? null : mkLeaveId(i);
  const nowIso = new Date().toISOString();
  const leaveRow = dupId ? null : {
    id: leaveId, employee_id: emp, leave_type,
    start_date: work_date, end_date: work_date,
    days: 1, hours: 8, finalized_hours: 8,
    start_at: startAt, end_at: endAt,
    reason: '5月考勤核對回灌',
    status: 'approved',
    applied_at: nowIso, handled_at: nowIso, handled_by: RUNNER_EMP,
    reviewed_by: RUNNER_EMP, reviewed_at: nowIso,
    mgr_reviewed_by: RUNNER_EMP, mgr_reviewed_at: nowIso, mgr_decision: 'approved',
    ceo_reviewed_by: RUNNER_EMP, ceo_reviewed_at: nowIso, ceo_decision: 'approved',
    late_application: false, proof_status: 'not_required',
  };

  const existing = await findAttendance(emp, work_date, segment_no);
  const before = existing
    ? { status: existing.status, clock_in: existing.clock_in, clock_out: existing.clock_out, work_hours: existing.work_hours }
    : null;
  const attRow = {
    id: existing?.id || attendanceId(emp, work_date, segment_no),
    employee_id: emp, work_date,
    schedule_id: sched?.id || existing?.schedule_id || null, segment_no,
    clock_in: null, clock_out: null,
    late_minutes: 0, early_arrival_minutes: 0, early_leave_minutes: 0,
    work_hours: 0, overtime_hours: 0,
    status: 'leave',
    is_holiday_work: false, holiday_id: existing?.holiday_id ?? null,
    is_anomaly: false, anomaly_note: null,
    note: `${NOTE_PREFIX_FN('LEAVE_FULL ' + leave_type)}${existing?.note ? '\n' + existing.note : ''}`,
  };

  if (before?.status === 'absent') bump(emp, 'absent_removed', 1);
  bump(emp, 'work_hours_delta', 0 - (Number(before?.work_hours) || 0));
  // dup 不增加 leaves 統計(已存在於系統、不是本次新增)
  if (!dupId) bump(emp, 'leaves', { type: leave_type, days: 1, hours: 8 });

  // 餘額處理:dup 時不扣(原假單已扣);非 dup 才檢查
  const balanceNote = dupId ? null : await checkBalanceForLeave({ emp, leave_type, hours: 8, days: 1, leave_date: work_date });

  return {
    before, after: { status: 'leave', clock_in: null, clock_out: null, work_hours: 0 },
    leave: dupId
      ? { skip_dup: dupId, type: leave_type }
      : { id: leaveId, type: leave_type, hours: 8, days: 1 },
    balance: balanceNote,
    write: async () => {
      if (!dupId) await insertLeave(leaveRow);
      await upsertAttendance(attRow);
      if (!dupId) await applyBalance({ emp, leave_type, hours: 8, days: 1, leave_date: work_date, leave_id: leaveId });
    },
  };
}

async function handleLeavePartial(item, i) {
  const { employee_id: emp, work_date, segment_no, leave_type, side } = item;
  const sched = await findSchedule(emp, work_date, segment_no);
  if (!sched) return { error: '找不到 published/locked/approved 排班(LEAVE_PARTIAL 需要)' };
  if (!sched.start_time || !sched.end_time) return { error: '排班 start/end_time 為 null' };
  const existing = await findAttendance(emp, work_date, segment_no);
  if (!existing || !existing.clock_in || !existing.clock_out) {
    return { error: 'LEAVE_PARTIAL 需要既有 clock_in + clock_out' };
  }

  const before = { status: existing.status, clock_in: existing.clock_in, clock_out: existing.clock_out, work_hours: existing.work_hours };
  const startStr = String(sched.start_time).slice(0, 5);
  const endStr   = String(sched.end_time).slice(0, 5);
  const schedStartIso = isoFromTaipei(work_date, startStr);
  const schedEndIso   = isoFromTaipei(work_date, endStr, { nextDay: !!sched.crosses_midnight });

  let lvStartIso, lvEndIso;
  if (side === 'leading') {
    lvStartIso = schedStartIso;
    lvEndIso   = existing.clock_in;
  } else if (side === 'trailing') {
    lvStartIso = existing.clock_out;
    lvEndIso   = schedEndIso;
  } else {
    return { error: `unknown side: ${side}` };
  }
  const hours = workHoursBetween(lvStartIso, lvEndIso);
  if (hours <= 0) return { error: `partial 時段 ≤ 0h (side=${side})` };

  // dup guard:同 leave_type 已 cover 該日 → SKIP insert(attendance 修正仍跑)
  const dupId = await findCoveringApprovedLeave(emp, work_date, leave_type);

  // comp 餘額不足 → 整列 HOLD(連 attendance 也不動、避免「假單沒生 但 status 變 normal」造成 absent 變正常工時)
  if (!dupId && leave_type === 'comp') {
    const totalRemaining = await findCompTotalRemaining(emp);
    if (totalRemaining + 1e-6 < hours) {
      return {
        held: `comp balance insufficient: ${emp} ${work_date} need=${hours}h have=${totalRemaining}h`,
      };
    }
  }

  const leaveId = dupId ? null : mkLeaveId(i);
  const nowIso = new Date().toISOString();
  const leaveRow = dupId ? null : {
    id: leaveId, employee_id: emp, leave_type,
    start_date: work_date, end_date: work_date,
    days: 0, hours, finalized_hours: hours,
    start_at: lvStartIso, end_at: lvEndIso,
    reason: '5月考勤核對回灌',
    status: 'approved',
    applied_at: nowIso, handled_at: nowIso, handled_by: RUNNER_EMP,
    reviewed_by: RUNNER_EMP, reviewed_at: nowIso,
    mgr_reviewed_by: RUNNER_EMP, mgr_reviewed_at: nowIso, mgr_decision: 'approved',
    ceo_reviewed_by: RUNNER_EMP, ceo_reviewed_at: nowIso, ceo_decision: 'approved',
    late_application: false, proof_status: 'not_required',
  };

  const newWorkHours = workHoursBetween(existing.clock_in, existing.clock_out);
  const attRow = {
    id: existing.id, employee_id: emp, work_date,
    schedule_id: existing.schedule_id || sched.id, segment_no,
    clock_in: existing.clock_in, clock_out: existing.clock_out,
    late_minutes: 0, early_arrival_minutes: existing.early_arrival_minutes ?? 0, early_leave_minutes: 0,
    work_hours: newWorkHours, overtime_hours: existing.overtime_hours ?? 0,
    status: 'normal',
    is_holiday_work: existing.is_holiday_work ?? false,
    holiday_id: existing.holiday_id ?? null,
    is_anomaly: existing.is_anomaly ?? false, anomaly_note: existing.anomaly_note ?? null,
    note: `${NOTE_PREFIX_FN(`LEAVE_PARTIAL ${leave_type} ${side} ${hours}h`)}${existing.note ? '\n' + existing.note : ''}`,
  };

  // delta
  bump(emp, 'work_hours_delta', newWorkHours - (Number(before.work_hours) || 0));
  if (!dupId) bump(emp, 'leaves', { type: leave_type, days: 0, hours });

  const balanceNote = dupId ? null : await checkBalanceForLeave({ emp, leave_type, hours, days: 0, leave_date: work_date });

  return {
    before, after: { status: 'normal', clock_in: existing.clock_in, clock_out: existing.clock_out, work_hours: newWorkHours },
    leave: dupId
      ? { skip_dup: dupId, type: leave_type, hours, side }
      : { id: leaveId, type: leave_type, hours, days: 0, side },
    balance: balanceNote,
    write: async () => {
      if (!dupId) await insertLeave(leaveRow);
      await upsertAttendance(attRow);
      if (!dupId) await applyBalance({ emp, leave_type, hours, days: 0, leave_date: work_date, leave_id: leaveId });
    },
  };
}

async function handleFixSchedWindow(item) {
  const { employee_id: emp, work_date, segment_no, start, end, crosses_midnight } = item;
  if (!start || !end) return { error: '缺 start/end' };
  const sched = await findSchedule(emp, work_date, segment_no);
  if (!sched) return { error: '找不到 published/locked/approved 排班' };

  const sm = timeStrToMin(start);
  const em = timeStrToMin(end);
  const newScheduledMin = crosses_midnight ? (em + 1440 - sm) : (em - sm);
  const before = {
    start: String(sched.start_time).slice(0,5), end: String(sched.end_time).slice(0,5),
    crosses_midnight: !!sched.crosses_midnight, scheduled_work_minutes: sched.scheduled_work_minutes,
  };
  const after = { start, end, crosses_midnight: !!crosses_midnight, scheduled_work_minutes: newScheduledMin };

  // recompute attendance with new sched window
  const existing = await findAttendance(emp, work_date, segment_no);
  const attBefore = existing
    ? { status: existing.status, clock_in: existing.clock_in, clock_out: existing.clock_out, work_hours: existing.work_hours }
    : null;
  let attAfter = null;
  let attWrite = null;
  if (existing && existing.clock_in) {
    // FIX_SCHED_WINDOW 改了排班、要依新窗口重判 late/early、不沿用原 status(避免 absent/leave/holiday PRESERVE 蓋掉)
    const r = recomputeAttendanceStatus(
      { clock_in: existing.clock_in, clock_out: existing.clock_out, work_date, status: 'normal' },
      { start_time: start, end_time: end, crosses_midnight: !!crosses_midnight },
    );
    const wh = workHoursBetween(existing.clock_in, existing.clock_out);
    const row = {
      ...existing,
      late_minutes: r.late_minutes, early_arrival_minutes: r.early_arrival_minutes,
      early_leave_minutes: r.early_leave_minutes,
      work_hours: wh, status: r.status,
      note: `${NOTE_PREFIX_FN(`FIX_SCHED_WINDOW ${start}-${end}${crosses_midnight ? ' xnight' : ''}`)}${existing.note ? '\n' + existing.note : ''}`,
    };
    attAfter = { status: row.status, clock_in: row.clock_in, clock_out: row.clock_out, work_hours: row.work_hours };
    bump(emp, 'work_hours_delta', wh - (Number(attBefore?.work_hours) || 0));
    attWrite = async () => { await upsertAttendance(row); };
  }

  const schedPatch = {
    start_time: start, end_time: end,
    crosses_midnight: !!crosses_midnight,
    scheduled_work_minutes: newScheduledMin,
    updated_at: new Date().toISOString(), updated_by: RUNNER_EMP,
  };
  const logRow = {
    schedule_id: sched.id, employee_id: emp,
    change_type: SCHEDULE_CHANGE_TYPE, changed_by: RUNNER_EMP,
    before_data: { start_time: sched.start_time, end_time: sched.end_time, crosses_midnight: sched.crosses_midnight, scheduled_work_minutes: sched.scheduled_work_minutes },
    after_data:  schedPatch,
    reason: `${AUDIT_TODAY} 回灌 FIX_SCHED_WINDOW`,
  };

  return {
    schedule: { before, after },
    attBefore, attAfter,
    write: async () => {
      const { error } = await sb.from('schedules').update(schedPatch).eq('id', sched.id);
      if (error) throw new Error(`update schedule ${sched.id}: ${error.message}`);
      const { error: logErr } = await sb.from('schedule_change_logs').insert([logRow]);
      if (logErr) throw new Error(`insert schedule_change_logs: ${logErr.message}`);
      if (attWrite) await attWrite();
    },
  };
}

async function handleMarkOff(item) {
  const { employee_id: emp, work_date, segment_no } = item;
  const existing = await findAttendance(emp, work_date, segment_no);
  const sched = await findSchedule(emp, work_date, segment_no);
  const before = existing
    ? { status: existing.status, clock_in: existing.clock_in, clock_out: existing.clock_out, work_hours: existing.work_hours }
    : null;
  const row = {
    id: existing?.id || attendanceId(emp, work_date, segment_no),
    employee_id: emp, work_date,
    schedule_id: sched?.id || existing?.schedule_id || null, segment_no,
    clock_in: null, clock_out: null,
    late_minutes: 0, early_arrival_minutes: 0, early_leave_minutes: 0,
    work_hours: 0, overtime_hours: 0,
    status: 'holiday',
    is_holiday_work: existing?.is_holiday_work ?? false,
    holiday_id: existing?.holiday_id ?? null,
    is_anomaly: false, anomaly_note: null,
    note: `${NOTE_PREFIX_FN('MARK_OFF')}${existing?.note ? '\n' + existing.note : ''}`,
  };
  if (before?.status === 'absent') bump(emp, 'absent_removed', 1);
  bump(emp, 'work_hours_delta', 0 - (Number(before?.work_hours) || 0));
  return {
    before, after: { status: 'holiday', clock_in: null, clock_out: null, work_hours: 0 },
    write: async () => { await upsertAttendance(row); },
  };
}

async function handleAttNormalKeepPunch(item) {
  const { employee_id: emp, work_date, segment_no, note_extra } = item;
  const existing = await findAttendance(emp, work_date, segment_no);
  if (!existing) return { error: 'ATT_NORMAL_KEEP_PUNCH 需要既有 attendance row' };
  if (!existing.clock_in || !existing.clock_out) return { error: '缺 clock_in / clock_out' };
  const before = { status: existing.status, clock_in: existing.clock_in, clock_out: existing.clock_out, work_hours: existing.work_hours };
  const wh = workHoursBetween(existing.clock_in, existing.clock_out);
  const extra = note_extra ? `(${note_extra})` : '';
  const row = {
    ...existing,
    late_minutes: 0, early_leave_minutes: 0,
    work_hours: wh, status: 'normal',
    note: `${NOTE_PREFIX_FN(`ATT_NORMAL_KEEP_PUNCH${extra}`)}${existing.note ? '\n' + existing.note : ''}`,
  };
  bump(emp, 'work_hours_delta', wh - (Number(before.work_hours) || 0));
  return {
    before, after: { status: 'normal', clock_in: existing.clock_in, clock_out: existing.clock_out, work_hours: wh },
    write: async () => { await upsertAttendance(row); },
  };
}

// ─── 寫入 helpers ─────────────────────────────────────────
async function upsertAttendance(row) {
  const { error } = await sb.from('attendance').upsert([row], { onConflict: 'id' });
  if (error) throw new Error(`upsert attendance ${row.id}: ${error.message}`);
}
async function insertLeave(row) {
  const { error } = await sb.from('leave_requests').insert([row]);
  if (error) throw new Error(`insert leave_requests ${row.id}: ${error.message}`);
}

// ─── 餘額 ─────────────────────────────────────────────────
async function checkBalanceForLeave({ emp, leave_type, hours, days, leave_date }) {
  if (leave_type === 'annual') {
    const { data: rec } = await sb.from('annual_leave_records')
      .select('id, granted_days, used_days, status, period_start, period_end')
      .eq('employee_id', emp).eq('status', 'active')
      .lte('period_start', leave_date).gte('period_end', leave_date)
      .maybeSingle();
    if (!rec) return { warn: 'annual: 無 active record、無法扣餘額', will_deduct: false };
    const remaining = Number(rec.granted_days) - Number(rec.used_days);
    if (remaining + 1e-6 < days) return { warn: `annual: 餘額 ${remaining}d < 要扣 ${days}d`, will_deduct: false };
    return { ok: `annual: 將扣 ${days}d (剩餘 ${remaining}d)`, will_deduct: true };
  }
  if (leave_type === 'comp') {
    const { data: balances } = await sb.from('comp_time_balance')
      .select('id, earned_hours, used_hours, expires_at, status')
      .eq('employee_id', emp).eq('status', 'active')
      .order('expires_at', { ascending: true });
    const totalRemaining = (balances || []).reduce(
      (s, b) => s + (Number(b.earned_hours) - Number(b.used_hours)), 0,
    );
    if (totalRemaining + 1e-6 < hours) return { warn: `comp: 餘額 ${totalRemaining}h < 要扣 ${hours}h`, will_deduct: false };
    return { ok: `comp: 將扣 ${hours}h (剩餘 ${totalRemaining}h)`, will_deduct: true };
  }
  return null;
}

async function applyBalance({ emp, leave_type, hours, days, leave_date, leave_id }) {
  if (!APPLY) return;
  if (leave_type === 'annual' && days > 0) {
    const { deductAnnualLeave } = await import('../lib/leave/balance.js');
    const { makeLeaveRepo } = await import('../api/leaves/_repo.js');
    const r = await deductAnnualLeave(makeLeaveRepo(), {
      employee_id: emp, days, leave_request_id: leave_id,
      changed_by: RUNNER_EMP, reason: '回灌核對',
      leave_date,
    });
    if (!r.ok) warnings.push(`${emp} ${leave_date} annual 扣餘額失敗: ${r.reason}`);
  } else if (leave_type === 'comp' && hours > 0) {
    const { deductCompTime } = await import('../lib/leave/balance.js');
    const { makeLeaveRepo } = await import('../api/leaves/_repo.js');
    const r = await deductCompTime(makeLeaveRepo(), {
      employee_id: emp, hours, leave_request_id: leave_id,
      changed_by: RUNNER_EMP, reason: '回灌核對',
    });
    if (!r.ok) warnings.push(`${emp} ${leave_date} comp 扣餘額失敗: ${r.reason}`);
  }
}

// ─── 主迴圈 ───────────────────────────────────────────────
const RUNS = {
  BACKFILL_SCHED:      handleBackfillSched,
  BACKFILL_NOTED:      handleBackfillNoted,
  LEAVE_FULL:          handleLeaveFull,
  LEAVE_PARTIAL:       handleLeavePartial,
  FIX_SCHED_WINDOW:    handleFixSchedWindow,
  MARK_OFF:            handleMarkOff,
  ATT_NORMAL_KEEP_PUNCH: handleAttNormalKeepPunch,
};

for (let i = 0; i < items.length; i++) {
  const it = items[i];
  const tag = `${String(i+1).padStart(2,'0')}. ${it.employee_id} ${it.name} ${it.work_date} seg${it.segment_no} ${it.action}`;
  const fn = RUNS[it.action];
  if (!fn) { console.log(`${tag}\n   ❌ unknown action`); errors.push(`${tag}: unknown action`); continue; }
  let res;
  try { res = await fn(it, i); }
  catch (e) { console.log(`${tag}\n   ❌ EXCEPTION: ${e.message}`); errors.push(`${tag}: ${e.message}`); continue; }

  if (res?.error) {
    console.log(`${tag}\n   ❌ ERROR: ${res.error}`);
    errors.push(`${tag}: ${res.error}`);
    continue;
  }
  if (res?.held) {
    console.log(`${tag}\n   ⏸ HELD: ${res.held}`);
    warnings.push(`${tag}: HELD ${res.held}`);
    continue;
  }
  console.log(tag);
  if (res.before !== undefined && res.after) {
    console.log(`   att before: status=${res.before?.status ?? '(no row)'} ci=${fmtPunch(res.before?.clock_in)} co=${fmtPunch(res.before?.clock_out)} wh=${res.before?.work_hours ?? '-'}`);
    console.log(`   att after:  status=${res.after.status} ci=${fmtPunch(res.after.clock_in)} co=${fmtPunch(res.after.clock_out)} wh=${res.after.work_hours}`);
  }
  if (res.leave) {
    if (res.leave.skip_dup) {
      console.log(`   SKIP dup leave: ${res.leave.skip_dup} (${res.leave.type}${res.leave.side ? ' '+res.leave.side : ''})`);
    } else {
      console.log(`   + leave_requests ${res.leave.id} ${res.leave.type} hours=${res.leave.hours} days=${res.leave.days}${res.leave.side ? ' side='+res.leave.side : ''}`);
    }
  }
  if (res.balance) {
    if (res.balance.warn) { console.log(`   ⚠ balance: ${res.balance.warn}`); warnings.push(`${tag}: ${res.balance.warn}`); }
    if (res.balance.ok)   console.log(`   ✓ balance: ${res.balance.ok}`);
  }
  if (res.schedule) {
    const b = res.schedule.before, a = res.schedule.after;
    console.log(`   schedule before: ${b.start}-${b.end} xnight=${b.crosses_midnight} sched_min=${b.scheduled_work_minutes}`);
    console.log(`   schedule after:  ${a.start}-${a.end} xnight=${a.crosses_midnight} sched_min=${a.scheduled_work_minutes}  (change_type=${SCHEDULE_CHANGE_TYPE})`);
    if (res.attBefore) console.log(`   att before: status=${res.attBefore.status} wh=${res.attBefore.work_hours}`);
    if (res.attAfter)  console.log(`   att after:  status=${res.attAfter.status} wh=${res.attAfter.work_hours}`);
  }
  if (res.warnings) for (const w of res.warnings) { console.log(`   ⚠ ${w}`); warnings.push(`${tag}: ${w}`); }

  if (APPLY) {
    try { await res.write(); console.log(`   ✓ applied`); }
    catch (e) { console.log(`   ❌ WRITE FAIL: ${e.message}`); errors.push(`${tag}: write ${e.message}`); }
  }
  console.log('');
}

// ─── 結尾彙總 ─────────────────────────────────────────────
console.log(`════════════════════════════════════════════════════════════════`);
console.log(`彙總 by 員工`);
console.log(`════════════════════════════════════════════════════════════════`);
const emps = Object.keys(summary).sort();
for (const emp of emps) {
  const s = summary[emp];
  const leaveStr = Object.entries(s.leaves).map(([t, v]) => `${t}(${v.days}d/${v.hours}h)`).join(', ') || '-';
  console.log(`  ${emp}  work_hours_delta=${s.work_hours_delta.toFixed(2)}h  absent_removed=${s.absent_removed}  leaves=${leaveStr}`);
}
console.log('');
console.log(`ERRORS: ${errors.length}${errors.length ? '\n  - ' + errors.join('\n  - ') : ''}`);
console.log(`WARNINGS: ${warnings.length}${warnings.length ? '\n  - ' + warnings.join('\n  - ') : ''}`);
console.log(`\n[${MODE}] 完成。${APPLY ? '' : '加 --apply 才實寫'}`);
