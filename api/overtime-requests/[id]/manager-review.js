// api/overtime-requests/[id]/manager-review.js
// POST  /api/overtime-requests/:id/manager-review
// body: { decision: 'approved'|'rejected', note?, compensation_type? }
//
// 流程(規範 §9.6):
//   1. 驗證 actor 是該員工的主管 / HR
//   2. canTransition:依 is_over_limit 決定 next state
//   3. compensation_type='undecided' 時 body 可帶 compensation_type 改寫
//   4. UPDATE overtime_requests:status / manager_id / manager_reviewed_at / manager_decision / manager_note
//   5. 若直接 approved + comp_leave → 觸發 convertOvertimeToCompTime

import { requireAuth } from '../../../lib/auth.js';
import { canTransition } from '../../../lib/overtime/request-state.js';
import { convertOvertimeToCompTime } from '../../../lib/overtime/comp-conversion.js';
import { makeOvertimeRepo } from '../_repo.js';

const COMP_TYPES = new Set(['comp_leave', 'overtime_pay', 'undecided']);

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

  // 主管權限:該員工 manager_id == caller.id 或 caller is HR
  const isHR = ['hr', 'admin', 'ceo'].includes(caller.role || '');
  let isDirectManager = false;
  if (caller.id) {
    const emp = await repo.findEmployeeManager(reqRow.employee_id);
    isDirectManager = !!emp && emp.manager_id === caller.id;
  }
  if (!isHR && !isDirectManager) {
    return res.status(403).json({ error: 'not manager or HR' });
  }

  // 狀態機
  const action = decision === 'approved' ? 'manager_approve' : 'manager_reject';
  const tr = canTransition(reqRow.status, action, { is_manager: true }, {
    is_over_limit: reqRow.is_over_limit === true,
  });
  if (!tr.ok) return res.status(409).json({ error: 'illegal transition', detail: tr.reason });

  // 決定最終 compensation_type
  let finalCompType = reqRow.compensation_type;
  if (decision === 'approved' && reqRow.compensation_type === 'undecided') {
    if (!compensation_type || compensation_type === 'undecided') {
      return res.status(400).json({
        error: 'COMPENSATION_TYPE_REQUIRED',
        detail: 'compensation_type=undecided 時主管核准必須指定 comp_leave 或 overtime_pay',
      });
    }
    finalCompType = compensation_type;
  } else if (compensation_type && compensation_type !== reqRow.compensation_type) {
    // 主管也可改寫
    finalCompType = compensation_type;
  }

  const now = new Date().toISOString();
  const patch = {
    status: tr.nextState,
    manager_id: caller.id || null,
    manager_reviewed_at: now,
    manager_decision: decision,
    manager_note: note || null,
    compensation_type: finalCompType,
  };
  if (decision === 'rejected') patch.reject_reason = note || null;

  const updated = await repo.updateOvertimeRequest(id, patch);

  // 若直接 approved 且 comp_leave → 觸發轉換補休
  let comp_balance = null;
  if (tr.nextState === 'approved' && finalCompType === 'comp_leave') {
    try {
      comp_balance = await convertOvertimeToCompTime(repo, updated);
    } catch (e) {
      console.error('[overtime:manager-review] convertOvertimeToCompTime failed:', e.message);
    }
  }

  return res.status(200).json({ request: updated, comp_balance });
}
