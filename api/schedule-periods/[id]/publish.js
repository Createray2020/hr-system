// api/schedule-periods/[id]/publish.js
// POST /api/schedule-periods/:id/publish
// C12-2：主管 公告班表（approved → published）、通知員工開始打卡
//
// Phase 2.x.3 修補:
//   - 拔 isBackofficeRole bypass
//   - 嚴格 dept+is_manager(對齊 approve.js)
//   - 加 self-approval guard
//   - 寫 published_by + published_at audit

import { supabaseAdmin } from '../../../lib/supabase.js';
import { requireAuth } from '../../../lib/auth.js';
import { canTransition } from '../../../lib/schedule/period-state.js';
import { logScheduleChange } from '../../../lib/schedule/change-logger.js';
import { sendPushToEmployees, createNotifications } from '../../../lib/push.js';

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

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const caller = await requireAuth(req, res);
  if (!caller) return;

  const id = req.query.id;
  if (!id) return res.status(400).json({ error: 'NO_PERIOD_ID' });

  // 撈 period
  const { data: period, error: pErr } = await supabaseAdmin
    .from('schedule_periods').select('*').eq('id', id).maybeSingle();
  if (pErr) return res.status(500).json({ error: pErr.message });
  if (!period) return res.status(404).json({ error: 'PERIOD_NOT_FOUND' });

  // Phase 2.x.3:self-approval guard
  if (caller.id && caller.id === period.employee_id) {
    return res.status(403).json({ error: 'CANNOT_PUBLISH_OWN_PERIOD' });
  }

  // Phase 2.x.3:嚴格 dept+is_manager(拔 isBackofficeRole bypass)
  if (caller.is_manager !== true || !caller.dept_id) {
    return res.status(403).json({ error: 'NOT_MANAGER', detail: '只有部門主管可公告' });
  }
  const { data: emp } = await supabaseAdmin
    .from('employees').select('dept_id').eq('id', period.employee_id).maybeSingle();
  const employeeDeptId = emp?.dept_id || null;
  if (!employeeDeptId || caller.dept_id !== employeeDeptId) {
    return res.status(403).json({
      error: 'NOT_SAME_DEPT',
      detail: '只有同部門主管可公告',
      employee_dept_id: employeeDeptId,
    });
  }

  // state transition：approved → published（actor key=is_manager）
  const tr = canTransition(period.status, 'publish', { is_manager: true });
  if (!tr.ok) return res.status(409).json({ error: tr.reason || 'INVALID_TRANSITION' });

  // update status (optimistic：避免 race) + Phase 2.x.3 published_by/at audit
  const now = new Date().toISOString();
  const { data: updated, error: uErr } = await supabaseAdmin
    .from('schedule_periods')
    .update({ status: tr.nextState, published_by: caller.id, published_at: now })
    .eq('id', id).eq('status', 'approved')
    .select().maybeSingle();
  if (uErr) return res.status(500).json({ error: uErr.message });
  if (!updated) return res.status(409).json({ error: 'STATUS_RACE_CONDITION' });

  // log
  try {
    await logScheduleChange(repoFromSupabase(), {
      schedule_id: null,
      employee_id: period.employee_id,
      change_type: 'manager_publish',
      changed_by: caller.id,
      before_data: { status: 'approved' },
      after_data: { status: 'published' },
      isLateChange: false,
    });
  } catch (logErr) {
    console.error('[publish] log failed:', logErr);
  }

  // 通知員工：班表已公告、可開始打卡
  try {
    const payload = {
      type: 'schedule',
      title: '排班已公告',
      body: `${period.period_start} 月份排班已公告、可開始打卡`,
      url: '/employee-schedule.html',
      tag: `schedule-published-${id}`,
    };
    Promise.allSettled([
      sendPushToEmployees([period.employee_id], payload),
      createNotifications([period.employee_id], payload),
    ]).catch(() => {});
  } catch (notifyErr) {
    console.error('[publish] notify failed:', notifyErr);
  }

  return res.status(200).json({ period: updated });
}
