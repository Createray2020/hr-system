// api/leave-types/index.js
// GET /api/leave-types  → 列出全部假別(BACKOFFICE_ROLES 限定)
//
// 設定頁專用、不對外開放、不過濾 is_active(管理頁要看停用的)。
// 對齊風格:api/expense-categories/index.js GET。

import { requireRole } from '../../lib/auth.js';
import { BACKOFFICE_ROLES } from '../../lib/roles.js';
import { makeLeaveTypeRepo } from './_repo.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')     return res.status(405).json({ error: 'Method not allowed' });

  const caller = await requireRole(req, res, BACKOFFICE_ROLES);
  if (!caller) return;

  const repo = makeLeaveTypeRepo();
  try {
    const types = await repo.listAll();
    return res.status(200).json({ types });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
