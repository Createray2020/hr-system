// api/schedule-periods/[id]/unpublish.js
// POST /api/schedule-periods/:id/unpublish
// F3:主管 / admin / chairman 撤回公告(published → approved)、通知員工
//
// 反向版骨架對齊 publish.js,但:
//   - 權限放寬:admin / chairman / 同部門主管 三選一(endpoint 層擋,純函式 RULES
//     仍只認 is_manager 布林、endpoint 算完轉成 { is_manager: true } 傳進去)
//   - 不需要 F2 守門(撤回是反向、period 早已有 schedules)
//   - 決策 4:published_by / published_at 保留、不在 update patch 內動
//     audit 保留「最近一次公告者」,完整時間軸仍由 schedule_change_logs 記
//   - log change_type='manager_unpublish'(對應 migration
//     2026_05_28_add_manager_unpublish_change_type.sql 已擴 CHECK)

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

const UNPUBLISH_ALLOWED_ROLES = ['admin', 'chairman'];

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

  // self-approval guard(對齊 publish.js,即使你是同部門主管也不能撤回自己的 period)
  if (caller.id && caller.id === period.employee_id) {
    return res.status(403).json({ error: 'CANNOT_UNPUBLISH_OWN_PERIOD' });
  }

  // 權限(方案 a、endpoint 層擋):admin / chairman / 同部門主管 三選一
  //   admin / chairman:不分 dept 都可(跨部門 bypass)
  //   主管:必須同部門(對齊 publish.js NOT_SAME_DEPT 嚴格設計)
  let authorized = UNPUBLISH_ALLOWED_ROLES.includes(caller.role);
  if (!authorized && caller.is_manager === true && caller.dept_id) {
    const { data: emp } = await supabaseAdmin
      .from('employees').select('dept_id').eq('id', period.employee_id).maybeSingle();
    const employeeDeptId = emp?.dept_id || null;
    authorized = !!employeeDeptId && caller.dept_id === employeeDeptId;
  }
  if (!authorized) {
    return res.status(403).json({
      error: 'NOT_AUTHORIZED',
      detail: '撤回公告限 admin / chairman / 同部門主管',
    });
  }

  // state transition:published → approved(actorKey='is_manager'、純函式不知道 role 細節)
  const tr = canTransition(period.status, 'unpublish', { is_manager: true });
  if (!tr.ok) return res.status(409).json({ error: tr.reason || 'INVALID_TRANSITION' });

  // optimistic update(only status,published_by / published_at 保留 — 決策 4)
  // WHERE status='published' 防 race(同時被別人 unpublish / 再 publish)
  const { data: updated, error: uErr } = await supabaseAdmin
    .from('schedule_periods')
    .update({ status: tr.nextState })
    .eq('id', id).eq('status', 'published')
    .select().maybeSingle();
  if (uErr) return res.status(500).json({ error: uErr.message });
  if (!updated) return res.status(409).json({ error: 'STATUS_RACE_CONDITION' });

  // log audit(change_type='manager_unpublish'、單一值靠 changed_by 區辨角色)
  try {
    await logScheduleChange(repoFromSupabase(), {
      schedule_id: null,
      employee_id: period.employee_id,
      change_type: 'manager_unpublish',
      changed_by: caller.id,   // 強制 caller.id、不接受 client 傳 body.changed_by
      before_data: { status: 'published' },
      after_data:  { status: 'approved'  },
      isLateChange: false,
    });
  } catch (logErr) {
    console.error('[unpublish] log failed:', logErr);
  }

  // 通知員工:班表已撤回、待主管重新調整後公告
  try {
    const payload = {
      type: 'schedule',
      title: '排班已撤回',
      body: `${period.period_start} 月份排班已撤回、待主管重新調整後公告`,
      url: '/employee-schedule.html',
      tag: `schedule-unpublished-${id}`,    // 跟 publish 用 'schedule-published-X' 區隔
    };
    Promise.allSettled([
      sendPushToEmployees([period.employee_id], payload),
      createNotifications([period.employee_id], payload),
    ]).catch(() => {});
  } catch (notifyErr) {
    console.error('[unpublish] notify failed:', notifyErr);
  }

  return res.status(200).json({ period: updated });
}
