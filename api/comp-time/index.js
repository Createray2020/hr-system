// api/comp-time/index.js
// GET /api/comp-time?employee_id=X  → 員工查自己餘額(active records 列表)
// GET /api/comp-time                → HR 查全部員工餘額
//
// 對應設計文件:docs/attendance-system-design-v1.md §4.3.4
// 對應實作計畫:docs/attendance-system-implementation-plan-v1.md §8.6
//
// Routing 假設:同 api/holidays/{[id].js,...} precedent。
// 本批沒新增 api/comp-time/[id].js — 補休增/扣走 leave_requests + overtime_requests
// (Batch 7 補),不直接 PATCH comp_time_balance。

import { supabaseAdmin } from '../../lib/supabase.js';
import { requireAuth } from '../../lib/auth.js';
import { isBackofficeRole } from '../../lib/roles.js';
import { getCompBalance } from '../../lib/comp-time/balance.js';
import { makeLeaveRepo } from '../leaves/_repo.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const caller = await requireAuth(req, res);
  if (!caller) return;

  const { employee_id } = req.query;
  const isHR = isBackofficeRole(caller);

  // 員工自己 / HR 看別人
  if (employee_id && (employee_id === caller.id || isHR)) {
    try {
      const balance = await getCompBalance(makeLeaveRepo(), employee_id);
      return res.status(200).json({ balance });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // HR 查全部:回每個員工的 active records 加總
  if (!isHR) return res.status(403).json({ error: 'employee_id required (or HR/admin to list all)' });

  try {
    const { data, error } = await supabaseAdmin
      .from('comp_time_balance').select('*').eq('status', 'active')
      .order('employee_id').order('expires_at');
    if (error) return res.status(500).json({ error: error.message });
    const empIds = [...new Set((data || []).map(r => r.employee_id))];
    let empMap = {};
    if (empIds.length) {
      const { data: emps } = await supabaseAdmin
        .from('employees').select('id, name, dept').in('id', empIds);
      for (const e of (emps || [])) empMap[e.id] = e;
    }
    // 按員工聚合
    const byEmp = {};
    for (const r of (data || [])) {
      const eid = r.employee_id;
      if (!byEmp[eid]) {
        byEmp[eid] = {
          employee_id: eid,
          emp_name: empMap[eid]?.name || '',
          dept:     empMap[eid]?.dept || '',
          total_remaining: 0,
          records: [],
        };
      }
      const remaining = Math.max(0, Number(r.earned_hours) - Number(r.used_hours));
      byEmp[eid].total_remaining += remaining;
      byEmp[eid].records.push({
        id: r.id,
        earned_at: r.earned_at,
        expires_at: r.expires_at,
        earned_hours: Number(r.earned_hours),
        used_hours: Number(r.used_hours),
        remaining_hours: remaining,
        source_overtime_request_id: r.source_overtime_request_id,
        status: r.status,
      });
    }
    return res.status(200).json({ employees: Object.values(byEmp) });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
