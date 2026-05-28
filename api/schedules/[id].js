// api/schedules/[id].js
// PUT    /api/schedules/:id   → 修改一筆 schedule（新邏輯：算 isLateChange、寫 log）
// DELETE /api/schedules/:id   → 刪除一筆 schedule（新邏輯：寫 log）
//
// 對應設計文件：docs/attendance-system-design-v1.md §4.2.2 / §9.4
// 對應實作計畫：docs/attendance-system-implementation-plan-v1.md §5.8

import { supabaseAdmin } from '../../lib/supabase.js';
import { requireAuth } from '../../lib/auth.js';
import { isBackofficeRole } from '../../lib/roles.js';
import { canEmployeeEditSchedule, canManagerEditSchedule, checkEmployeeShiftRestricted } from '../../lib/schedule/permissions.js';
import { logScheduleChange } from '../../lib/schedule/change-logger.js';
import { calculateScheduleWorkMinutes } from '../../lib/schedule/work-hours.js';
import { sendPushToRoles, createNotificationsForRoles, sendPushToEmployees, createNotifications } from '../../lib/push.js';
import { recomputeAttendanceStatus } from '../../lib/attendance/recompute.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  const caller = await requireAuth(req, res);
  if (!caller) return;

  const id = req.query.id || req.body?.id;
  if (!id) return res.status(400).json({ error: 'schedule id required' });

  const { data: existing, error: eErr } = await supabaseAdmin
    .from('schedules').select('*').eq('id', id).maybeSingle();
  if (eErr) return res.status(500).json({ error: eErr.message });
  if (!existing) return res.status(404).json({ error: 'schedule not found' });

  // 撈對應的 period
  const { data: period, error: pErr } = await supabaseAdmin
    .from('schedule_periods').select('*').eq('id', existing.period_id).maybeSingle();
  if (pErr) return res.status(500).json({ error: pErr.message });
  if (!period) {
    return res.status(409).json({ error: 'schedule has no period_id (legacy data?)' });
  }

  // 權限檢查
  const today = new Date().toISOString().slice(0, 10);
  const isSelf = caller.id && caller.id === existing.employee_id;
  let actorKind = 'employee';
  let isLateChange = false;

  if (isSelf) {
    const r = canEmployeeEditSchedule(period, existing.employee_id, today);
    if (!r.ok) return res.status(403).json({ error: r.reason });

    // G1:員工只能標「希望休假」(ST003 + __OFF__) 或留空(對應 PUT 改 shift_type)
    // DELETE 不過此檢查(req.body 通常空、checkEmployeeShiftRestricted 回 ok)
    if (req.method === 'PUT') {
      const r2 = checkEmployeeShiftRestricted(req.body);
      if (!r2.ok) return res.status(403).json({ error: r2.reason });
    }
  } else {
    let inSameDept = false;
    if (caller.is_manager === true && caller.dept_id) {
      const { data: emp } = await supabaseAdmin.from('employees')
        .select('dept_id').eq('id', existing.employee_id).maybeSingle();
      inSameDept = !!emp && emp.dept_id === caller.dept_id;
    }
    const manager = {
      id: caller.id, role: caller.role,
      is_manager: caller.is_manager === true,
      in_same_dept: inSameDept,
    };
    const r = canManagerEditSchedule(period, manager, today, existing.work_date);
    if (!r.ok) return res.status(403).json({ error: r.reason });
    actorKind = isBackofficeRole(caller) ? 'hr' : 'manager';
    isLateChange = !!r.isLateChange && existing.work_date === today;
  }

  if (req.method === 'PUT')    return handlePut(req, res, { existing, caller, actorKind, isLateChange });
  if (req.method === 'DELETE') return handleDelete(req, res, { existing, caller, actorKind, isLateChange });
  return res.status(405).json({ error: 'Method not allowed' });
}

async function handlePut(req, res, { existing, caller, actorKind, isLateChange }) {
  const { shift_type_id, start_time, end_time, crosses_midnight, break_minutes, note } = req.body || {};

  const cm = crosses_midnight !== undefined
    ? !!crosses_midnight
    : (start_time && end_time ? end_time < start_time : !!existing.crosses_midnight);
  const ns = start_time !== undefined ? start_time : existing.start_time;
  const ne = end_time   !== undefined ? end_time   : existing.end_time;
  const minutes = calculateScheduleWorkMinutes(ns, ne, break_minutes, cm);

  const patch = {
    shift_type_id: shift_type_id !== undefined ? (shift_type_id || null) : existing.shift_type_id,
    start_time:    ns || null,
    end_time:      ne || null,
    crosses_midnight: cm,
    scheduled_work_minutes: minutes,
    note: note !== undefined ? (note || '') : existing.note,
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await supabaseAdmin
    .from('schedules').update(patch).eq('id', existing.id).select().maybeSingle();
  if (error) return res.status(500).json({ error: error.message });

  // P8.1: cascade trigger attendance recompute(對齊 P4.1 pattern)
  // 改 schedule 後、找對應 attendance row(same employee_id + work_date + segment_no)、
  // 用更新後的 schedule 重算 late/early/status、寫進 attendance + 加 audit 行。
  // best-effort:cascade 失敗不擋 schedule update。
  let attendanceCascade = null;
  try {
    const { data: attRow } = await supabaseAdmin
      .from('attendance').select('*')
      .eq('employee_id', existing.employee_id)
      .eq('work_date', existing.work_date)
      .eq('segment_no', existing.segment_no || 1)
      .maybeSingle();

    if (attRow) {
      const r = recomputeAttendanceStatus(attRow, data);
      const auditChanges = [];
      if (r.late_minutes !== attRow.late_minutes) auditChanges.push(`late_minutes ${attRow.late_minutes ?? 0}→${r.late_minutes}`);
      if (r.early_leave_minutes !== attRow.early_leave_minutes) auditChanges.push(`early_leave_minutes ${attRow.early_leave_minutes ?? 0}→${r.early_leave_minutes}`);
      if (r.early_arrival_minutes !== attRow.early_arrival_minutes) auditChanges.push(`early_arrival_minutes ${attRow.early_arrival_minutes ?? 0}→${r.early_arrival_minutes}`);
      if (r.status !== attRow.status) auditChanges.push(`status ${attRow.status}→${r.status}`);

      if (auditChanges.length > 0) {
        const nowDate = new Date().toISOString().slice(0, 10);
        const auditLine = `[${nowDate}] schedule change cascade by ${caller.id}: ${auditChanges.join(', ')}`;
        const newNote = attRow.note ? `${auditLine}\n${attRow.note}` : auditLine;
        const { error: updErr } = await supabaseAdmin
          .from('attendance').update({
            late_minutes: r.late_minutes,
            early_arrival_minutes: r.early_arrival_minutes,
            early_leave_minutes: r.early_leave_minutes,
            status: r.status,
            note: newNote,
          }).eq('id', attRow.id);
        if (!updErr) {
          attendanceCascade = { attendance_id: attRow.id, changes: auditChanges };
        }
      }
    }
  } catch (cascadeErr) {
    console.error('[schedules/[id]] attendance cascade failed:', cascadeErr.message);
  }

  await writeLogAndMaybeNotify({
    schedule_id: existing.id,
    employee_id: existing.employee_id,
    work_date: existing.work_date,
    actorKind, isLateChange,
    before_data: existing, after_data: data,
    reason: req.body?.reason || null,
    callerId: caller.id || existing.employee_id,
  });

  return res.status(200).json({ schedule: data, isLateChange, attendance_cascade: attendanceCascade });
}

async function handleDelete(req, res, { existing, caller, actorKind, isLateChange }) {
  const { error } = await supabaseAdmin.from('schedules').delete().eq('id', existing.id);
  if (error) return res.status(500).json({ error: error.message });

  await writeLogAndMaybeNotify({
    schedule_id: existing.id,
    employee_id: existing.employee_id,
    work_date: existing.work_date,
    actorKind, isLateChange,
    before_data: existing, after_data: null,
    reason: req.body?.reason || null,
    callerId: caller.id || existing.employee_id,
  });

  return res.status(200).json({ deleted: true, isLateChange });
}

async function writeLogAndMaybeNotify({
  schedule_id, employee_id, work_date,
  actorKind, isLateChange,
  before_data, after_data, reason, callerId,
}) {
  try {
    await logScheduleChange(repoFromSupabase(), {
      schedule_id,
      employee_id,
      change_type: changeTypeFor(actorKind, isLateChange),
      changed_by: callerId,
      before_data,
      after_data,
      reason,
      isLateChange,
    });
  } catch (e) {
    console.error('[schedules/[id]] log failed:', e.message);
  }

  if (isLateChange) {
    // 補員工姓名(HR / CEO 看通知時要能辨識是誰)
    let empLabel = employee_id;
    try {
      const { data: emp } = await supabaseAdmin
        .from('employees').select('name').eq('id', employee_id).maybeSingle();
      if (emp?.name) empLabel = `${emp.name}(${employee_id})`;
    } catch (_) {}

    const payload = {
      title: '排班當日異動',
      body: `${empLabel} ${work_date} 排班於工作日當天被調整`,
      url: '/schedule',
      tag: 'late-change',
    };
    Promise.allSettled([
      sendPushToRoles(['hr', 'ceo'], payload),
      createNotificationsForRoles(['hr', 'ceo'], payload),
    ]).catch(() => {});
  }

  // C7-2:主管/HR 覆蓋員工 wish (ST003) → 通知員工
  // 含 DELETE:after_data === null 也算覆蓋
  if (actorKind !== 'employee' && before_data?.shift_type_id === 'ST003' && (after_data === null || after_data?.shift_type_id !== 'ST003')) {
    const wishPayload = {
      type: 'schedule',
      title: '主管已調整你的排班',
      body: `你 ${work_date} 的休假意願已改為班別`,
      url: '/employee-schedule.html',
      tag: `wish-overridden-${schedule_id}`,
    };
    Promise.allSettled([
      sendPushToEmployees([employee_id], wishPayload),
      createNotifications([employee_id], wishPayload),
    ]).catch(() => {});
  }
}

function changeTypeFor(actorKind, isLateChange) {
  if (isLateChange) return 'late_change';
  if (actorKind === 'employee') return 'employee_draft';
  return 'manager_adjust';
}

function repoFromSupabase() {
  return {
    async insertScheduleChangeLog(row) {
      const { data, error } = await supabaseAdmin
        .from('schedule_change_logs').insert([row]).select().single();
      if (error) throw error;
      return data;
    },
  };
}
