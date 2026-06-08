// api/expense-categories/[id].js
// PUT    /api/expense-categories/:id   HR/admin 更新類別(白名單 patch)
// DELETE /api/expense-categories/:id   HR/admin 刪除(被引用回 409、建議改 is_active=false)

import { requireRole } from '../../lib/auth.js';
import { BACKOFFICE_ROLES } from '../../lib/roles.js';
import { makeExpenseCategoryRepo } from './_repo.js';

const ALLOWED_PUT = new Set([
  'name', 'is_wage', 'is_taxable', 'is_active', 'sort_order', 'note',
]);
const BOOL_FIELDS = new Set(['is_wage', 'is_taxable', 'is_active']);

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  const caller = await requireRole(req, res, BACKOFFICE_ROLES);
  if (!caller) return;

  const id = req.query.id;
  if (!id) return res.status(400).json({ error: 'id required' });

  const repo = makeExpenseCategoryRepo();

  const existing = await repo.getCategory(id);
  if (!existing) return res.status(404).json({ error: 'category not found' });

  if (req.method === 'PUT') {
    const patch = {};
    for (const k of Object.keys(req.body || {})) {
      if (!ALLOWED_PUT.has(k)) continue;
      patch[k] = BOOL_FIELDS.has(k) ? (req.body[k] === true) : req.body[k];
    }
    if (typeof patch.name === 'string') {
      patch.name = patch.name.trim();
      if (!patch.name) return res.status(400).json({ error: '類別名稱必填' });
    }
    if (patch.sort_order != null) {
      const n = parseInt(patch.sort_order);
      patch.sort_order = Number.isInteger(n) ? n : 0;
    }
    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ error: 'no allowed fields to update' });
    }
    patch.updated_at = new Date().toISOString();

    try {
      const updated = await repo.updateCategory(id, patch);
      return res.status(200).json({ category: updated });
    } catch (e) {
      if (e?.code === '23505') {
        return res.status(409).json({ error: '已有同名類別' });
      }
      return res.status(500).json({ error: e.message });
    }
  }

  if (req.method === 'DELETE') {
    try {
      const inUse = await repo.countEntriesUsing(id);
      if (inUse > 0) {
        return res.status(409).json({
          error: '此類別已被請款併薪紀錄引用,請改為停用而非刪除',
          in_use_count: inUse,
        });
      }
      await repo.deleteCategory(id);
      return res.status(200).json({ deleted: true, id });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
