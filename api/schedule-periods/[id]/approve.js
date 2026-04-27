// api/schedule-periods/[id]/approve.js
// POST  /api/schedule-periods/:id/approve  → 主管定案 submitted → approved
//
// 對應設計文件：docs/attendance-system-design-v1.md §4.2.1
// 對應實作計畫：docs/attendance-system-implementation-plan-v1.md §5.8

import { supabase } from '../../../lib/supabase.js';
import { requireAuth } from '../../../lib/auth.js';
import { canTransition } from '../../../lib/schedule/period-state.js';
import { logScheduleChange } from '../../../lib/schedule/change-logger.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const caller = await requireAuth(req, res);
  if (!caller) return;

  const id = req.query.id || req.body?.id;
  if (!id) return res.status(400).json({ error: 'period id required' });

  const { data: period, error: pErr } = await supabase
    .from('schedule_periods').select('*').eq('id', id).maybeSingle();
  if (pErr) return res.status(500).json({ error: pErr.message });
  if (!period) return res.status(404).json({ error: 'period not found' });

  // 必須是該員工的主管或 HR
  const isHR = ['hr', 'admin', 'ceo'].includes(caller.role || '');
  let isDirectManager = false;
  if (caller.is_manager === true && caller.id) {
    const { data: emp } = await supabase
      .from('employees').select('manager_id').eq('id', period.employee_id).maybeSingle();
    isDirectManager = !!emp && emp.manager_id === caller.id;
  }
  if (!isHR && !isDirectManager) {
    return res.status(403).json({ error: 'not manager or HR' });
  }

  const tr = canTransition(period.status, 'approve', { is_manager: true });
  if (!tr.ok) return res.status(409).json({ error: 'illegal transition', detail: tr.reason });

  const now = new Date().toISOString();
  const { data: updated, error: uErr } = await supabase
    .from('schedule_periods')
    .update({ status: tr.nextState, approved_at: now, updated_at: now })
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
