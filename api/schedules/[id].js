// api/schedules/[id].js
// PUT    /api/schedules/:id   → 修改一筆 schedule（新邏輯：算 isLateChange、寫 log）
// DELETE /api/schedules/:id   → 刪除一筆 schedule（新邏輯：寫 log）
//
// 對應設計文件：docs/attendance-system-design-v1.md §4.2.2 / §9.4
// 對應實作計畫：docs/attendance-system-implementation-plan-v1.md §5.8

import { supabaseAdmin } from '../../lib/supabase.js';
import { requireAuth } from '../../lib/auth.js';
import { isBackofficeRole } from '../../lib/roles.js';
import { canEmployeeEditSchedule, canManagerEditSchedule } from '../../lib/schedule/permissions.js';
import { logScheduleChange } from '../../lib/schedule/change-logger.js';
import { calculateScheduleWorkMinutes } from '../../lib/schedule/work-hours.js';
import { sendPushToRoles, createNotificationsForRoles } from '../../lib/push.js';

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
  } else {
    let manages = false;
    if (caller.is_manager === true && caller.id) {
      const { data: emp } = await supabaseAdmin.from('employees')
        .select('manager_id').eq('id', existing.employee_id).maybeSingle();
      manages = !!emp && emp.manager_id === caller.id;
    }
    const manager = {
      id: caller.id, role: caller.role,
      is_manager: caller.is_manager === true,
      manages_employee_id: manages ? existing.employee_id : null,
    };
    const r = canManagerEditSchedule(period, manager, today);
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

  await writeLogAndMaybeNotify({
    schedule_id: existing.id,
    employee_id: existing.employee_id,
    work_date: existing.work_date,
    actorKind, isLateChange,
    before_data: existing, after_data: data,
    reason: req.body?.reason || null,
    callerId: caller.id || existing.employee_id,
  });

  return res.status(200).json({ schedule: data, isLateChange });
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
    const payload = {
      title: '排班當日異動',
      body: `${employee_id} ${work_date} 排班於工作日當天被調整`,
      url: '/schedule',
      tag: 'late-change',
    };
    Promise.allSettled([
      sendPushToRoles(['hr', 'ceo'], payload),
      createNotificationsForRoles(['hr', 'ceo'], payload),
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
