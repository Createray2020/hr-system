// api/overtime-limits/[id].js
// PUT    /api/overtime-limits/:id
// DELETE /api/overtime-limits/:id

import { requireRole } from '../../lib/auth.js';
import { BACKOFFICE_ROLES } from '../../lib/roles.js';
import { makeOvertimeRepo } from '../overtime-requests/_repo.js';

const ALLOWED_PUT = new Set([
  'daily_limit_hours', 'weekly_limit_hours',
  'monthly_limit_hours', 'yearly_limit_hours',
  'monthly_hard_cap_hours',
  'effective_from', 'effective_to',
  'note',
]);

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  const caller = await requireRole(req, res, BACKOFFICE_ROLES);
  if (!caller) return;

  const id = req.query.id;
  if (!id) return res.status(400).json({ error: 'limit id required' });

  const repo = makeOvertimeRepo();
  const cur = await repo.findOvertimeLimitById(id);
  if (!cur) return res.status(404).json({ error: 'limit not found' });

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
      const updated = await repo.updateOvertimeLimit(id, patch);
      return res.status(200).json({ limit: updated });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (req.method === 'DELETE') {
    try {
      await repo.deleteOvertimeLimit(id);
      return res.status(200).json({ deleted: true, id });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
