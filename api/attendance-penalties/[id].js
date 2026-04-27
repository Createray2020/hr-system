// api/attendance-penalties/[id].js
// PUT    /api/attendance-penalties/:id
// DELETE /api/attendance-penalties/:id

import { requireRole } from '../../lib/auth.js';
import { makeAttendancePenaltyRepo } from './_repo.js';

const ALLOWED_PUT = new Set([
  'trigger_type', 'trigger_label',
  'threshold_minutes_min', 'threshold_minutes_max',
  'monthly_count_threshold',
  'penalty_type', 'penalty_amount', 'penalty_cap',
  'custom_action_note',
  'is_active', 'display_order',
  'effective_from', 'effective_to',
  'description',
]);

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  const caller = await requireRole(req, res, ['hr', 'admin', 'ceo']);
  if (!caller) return;
  if (!['hr', 'admin', 'ceo'].includes(caller.role || '')) {
    return res.status(403).json({ error: 'HR / admin only' });
  }

  const id = req.query.id;
  if (!id) return res.status(400).json({ error: 'id required' });

  const repo = makeAttendancePenaltyRepo();
  const cur = await repo.findPenaltyById(id);
  if (!cur) return res.status(404).json({ error: 'rule not found' });

  if (req.method === 'PUT') {
    const patch = {};
    for (const k of Object.keys(req.body || {})) {
      if (!ALLOWED_PUT.has(k)) continue;
      patch[k] = req.body[k];
    }
    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ error: 'no allowed fields to update' });
    }
    try {
      const updated = await repo.updatePenalty(id, patch);
      return res.status(200).json({ rule: updated });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (req.method === 'DELETE') {
    try {
      await repo.deletePenalty(id);
      return res.status(200).json({ deleted: true, id });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
