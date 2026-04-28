// api/schedule-periods/[id]/wish-deadline.js
// PUT /api/schedule-periods/:id/wish-deadline { wish_deadline: 'YYYY-MM-DD' | null }
// C6-2：HR/CEO/chairman/admin override 員工 wish 截止日（緊急工具、不限 period status）

import { supabaseAdmin } from '../../../lib/supabase.js';
import { requireAuth } from '../../../lib/auth.js';
import { isBackofficeRole } from '../../../lib/roles.js';
import { logScheduleChange } from '../../../lib/schedule/change-logger.js';

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
  if (req.method !== 'PUT') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const caller = await requireAuth(req, res);
  if (!caller) return;

  // C6-2：HR-only（不允許部門主管）
  if (!isBackofficeRole(caller)) {
    return res.status(403).json({ error: 'NOT_BACKOFFICE' });
  }

  const id = req.query.id || req.body?.id;
  if (!id) return res.status(400).json({ error: 'NO_PERIOD_ID' });

  // validate body.wish_deadline（允許 null 或 YYYY-MM-DD）
  const newDeadline = req.body?.wish_deadline;
  if (newDeadline !== null && newDeadline !== undefined) {
    if (typeof newDeadline !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(newDeadline)) {
      return res.status(400).json({ error: 'INVALID_WISH_DEADLINE' });
    }
  }

  // 撈 period 拿 oldDeadline
  const { data: period, error: pErr } = await supabaseAdmin
    .from('schedule_periods').select('*').eq('id', id).maybeSingle();
  if (pErr) return res.status(500).json({ error: pErr.message });
  if (!period) return res.status(404).json({ error: 'PERIOD_NOT_FOUND' });

  const oldDeadline = period.wish_deadline;

  // update
  const { data: updated, error: uErr } = await supabaseAdmin
    .from('schedule_periods')
    .update({ wish_deadline: newDeadline ?? null })
    .eq('id', id)
    .select()
    .maybeSingle();
  if (uErr) return res.status(500).json({ error: uErr.message });

  // log audit（best-effort）
  try {
    await logScheduleChange(repoFromSupabase(), {
      schedule_id: null,
      employee_id: period.employee_id,
      change_type: 'hr_override_wish_deadline',
      changed_by: caller.id,
      before_data: { wish_deadline: oldDeadline },
      after_data: { wish_deadline: newDeadline ?? null },
      isLateChange: false,
    });
  } catch (logErr) {
    console.error('[wish-deadline] log failed:', logErr);
  }

  return res.status(200).json({ period: updated });
}
