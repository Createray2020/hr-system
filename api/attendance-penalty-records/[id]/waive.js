// api/attendance-penalty-records/[id]/waive.js
// POST  /api/attendance-penalty-records/:id/waive
// body: { waive_reason }
//
// HR / admin 才能呼叫。UPDATE attendance_penalty_records SET status='waived'。

import { requireRole } from '../../../lib/auth.js';
import { BACKOFFICE_ROLES } from '../../../lib/roles.js';
import { makeAttendancePenaltyRepo } from '../../attendance-penalties/_repo.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const caller = await requireRole(req, res, BACKOFFICE_ROLES);
  if (!caller) return;

  const id = req.query.id;
  if (!id) return res.status(400).json({ error: 'record id required' });

  const { waive_reason } = req.body || {};
  if (!waive_reason || !String(waive_reason).trim()) {
    return res.status(400).json({ error: 'waive_reason required' });
  }

  const repo = makeAttendancePenaltyRepo();
  const cur = await repo.findPenaltyRecordById(id);
  if (!cur) return res.status(404).json({ error: 'record not found' });
  if (cur.status === 'waived') {
    return res.status(409).json({ error: 'already waived' });
  }
  if (cur.status === 'applied') {
    return res.status(409).json({
      error: 'CANNOT_WAIVE_APPLIED',
      detail: '已套用至薪資的記錄不能豁免;請改走薪資模組調整',
    });
  }

  try {
    const updated = await repo.updatePenaltyRecord(id, {
      status: 'waived',
      waived_by: caller.id || null,
      waived_at: new Date().toISOString(),
      waive_reason: String(waive_reason).trim(),
    });
    return res.status(200).json({ record: updated });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
