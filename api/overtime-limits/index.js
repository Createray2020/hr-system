// api/overtime-limits/index.js
// GET  /api/overtime-limits[?scope=employee|company][&employee_id=]
// POST /api/overtime-limits   HR 新增上限
//
// POST 檢查:
//   - chk_employee_scope:scope='employee' 必須有 employee_id;scope='company' 必須無
//   - 同 scope 同生效期間有重疊 → 拒絕

import { requireRole } from '../../lib/auth.js';
import { makeOvertimeRepo } from '../overtime-requests/_repo.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  const caller = await requireRole(req, res, ['hr', 'admin']);
  if (!caller) return;
  const isHR = ['hr', 'admin'].includes(caller.role || '');
  if (!isHR) return res.status(403).json({ error: 'HR / admin only' });

  const repo = makeOvertimeRepo();

  if (req.method === 'GET') {
    const { scope, employee_id } = req.query;
    try {
      const rows = await repo.listOvertimeLimits({ scope, employee_id });
      return res.status(200).json({ limits: rows });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (req.method === 'POST') {
    const {
      scope, employee_id,
      daily_limit_hours, weekly_limit_hours,
      monthly_limit_hours, yearly_limit_hours,
      monthly_hard_cap_hours,
      effective_from, effective_to, note,
    } = req.body || {};

    if (!['company', 'employee'].includes(scope)) {
      return res.status(400).json({ error: 'scope must be company / employee' });
    }
    if (scope === 'employee' && !employee_id) {
      return res.status(400).json({ error: 'employee_id required when scope=employee' });
    }
    if (scope === 'company' && employee_id) {
      return res.status(400).json({ error: 'employee_id must be null when scope=company' });
    }
    const effFrom = effective_from || new Date().toISOString().slice(0, 10);

    // 檢查重疊:同 scope (+ 同 employee_id) 的有效期間不能重疊
    try {
      const existing = await repo.listOvertimeLimits({ scope, employee_id });
      for (const old of existing) {
        const oldFrom = old.effective_from;
        const oldTo   = old.effective_to;
        const newTo   = effective_to || null;
        // 重疊條件:
        //   newFrom <= oldTo (or oldTo is null) AND (newTo is null OR newTo >= oldFrom)
        const overlap =
          (oldTo == null || effFrom <= oldTo) &&
          (newTo == null || newTo >= oldFrom);
        if (overlap) {
          return res.status(409).json({
            error: 'OVERLAPPING_PERIOD',
            detail: `existing limit #${old.id} ${oldFrom} ~ ${oldTo || 'null'} overlaps with new ${effFrom} ~ ${newTo || 'null'}`,
          });
        }
      }
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }

    const row = {
      scope,
      employee_id: scope === 'employee' ? employee_id : null,
      daily_limit_hours:    nullableNumber(daily_limit_hours),
      weekly_limit_hours:   nullableNumber(weekly_limit_hours),
      monthly_limit_hours:  nullableNumber(monthly_limit_hours),
      yearly_limit_hours:   nullableNumber(yearly_limit_hours),
      monthly_hard_cap_hours: nullableNumber(monthly_hard_cap_hours),
      effective_from: effFrom,
      effective_to:   effective_to || null,
      note:           note || null,
      created_by:     caller.id || null,
    };
    try {
      const created = await repo.insertOvertimeLimit(row);
      return res.status(201).json({ limit: created });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

function nullableNumber(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
