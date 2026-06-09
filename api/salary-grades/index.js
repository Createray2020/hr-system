// api/salary-grades/index.js
// GET /api/salary-grades  → 列出全部職等級距(BACKOFFICE_ROLES 限定)
//
// 設定頁專用、不對外開放。對齊風格:api/leave-types/index.js GET。

import { requireRole } from '../../lib/auth.js';
import { BACKOFFICE_ROLES } from '../../lib/roles.js';
import { makeSalaryGradeRepo } from './_repo.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')     return res.status(405).json({ error: 'Method not allowed' });

  const caller = await requireRole(req, res, BACKOFFICE_ROLES);
  if (!caller) return;

  const repo = makeSalaryGradeRepo();
  try {
    const grades = await repo.listAll();
    return res.status(200).json({ grades });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
