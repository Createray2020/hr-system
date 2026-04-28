// api/schedule-periods/[id]/approve.js
// POST  /api/schedule-periods/:id/approve  → 主管定案 submitted → approved
//
// 對應設計文件：docs/attendance-system-design-v1.md §4.2.1
// 對應實作計畫：docs/attendance-system-implementation-plan-v1.md §5.8

import { supabaseAdmin } from '../../../lib/supabase.js';
import { requireAuth } from '../../../lib/auth.js';
import { isBackofficeRole } from '../../../lib/roles.js';
import { canTransition } from '../../../lib/schedule/period-state.js';
import { logScheduleChange } from '../../../lib/schedule/change-logger.js';
import { sendPushToEmployees, createNotifications } from '../../../lib/push.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const caller = await requireAuth(req, res);
  if (!caller) return;

  const id = req.query.id || req.body?.id;
  if (!id) return res.status(400).json({ error: 'period id required' });

  const { data: period, error: pErr } = await supabaseAdmin
    .from('schedule_periods').select('*').eq('id', id).maybeSingle();
  if (pErr) return res.status(500).json({ error: pErr.message });
  if (!period) return res.status(404).json({ error: 'period not found' });

  // 必須是同部門主管或 HR
  const isHR = isBackofficeRole(caller);
  let isInSameDept = false;
  if (caller.is_manager === true && caller.dept_id) {
    const { data: emp } = await supabaseAdmin
      .from('employees').select('dept_id').eq('id', period.employee_id).maybeSingle();
    isInSameDept = !!emp && emp.dept_id === caller.dept_id;
  }
  if (!isHR && !isInSameDept) {
    return res.status(403).json({ error: 'not in same dept or HR' });
  }

  const tr = canTransition(period.status, 'approve', { is_manager: true });
  if (!tr.ok) return res.status(409).json({ error: 'illegal transition', detail: tr.reason });

  const now = new Date().toISOString();
  const { data: updated, error: uErr } = await supabaseAdmin
    .from('schedule_periods')
    .update({ status: tr.nextState, approved_at: now })
    .eq('id', id).eq('status', 'submitted')
    .select().maybeSingle();
  if (uErr) return res.status(500).json({ error: uErr.message });
  if (!updated) return res.status(409).json({ error: 'state changed concurrently' });

  try {
    await logScheduleChange(repoFromSupabase(), {
      schedule_id: null,
      employee_id: period.employee_id,
      change_type: 'manager_approve',
      changed_by: caller.id || period.employee_id,
      before_data: { status: 'submitted' },
      after_data:  { status: 'approved' },
      reason: null,
      isLateChange: false,
    });
  } catch (e) {
    console.error('[schedule-periods/approve] logScheduleChange failed:', e.message);
  }

  // C7-3:approve period → 通知員工本人
  try {
    const wishPayload = {
      type: 'schedule',
      title: '你的排班已公告',
      body: `${period.period_start} 月份排班已確認、可開始打卡`,
      url: '/employee-schedule.html',
      tag: `schedule-approved-${id}`,
    };
    Promise.allSettled([
      sendPushToEmployees([period.employee_id], wishPayload),
      createNotifications([period.employee_id], wishPayload),
    ]).catch(() => {});
  } catch (notifyErr) {
    console.error('[approve] notify failed:', notifyErr);
  }

  return res.status(200).json({ period: updated });
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
