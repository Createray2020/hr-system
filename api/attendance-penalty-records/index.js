// api/attendance-penalty-records/index.js
// GET /api/attendance-penalty-records[?employee_id&year&month&status]
//
// 員工只看自己;HR / admin 可看全部。
// 用 makeAttendancePenaltyRepo 共用 supabase 邏輯。

import { supabaseAdmin } from '../../lib/supabase.js';
import { requireAuth } from '../../lib/auth.js';
import { isBackofficeRole } from '../../lib/roles.js';
import { makeAttendancePenaltyRepo } from '../attendance-penalties/_repo.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const caller = await requireAuth(req, res);
  if (!caller) return;

  const { employee_id, year, month, status } = req.query;
  const isHR = isBackofficeRole(caller);
  const repo = makeAttendancePenaltyRepo();

  // 員工只能看自己
  if (employee_id && employee_id !== caller.id && !isHR) {
    return res.status(403).json({ error: 'employee can only see own records' });
  }
  if (!employee_id && !isHR) {
    if (!caller.id) return res.status(400).json({ error: 'employee_id required' });
  }
  const queryEmpId = employee_id || (isHR ? null : caller.id);

  try {
    const records = await repo.listPenaltyRecords({
      employee_id: queryEmpId, year, month, status,
    });

    // 補員工資料(name / dept)讓 UI 顯示更友善
    const empIds = [...new Set(records.map(r => r.employee_id))];
    let empMap = {};
    if (empIds.length) {
      const { data: emps } = await supabaseAdmin
        .from('employees').select('id, name, dept').in('id', empIds);
      for (const e of (emps || [])) empMap[e.id] = e;
    }
    const enriched = records.map(r => ({
      ...r,
      emp_name: empMap[r.employee_id]?.name || '',
      dept:     empMap[r.employee_id]?.dept || '',
    }));
    return res.status(200).json({ records: enriched });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
