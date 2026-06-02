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
import { isPeriodFullyScheduled } from '../../../lib/schedule/period-coverage.js';
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

  // Phase 2.x.3:self-approval guard(executive 也擋、不開)
  if (caller.id && caller.id === period.employee_id) {
    return res.status(403).json({ error: 'CANNOT_PUBLISH_OWN_PERIOD' });
  }

  // executive(admin/chairman/ceo) bypass:跨部門可公告、不需要 is_manager
  const isExecutive = ['admin', 'chairman', 'ceo'].includes(caller.role);

  // 非 executive 先驗 is_manager,避免下面為了同部門比對而做 emp 撈時、把「非主管」case
  // 推遲到 emp 撈完才擋(同時讓 mock 在此分支不需要 employees 表)
  if (!isExecutive && (caller.is_manager !== true || !caller.dept_id)) {
    return res.status(403).json({ error: 'NOT_MANAGER', detail: '只有部門主管可公告' });
  }

  // 撈員工 dept_id + employment_type(同部門比對 + F2 part_time 放寬都要)
  const { data: emp } = await supabaseAdmin
    .from('employees').select('dept_id, employment_type').eq('id', period.employee_id).maybeSingle();
  const employeeDeptId = emp?.dept_id || null;

  if (!isExecutive) {
    if (!employeeDeptId || caller.dept_id !== employeeDeptId) {
      return res.status(403).json({
        error: 'NOT_SAME_DEPT',
        detail: '只有同部門主管可公告',
        employee_dept_id: employeeDeptId,
      });
    }
  }

  // state transition：approved → published（actor key=is_manager）
  const tr = canTransition(period.status, 'publish', { is_manager: true });
  if (!tr.ok) return res.status(409).json({ error: tr.reason || 'INVALID_TRANSITION' });

  // F2 守門:該 period 每一天必須有 ≥1 筆 schedules row(任意 shift_type、含休/例假)。
  // 撈法用 .eq('period_id', id):直接 FK 對齊、跟 api/schedule-periods/index.js:61
  // 的 .in('period_id', ...) 同 pattern,語意精準(這個 period 的 schedules)。
  // 員工同月跨 period 是反常狀態(schedule_periods UNIQUE 保證一員工一月一 row),
  // option A 寧可擋下逼清資料、不寬鬆放行。
  // 兼職員工(part_time)放寬:本來就不是每天上班、只要求至少排到一天。
  const { data: scheds, error: schErr } = await supabaseAdmin
    .from('schedules').select('work_date').eq('period_id', id);
  if (schErr) return res.status(500).json({ error: schErr.message });
  const isPartTime = emp?.employment_type === 'part_time';
  if (isPartTime) {
    if ((scheds || []).length === 0) {
      return res.status(422).json({
        error: 'PUBLISH_EMPTY_PERIOD',
        detail: '兼職員工至少需排一天才能公告',
        missingDates: [],
      });
    }
    // 有排到天數即可、跳過 full-coverage 檢查
  } else {
    const cov = isPeriodFullyScheduled(period, scheds || []);
    if (!cov.ok) {
      return res.status(422).json({
        error: 'PUBLISH_EMPTY_PERIOD',
        detail: `缺少排班的日期:${cov.missingDates.join(', ')}`,
        missingDates: cov.missingDates,
      });
    }
  }

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
