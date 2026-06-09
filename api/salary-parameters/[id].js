// api/salary-parameters/[id].js
// PATCH /api/salary-parameters/:id
//   只允許更新描述性欄位(label_zh / regulation_basis / note),
//   不動 value / 生效日 / category / parameter_name / unit。
//   寫入 updated_by / updated_at。
//
// 不提供 DELETE / PUT。新增生效版本走 POST / api/salary-parameters。
// 角色:BACKOFFICE_ROLES。

import { requireRole } from '../../lib/auth.js';
import { BACKOFFICE_ROLES } from '../../lib/roles.js';
import { makeSalaryParameterRepo } from './_repo.js';

const ALLOWED_PATCH = new Set(['label_zh', 'regulation_basis', 'note']);

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'PATCH')   return res.status(405).json({ error: 'Method not allowed' });

  const caller = await requireRole(req, res, BACKOFFICE_ROLES);
  if (!caller) return;

  const id = req.query.id;
  if (!id) return res.status(400).json({ error: 'id required' });

  const repo = makeSalaryParameterRepo();
  const existing = await repo.getById(id);
  if (!existing) return res.status(404).json({ error: 'parameter not found', id });

  const patch = {};
  for (const k of Object.keys(req.body || {})) {
    if (!ALLOWED_PATCH.has(k)) continue;
    const v = req.body[k];
    patch[k] = (v === null || v === '') ? null : String(v);
  }

  if (Object.keys(patch).length === 0) {
    return res.status(400).json({
      error: 'no allowed fields to update',
      allowed: [...ALLOWED_PATCH],
    });
  }

  // 只有 label_zh 不允許設成空(避免顯示空白)
  if ('label_zh' in patch && (patch.label_zh == null || patch.label_zh.trim() === '')) {
    return res.status(400).json({ error: 'label_zh 不可為空' });
  }

  patch.updated_by = caller.id;
  patch.updated_at = new Date().toISOString();

  try {
    const updated = await repo.updateRow(id, patch);
    return res.status(200).json({ parameter: updated });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
