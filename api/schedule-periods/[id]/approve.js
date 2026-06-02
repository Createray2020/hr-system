// api/schedule-periods/[id]/approve.js
// POST  /api/schedule-periods/:id/approve  → 主管定案 submitted → approved
//
// 對應設計文件：docs/attendance-system-design-v1.md §4.2.1
// 對應實作計畫：docs/attendance-system-implementation-plan-v1.md §5.8
//
// Phase 2.x.3 修補:
//   - 拔 isBackofficeRole bypass(原 HR/admin/CEO/chairman 任何 backoffice 都能批跨部門)
//   - 嚴格 dept+is_manager(對齊 leave canReview)
//   - 加 self-approval guard:caller.id !== period.employee_id
//   - 寫 approved_by = caller.id audit(原本 legacy 欄位有沒人寫)

import { supabaseAdmin } from '../../../lib/supabase.js';
import { requireAuth } from '../../../lib/auth.js';
import { canTransition } from '../../../lib/schedule/period-state.js';
import { isPeriodFullyScheduled } from '../../../lib/schedule/period-coverage.js';
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

  // Phase 2.x.3:self-approval guard(executive 也擋、不開)
  if (caller.id && caller.id === period.employee_id) {
    return res.status(403).json({ error: 'CANNOT_APPROVE_OWN_PERIOD' });
  }

  // executive(admin/chairman/ceo) bypass:跨部門可定案、不需要 is_manager
  const isExecutive = ['admin', 'chairman', 'ceo'].includes(caller.role);

  // 非 executive 先驗 is_manager(短路、避免 emp 撈失敗時把「非主管」case 推遲)
  if (!isExecutive && (caller.is_manager !== true || !caller.dept_id)) {
    return res.status(403).json({ error: 'NOT_MANAGER', detail: '只有部門主管可定案' });
  }

  // 撈員工 dept_id + employment_type(同部門比對 + F2 part_time 放寬都要)
  const { data: emp } = await supabaseAdmin
    .from('employees').select('dept_id, employment_type').eq('id', period.employee_id).maybeSingle();
  const employeeDeptId = emp?.dept_id || null;

  if (!isExecutive) {
    if (!employeeDeptId || caller.dept_id !== employeeDeptId) {
      return res.status(403).json({
        error: 'NOT_SAME_DEPT',
        detail: '只有同部門主管可定案',
        employee_dept_id: employeeDeptId,
      });
    }
  }

  const tr = canTransition(period.status, 'approve', { is_manager: true });
  if (!tr.ok) return res.status(409).json({ error: 'illegal transition', detail: tr.reason });

  // F2 守門:該 period 每一天必須有 ≥1 筆 schedules row(任意 shift_type、含休/例假)。
  // 撈法 .eq('period_id', id):直接 FK 對齊(同 publish.js + api/schedule-periods/index.js
  // 既有 pattern)。員工同月跨 period 是反常(schedule_periods UNIQUE),擋下逼清資料。
  // 兼職員工(part_time)放寬:本來就不是每天上班、只要求至少排到一天。
  const { data: scheds, error: schErr } = await supabaseAdmin
    .from('schedules').select('work_date').eq('period_id', id);
  if (schErr) return res.status(500).json({ error: schErr.message });
  const isPartTime = emp?.employment_type === 'part_time';
  if (isPartTime) {
    if ((scheds || []).length === 0) {
      return res.status(422).json({
        error: 'APPROVE_EMPTY_PERIOD',
        detail: '兼職員工至少需排一天才能公告',
        missingDates: [],
      });
    }
    // 有排到天數即可、跳過 full-coverage 檢查
  } else {
    const cov = isPeriodFullyScheduled(period, scheds || []);
    if (!cov.ok) {
      return res.status(422).json({
        error: 'APPROVE_EMPTY_PERIOD',
        detail: `缺少排班的日期:${cov.missingDates.join(', ')}`,
        missingDates: cov.missingDates,
      });
    }
  }

  const now = new Date().toISOString();
  const { data: updated, error: uErr } = await supabaseAdmin
    .from('schedule_periods')
    .update({ status: tr.nextState, approved_at: now, approved_by: caller.id })
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
