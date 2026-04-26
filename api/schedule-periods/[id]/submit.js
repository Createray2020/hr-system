// api/schedule-periods/[id]/submit.js
// POST  /api/schedule-periods/:id/submit  → 員工送出 draft → submitted
//
// 對應設計文件：docs/attendance-system-design-v1.md §4.2.1
// 對應實作計畫：docs/attendance-system-implementation-plan-v1.md §5.8

import { supabase } from '../../../lib/supabase.js';
import { requireRoleOrPass } from '../../../lib/auth.js';
import { canTransition } from '../../../lib/schedule/period-state.js';
import { logScheduleChange } from '../../../lib/schedule/change-logger.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const caller = await requireRoleOrPass(req, res, []);
  if (!caller) return;

  const id = req.query.id || req.body?.id;
  if (!id) return res.status(400).json({ error: 'period id required' });

  const { data: period, error: pErr } = await supabase
    .from('schedule_periods').select('*').eq('id', id).maybeSingle();
  if (pErr) return res.status(500).json({ error: pErr.message });
  if (!period) return res.status(404).json({ error: 'period not found' });

  // 必須是 employee 本人
  if (caller.id && period.employee_id !== caller.id) {
    return res.status(403).json({ error: 'not own period' });
  }

  // 必須有至少一筆 schedules
  const { count: schedCount, error: cErr } = await supabase
    .from('schedules').select('id', { count: 'exact', head: true }).eq('period_id', id);
  if (cErr) return res.status(500).json({ error: cErr.message });
  if (!schedCount || schedCount === 0) {
    return res.status(400).json({ error: 'period has no schedules — fill at least one before submit' });
  }

  // 狀態機檢查
  const tr = canTransition(period.status, 'submit', { is_employee_self: true });
  if (!tr.ok) return res.status(409).json({ error: 'illegal transition', detail: tr.reason });

  const now = new Date().toISOString();
  const { data: updated, error: uErr } = await supabase
    .from('schedule_periods')
    .update({ status: tr.nextState, submitted_at: now, updated_at: now })
    .eq('id', id).eq('status', 'draft') // optimistic：避免 race
    .select().maybeSingle();
  if (uErr) return res.status(500).json({ error: uErr.message });
  if (!updated) return res.status(409).json({ error: 'state changed concurrently' });

  // 寫 log（best-effort，不阻塞回應）
  try {
    await logScheduleChange(repoFromSupabase(), {
      schedule_id: null,
      employee_id: period.employee_id,
      change_type: 'employee_submit',
      changed_by: caller.id || period.employee_id,
      before_data: { status: 'draft' },
      after_data:  { status: 'submitted' },
      reason: null,
      isLateChange: false,
    });
  } catch (e) {
    console.error('[schedule-periods/submit] logScheduleChange failed:', e.message);
  }

  return res.status(200).json({ period: updated });
}

function repoFromSupabase() {
  return {
    async insertScheduleChangeLog(row) {
      const { data, error } = await supabase
        .from('schedule_change_logs').insert([row]).select().single();
      if (error) throw error;
      return data;
    },
  };
}
