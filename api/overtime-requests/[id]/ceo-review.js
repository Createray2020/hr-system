// api/overtime-requests/[id]/ceo-review.js
// POST  /api/overtime-requests/:id/ceo-review
// body: { decision: 'approved'|'rejected', note?, compensation_type? }
//
// CEO 審核超時案件(status='pending_ceo')。
//
// Phase 2.x.2 修補:
//   - 拔 admin 視同 CEO(嚴格 spec、admin 不能批 CEO 階)
//   - chairman 視同 ceo 保留
//   - approvals_v2_role_assignments fallback 保留(config 驅動的 ceo assignment)
//   - 加 self-approval guard:caller.id !== employee_id
//   - 加 cross-stage 連簽 guard:caller.id !== row.manager_id(同人不能 mgr + ceo 連簽)
//   - ceo_id 強制 caller.id、不接受 client 傳

import { requireAuth } from '../../../lib/auth.js';
import { canTransition } from '../../../lib/overtime/request-state.js';
import { convertOvertimeToCompTime } from '../../../lib/overtime/comp-conversion.js';
import { makeOvertimeRepo } from '../_repo.js';

const COMP_TYPES = new Set(['comp_leave', 'overtime_pay', 'undecided']);

async function isCallerCEO(caller) {
  // CEO 認定:role='ceo' 或 'chairman'(視同)、或 approvals_v2_role_assignments 配 'ceo'
  // Phase 2.x.2 嚴格 spec:admin **不**視同 CEO
  if (caller.role === 'ceo' || caller.role === 'chairman') return true;
  if (!caller.id) return false;
  try {
    const { supabaseAdmin } = await import('../../../lib/supabase.js');
    const { data } = await supabaseAdmin
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

  const caller = await requireAuth(req, res);
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

  // Phase 2.x.2:self-approval guard
  if (caller.id && caller.id === reqRow.employee_id) {
    return res.status(403).json({ error: 'CANNOT_REVIEW_OWN_REQUEST' });
  }

  // Phase 2.x.2:cross-stage 連簽 guard
  // 同人不能在 mgr 階段簽完又在 ceo 階段繼續簽(雙重 audit、防權力集中)
  if (caller.id && reqRow.manager_id && caller.id === reqRow.manager_id) {
    return res.status(403).json({
      error: 'CROSS_STAGE_SELF_REVIEW',
      detail: '你已在主管階段簽過、不可再審執行長階段',
    });
  }

  const isCEO = await isCallerCEO(caller);
  if (!isCEO) return res.status(403).json({ error: 'CEO only', your_role: caller.role });

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
    ceo_id: caller.id,                 // 強制 caller.id、不接受 client 傳
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
