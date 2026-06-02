// api/schedule-periods/[id]/unlock.js
// POST /api/schedule-periods/:id/unlock
// executive(admin / chairman / ceo) 解鎖鎖定 period(locked → approved)、通知員工
//
// 骨架對齊 unpublish.js,但:
//   - 權限收緊:只開給 admin / chairman / ceo;同部門主管不能 unlock(避免主管自行繞過 cron lock)
//   - 入口 status='locked'(不是 published)
//   - update patch 清 locked_at=null;published_by / published_at 保留不動(audit「最近一次公告者」)
//   - log change_type='executive_unlock'(對應 migration 2026_06_02_add_executive_unlock_change_type.sql)

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

const UNLOCK_ALLOWED_ROLES = ['admin', 'chairman', 'ceo'];

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

  // self-guard:即使是 executive,也不能 unlock 自己的 period
  if (caller.id && caller.id === period.employee_id) {
    return res.status(403).json({ error: 'CANNOT_UNLOCK_OWN_PERIOD' });
  }

  // 權限:只開給 admin / chairman / ceo(主管不能 unlock、避免繞過 cron lock)
  if (!UNLOCK_ALLOWED_ROLES.includes(caller.role)) {
    return res.status(403).json({
      error: 'NOT_AUTHORIZED',
      detail: '解鎖限 admin / chairman / ceo',
    });
  }

  // state transition:locked → approved(actorKey='is_executive')
  const tr = canTransition(period.status, 'unlock', { is_executive: true });
  if (!tr.ok) return res.status(409).json({ error: tr.reason || 'INVALID_TRANSITION' });

  // optimistic update:status='approved' + locked_at=NULL;published_by / published_at 保留
  const { data: updated, error: uErr } = await supabaseAdmin
    .from('schedule_periods')
    .update({ status: tr.nextState, locked_at: null })
    .eq('id', id).eq('status', 'locked')
    .select().maybeSingle();
  if (uErr) return res.status(500).json({ error: uErr.message });
  if (!updated) return res.status(409).json({ error: 'STATUS_RACE_CONDITION' });

  // log audit
  try {
    await logScheduleChange(repoFromSupabase(), {
      schedule_id: null,
      employee_id: period.employee_id,
      change_type: 'executive_unlock',
      changed_by: caller.id,
      before_data: { status: 'locked' },
      after_data:  { status: 'approved' },
      isLateChange: false,
    });
  } catch (logErr) {
    console.error('[unlock] log failed:', logErr);
  }

  // 通知員工:排班已解鎖、重新進入編輯
  try {
    const payload = {
      type: 'schedule',
      title: '排班已解鎖',
      body: `${period.period_start} 月份排班已解鎖、待主管重新調整後公告`,
      url: '/employee-schedule.html',
      tag: `schedule-unlocked-${id}`,
    };
    Promise.allSettled([
      sendPushToEmployees([period.employee_id], payload),
      createNotifications([period.employee_id], payload),
    ]).catch(() => {});
  } catch (notifyErr) {
    console.error('[unlock] notify failed:', notifyErr);
  }

  return res.status(200).json({ period: updated });
}
