// api/salary/recalculate.js
// POST /api/salary/recalculate  body { employee_id, year, month }
// HR 觸發重算某員工某月。完整重算模式:reset child markers + 重新算 _auto 欄位,_manual 保留。

import { requireRole } from '../../lib/auth.js';
import { BACKOFFICE_ROLES } from '../../lib/roles.js';
import { calculateMonthlySalary } from '../../lib/salary/calculator.js';
import { makeSalaryRepo } from './_repo.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const caller = await requireRole(req, res, BACKOFFICE_ROLES);
  if (!caller) return;

  const { employee_id, year, month } = req.body || {};
  const y = parseInt(year), m = parseInt(month);
  if (!employee_id) return res.status(400).json({ error: 'employee_id required' });
  if (!Number.isInteger(y) || !Number.isInteger(m) || m < 1 || m > 12) {
    return res.status(400).json({ error: 'year / month required' });
  }

  try {
    const repo = makeSalaryRepo();
    const r = await calculateMonthlySalary(repo, { employee_id, year: y, month: m });
    return res.status(200).json({ ok: true, record: r.record, breakdown: r.breakdown });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
