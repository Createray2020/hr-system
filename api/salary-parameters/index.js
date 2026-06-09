// api/salary-parameters/index.js
//
// GET  /api/salary-parameters
//   → 列出全部 salary_parameter_definitions row(含歷史版本、含 effective_to=NULL 當前版本)
//
// POST /api/salary-parameters  body: { category, parameter_name, parameter_value, effective_from, note? }
//   → 新增一個生效版本。流程(無 supabase transaction、用 UNIQUE 三鍵 + 補償回滾守):
//     (1) 找該 (category, parameter_name) 的當前版本(effective_to IS NULL)
//     (2) 新 effective_from <= 當前版本的 effective_from → 400
//     (3) UPDATE 當前版本.effective_to = 新 effective_from - 1 天(寫 updated_by/at)
//     (4) INSERT 新版本(從舊版本繼承 label_zh / unit / regulation_basis;value/note 用新值;
//         created_by / updated_by = caller)
//     (5) 若 (4) INSERT 失敗 → 補償:把當前版本.effective_to 改回 NULL,回 500
//
// 角色:BACKOFFICE_ROLES(hr / admin / ceo / chairman)

import { requireRole } from '../../lib/auth.js';
import { BACKOFFICE_ROLES } from '../../lib/roles.js';
import { makeSalaryParameterRepo } from './_repo.js';

function isValidDateStr(s) {
  if (!s || typeof s !== 'string') return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) return false;
  return d.toISOString().slice(0, 10) === s;
}

// 'YYYY-MM-DD' → 前一天 'YYYY-MM-DD'
function dayBefore(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  const caller = await requireRole(req, res, BACKOFFICE_ROLES);
  if (!caller) return;

  const repo = makeSalaryParameterRepo();

  if (req.method === 'GET') {
    try {
      const parameters = await repo.listAll();
      return res.status(200).json({ parameters });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (req.method === 'POST') {
    const body = req.body || {};
    const category       = typeof body.category === 'string' ? body.category.trim() : '';
    const parameter_name = typeof body.parameter_name === 'string' ? body.parameter_name.trim() : '';
    const parameter_value = body.parameter_value;
    const effective_from = typeof body.effective_from === 'string' ? body.effective_from.trim() : '';
    const note = body.note == null ? null : String(body.note);

    if (!category)       return res.status(400).json({ error: 'category required' });
    if (!parameter_name) return res.status(400).json({ error: 'parameter_name required' });
    if (parameter_value == null || !Number.isFinite(Number(parameter_value))) {
      return res.status(400).json({ error: 'parameter_value must be a number' });
    }
    if (!isValidDateStr(effective_from)) {
      return res.status(400).json({ error: 'effective_from must be valid YYYY-MM-DD' });
    }

    try {
      // (1) 找當前版本
      const current = await repo.findCurrentVersion(category, parameter_name);
      if (!current) {
        return res.status(404).json({
          error: 'parameter not found',
          detail: `${category}.${parameter_name} 沒有當前生效版本、不能新增新版本`,
        });
      }

      // (2) 拒絕回追
      if (effective_from <= current.effective_from) {
        return res.status(400).json({
          error: 'effective_from 必須晚於當前版本',
          current_effective_from: current.effective_from,
        });
      }

      // (3) 截斷當前版本
      const nowIso = new Date().toISOString();
      const newClosedTo = dayBefore(effective_from);
      await repo.updateRow(current.id, {
        effective_to: newClosedTo,
        updated_by:   caller.id,
        updated_at:   nowIso,
      });

      // (4) INSERT 新版本(繼承描述性欄位、value/note 用新值)
      const newRow = {
        category,
        parameter_name,
        label_zh:         current.label_zh,
        unit:             current.unit,
        regulation_basis: current.regulation_basis,
        parameter_value:  Number(parameter_value),
        effective_from,
        effective_to:     null,
        note,
        created_by:       caller.id,
        updated_by:       caller.id,
      };
      let created;
      try {
        created = await repo.insertRow(newRow);
      } catch (insertErr) {
        // (5) 補償:把 (3) 截斷的 effective_to 改回 NULL
        try {
          await repo.updateRow(current.id, {
            effective_to: null,
            updated_by:   caller.id,
            updated_at:   new Date().toISOString(),
          });
        } catch (rollbackErr) {
          // best-effort、rollback 也失敗只 console.error,不再 throw
          console.error('[salary-parameters] rollback close-current failed',
            { current_id: current.id, error: rollbackErr.message });
        }
        if (insertErr?.code === '23505') {
          return res.status(409).json({ error: '已有同 effective_from 版本(UNIQUE 約束)' });
        }
        return res.status(500).json({ error: 'insert new version failed', detail: insertErr.message });
      }

      return res.status(201).json({ parameter: created, closed_id: current.id });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
