// api/schedule-periods/[id]/force-finalize.js
// POST /api/schedule-periods/:id/force-finalize
//
// 時間閘門「強制公告排班」:員工未在截止前送出時,主管/CEO 一刀把 period 推到
// published、補完 audit 欄、通知員工、寫 3 筆 change_log 帶 [FORCE] reason。
//
// 授權:lib/schedule/finalize-auth.js forceFinalizeAuth(時間 + 角色雙條件)。
// 守門:isPeriodFullyScheduled(沿用 approve/publish 同款,沒填滿不公告)。
// 狀態:逐步 canTransition 驗合法性(reducer 純函式、不檢權限);實際授權上面已過。
//
// 不影響任何現有 endpoint(submit/approve/publish/unpublish)。

import { supabaseAdmin } from '../../../lib/supabase.js';
import { requireAuth } from '../../../lib/auth.js';
import { canTransition } from '../../../lib/schedule/period-state.js';
import { isPeriodFullyScheduled } from '../../../lib/schedule/period-coverage.js';
import { logScheduleChange } from '../../../lib/schedule/change-logger.js';
import { forceFinalizeAuth } from '../../../lib/schedule/finalize-auth.js';
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

// 台北今日 YYYY-MM-DD(+08 偏移,避時區)
function taipeiTodayStr() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const caller = await requireAuth(req, res);
  if (!caller) return;

  const id = req.query.id || req.body?.id;
  if (!id) return res.status(400).json({ error: 'NO_PERIOD_ID' });

  // 撈 period
  const { data: period, error: pErr } = await supabaseAdmin
    .from('schedule_periods').select('*').eq('id', id).maybeSingle();
  if (pErr) return res.status(500).json({ error: pErr.message });
  if (!period) return res.status(404).json({ error: 'PERIOD_NOT_FOUND' });

  // 撈員工 dept_id + employment_type(同 approve.js / publish.js pattern)
  const { data: emp } = await supabaseAdmin
    .from('employees').select('dept_id, employment_type').eq('id', period.employee_id).maybeSingle();
  const employeeDeptId = emp?.dept_id || null;

  // 時間閘門 + 角色授權
  const now = taipeiTodayStr();
  const auth = forceFinalizeAuth({ caller, period, employeeDeptId, now });
  if (!auth.ok) {
    return res.status(403).json({ error: auth.reason });
  }

  // 已 published / locked → no-op(讓前端按錯也安全)
  if (period.status === 'published' || period.status === 'locked') {
    return res.status(200).json({ ok: true, status: period.status, note: '已公告' });
  }

  // F2 守門:每天 ≥1 筆 schedules row(同 approve/publish)
  // 兼職員工(part_time)放寬:本來就不是每天上班、只要求至少排到一天。
  const { data: scheds, error: schErr } = await supabaseAdmin
    .from('schedules').select('work_date').eq('period_id', id);
  if (schErr) return res.status(500).json({ error: schErr.message });
  const isPartTime = emp?.employment_type === 'part_time';
  if (isPartTime) {
    if ((scheds || []).length === 0) {
      return res.status(422).json({
        error: 'FORCE_EMPTY_PERIOD',
        detail: '兼職員工至少需排一天才能公告',
        missingDates: [],
      });
    }
    // 有排到天數即可、跳過 full-coverage 檢查
  } else {
    const cov = isPeriodFullyScheduled(period, scheds || []);
    if (!cov.ok) {
      return res.status(422).json({
        error: 'FORCE_EMPTY_PERIOD',
        detail: `缺少排班的日期:${cov.missingDates.join(', ')}`,
        missingDates: cov.missingDates,
      });
    }
  }

  // walk 到 published — reducer 純驗轉移合法性(實際授權上面 forceFinalizeAuth 已過)。
  // 每步先 canTransition 確認後寫 1 筆 change_log,reason 帶 [FORCE] tier caller。
  const tier = auth.tier;
  const reason = `[FORCE] tier=${tier} caller=${caller.id}`;
  const logRepo = repoFromSupabase();
  let cur = period.status;

  if (cur === 'draft') {
    const tr = canTransition(cur, 'submit', { is_employee_self: true });
    if (!tr.ok) return res.status(409).json({ error: 'INVALID_TRANSITION', step: 'submit', detail: tr.reason });
    try {
      await logScheduleChange(logRepo, {
        schedule_id: null,
        employee_id: period.employee_id,
        change_type: 'employee_submit',
        changed_by: caller.id,
        before_data: { status: 'draft' },
        after_data:  { status: 'submitted' },
        reason,
        isLateChange: false,
      });
    } catch (e) { console.error('[force-finalize] submit log failed:', e.message); }
    cur = 'submitted';
  }

  if (cur === 'submitted') {
    const tr = canTransition(cur, 'approve', { is_manager: true });
    if (!tr.ok) return res.status(409).json({ error: 'INVALID_TRANSITION', step: 'approve', detail: tr.reason });
    try {
      await logScheduleChange(logRepo, {
        schedule_id: null,
        employee_id: period.employee_id,
        change_type: 'manager_approve',
        changed_by: caller.id,
        before_data: { status: 'submitted' },
        after_data:  { status: 'approved' },
        reason,
        isLateChange: false,
      });
    } catch (e) { console.error('[force-finalize] approve log failed:', e.message); }
    cur = 'approved';
  }

  if (cur === 'approved') {
    const tr = canTransition(cur, 'publish', { is_manager: true });
    if (!tr.ok) return res.status(409).json({ error: 'INVALID_TRANSITION', step: 'publish', detail: tr.reason });
    try {
      await logScheduleChange(logRepo, {
        schedule_id: null,
        employee_id: period.employee_id,
        change_type: 'manager_publish',
        changed_by: caller.id,
        before_data: { status: 'approved' },
        after_data:  { status: 'published' },
        reason,
        isLateChange: false,
      });
    } catch (e) { console.error('[force-finalize] publish log failed:', e.message); }
    cur = 'published';
  }

  // 一次 UPDATE:補齊所有 audit 欄(已有的不覆蓋)
  const nowIso = new Date().toISOString();
  const patch = {
    status: 'published',
    submitted_at: period.submitted_at || nowIso,
    approved_at:  period.approved_at  || nowIso,
    approved_by:  period.approved_by  || caller.id,
    published_at: nowIso,
    published_by: caller.id,
  };
  const { data: updated, error: uErr } = await supabaseAdmin
    .from('schedule_periods')
    .update(patch)
    .eq('id', id)
    .in('status', ['draft', 'submitted', 'approved'])  // optimistic:避 race 到 published/locked
    .select().maybeSingle();
  if (uErr) return res.status(500).json({ error: uErr.message });
  if (!updated) return res.status(409).json({ error: 'STATE_RACED' });

  // 通知員工(同 publish.js L113-128,只換 title/body/tag 成強制語境)
  try {
    const payload = {
      type: 'schedule',
      title: '強制公告排班',
      body: `未在截止前提交、HR 已代為公告 ${period.period_start} 月排班、可開始打卡`,
      url: '/employee-schedule.html',
      tag: `schedule-force-published-${id}`,
    };
    Promise.allSettled([
      sendPushToEmployees([period.employee_id], payload),
      createNotifications([period.employee_id], payload),
    ]).catch(() => {});
  } catch (notifyErr) {
    console.error('[force-finalize] notify failed:', notifyErr);
  }

  return res.status(200).json({ ok: true, status: 'published', tier });
}
