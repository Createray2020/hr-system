// api/overtime-requests/[id]/cancel.js
// POST  /api/overtime-requests/:id/cancel
// 員工本人在 status='pending' 時撤回。

import { requireRoleOrPass } from '../../../lib/auth.js';
import { canTransition } from '../../../lib/overtime/request-state.js';
import { makeOvertimeRepo } from '../_repo.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const caller = await requireRoleOrPass(req, res, []);
  if (!caller) return;

  const id = req.query.id;
  if (!id) return res.status(400).json({ error: 'request id required' });

  const repo = makeOvertimeRepo();
  const reqRow = await repo.findOvertimeRequestById(id);
  if (!reqRow) return res.status(404).json({ error: 'request not found' });

  // 必須是員工本人
  if (caller.id && reqRow.employee_id !== caller.id) {
    return res.status(403).json({ error: 'not own request' });
  }

  const tr = canTransition(reqRow.status, 'cancel', { is_employee_self: true }, {
    is_over_limit: reqRow.is_over_limit === true,
  });
  if (!tr.ok) return res.status(409).json({ error: 'illegal transition', detail: tr.reason });

  const updated = await repo.updateOvertimeRequest(id, {
    status: tr.nextState,
  });
  return res.status(200).json({ request: updated });
}
