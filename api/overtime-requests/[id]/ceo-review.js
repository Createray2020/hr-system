// api/overtime-requests/[id]/ceo-review.js
// POST  /api/overtime-requests/:id/ceo-review
// body: { decision: 'approved'|'rejected', note?, compensation_type? }
//
// CEO 審核超時案件(status='pending_ceo')。

import { requireRoleOrPass } from '../../../lib/auth.js';
import { canTransition } from '../../../lib/overtime/request-state.js';
import { convertOvertimeToCompTime } from '../../../lib/overtime/comp-conversion.js';
import { makeOvertimeRepo } from '../_repo.js';

const COMP_TYPES = new Set(['comp_leave', 'overtime_pay', 'undecided']);

async function isCallerCEO(repo, caller) {
  // CEO 認定:role='ceo' 或 approvals_v2_role_assignments 中 role='ceo' 的成員
  if (caller.role === 'ceo') return true;
  if (caller.role === 'admin') return true;  // admin 視同 CEO
  if (!caller.id) return false;
  try {
    const { supabase } = await import('../../../lib/supabase.js');
    const { data } = await supabase
      .from('approvals_v2_role_assignments')
      .select('user_id').eq('role', 'ceo').eq('user_id', caller.id).maybeSingle();
    return !!data;
  } catch (e) {
    return false;
  }
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const caller = await requireRoleOrPass(req, res, []);
  if (!caller) return;

  const id = req.query.id;
  if (!id) return res.status(400).json({ error: 'request id required' });

  const { decision, note, compensation_type } = req.body || {};
  if (!['approved', 'rejected'].includes(decision)) {
    return res.status(400).json({ error: 'decision must be approved / rejected' });
  }
  if (compensation_type !== undefined && !COMP_TYPES.has(compensation_type)) {
    return res.status(400).json({ error: 'invalid compensation_type' });
  }

  const repo = makeOvertimeRepo();
  const reqRow = await repo.findOvertimeRequestById(id);
  if (!reqRow) return res.status(404).json({ error: 'request not found' });

  const isCEO = await isCallerCEO(repo, caller);
  if (!isCEO) return res.status(403).json({ error: 'CEO only' });

  const action = decision === 'approved' ? 'ceo_approve' : 'ceo_reject';
  const tr = canTransition(reqRow.status, action, { is_ceo: true }, {
    is_over_limit: reqRow.is_over_limit === true,
  });
  if (!tr.ok) return res.status(409).json({ error: 'illegal transition', detail: tr.reason });

  // CEO 也可改 compensation_type(若仍 undecided 必須在此指定)
  let finalCompType = reqRow.compensation_type;
  if (decision === 'approved' && reqRow.compensation_type === 'undecided') {
    if (!compensation_type || compensation_type === 'undecided') {
      return res.status(400).json({
        error: 'COMPENSATION_TYPE_REQUIRED',
        detail: 'compensation_type=undecided 時 CEO 核准必須指定 comp_leave 或 overtime_pay',
      });
    }
    finalCompType = compensation_type;
  } else if (compensation_type && compensation_type !== reqRow.compensation_type) {
    finalCompType = compensation_type;
  }

  const now = new Date().toISOString();
  const patch = {
    status: tr.nextState,
    ceo_id: caller.id || null,
    ceo_reviewed_at: now,
    ceo_decision: decision,
    ceo_note: note || null,
    compensation_type: finalCompType,
  };
  if (decision === 'rejected') patch.reject_reason = note || null;

  const updated = await repo.updateOvertimeRequest(id, patch);

  let comp_balance = null;
  if (tr.nextState === 'approved' && finalCompType === 'comp_leave') {
    try {
      comp_balance = await convertOvertimeToCompTime(repo, updated);
    } catch (e) {
      console.error('[overtime:ceo-review] convertOvertimeToCompTime failed:', e.message);
    }
  }

  return res.status(200).json({ request: updated, comp_balance });
}
