// api/comp-time/index.js
// GET /api/comp-time?employee_id=X                              → 員工查自己餘額(active records 列表)
// GET /api/comp-time                                            → HR 查全部員工餘額
// GET /api/comp-time?employee_id=X&year=Y&month=M&view=expiry  → 該員工該期間「失效轉現逐筆」明細
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
import { addDeptName } from '../../lib/dept-name-mapper.js';
import { applyExcludeSystemAccountsQuery } from '../../lib/salary/system-accounts.js';
import { makeLeaveRepo } from '../leaves/_repo.js';
import { makeSalaryRepo } from '../salary/_repo.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const caller = await requireAuth(req, res);
  if (!caller) return;

  const { employee_id, year, month, view } = req.query;
  const isHR = isBackofficeRole(caller);

  // view=expiry:該員工該期間「失效轉現逐筆」明細
  // 對齊 lib/salary/calculator.js step 9(L211-238)分支:
  //   - is_final_month=true → findAllExpiredPaidCompForEmployee(不限 month)
  //   - 否則             → findCompBalancesForSettlement(該月 expiry_processed_at 區間 +08)
  // 兩支方法直接 import api/salary/_repo.js makeSalaryRepo()、不複製 WHERE,
  // 確保逐筆 Σ expiry_payout_amount == calculator 寫進 salary_records.comp_expiry_payout。
  // 權限沿用同一條:employee_id === caller.id || isHR(下方 active 分支也是這條)。
  if (view === 'expiry') {
    if (!employee_id) return res.status(400).json({ error: 'employee_id required' });
    if (employee_id !== caller.id && !isHR) {
      return res.status(403).json({ error: '只能查自己的補休失效明細' });
    }
    const y = parseInt(year), m = parseInt(month);
    if (!Number.isInteger(y) || !Number.isInteger(m) || m < 1 || m > 12) {
      return res.status(400).json({ error: 'year / month required (month 1-12)' });
    }
    try {
      // 從 salary_records 讀 is_final_month 決定走哪條(對齊 calculator.js:134 的判定)
      const recordId = `S_${employee_id}_${y}_${String(m).padStart(2, '0')}`;
      const { data: sr } = await supabaseAdmin.from('salary_records')
        .select('is_final_month').eq('id', recordId).maybeSingle();
      const isFinalMonth = !!(sr?.is_final_month);

      const salaryRepo = makeSalaryRepo();
      const raw = isFinalMonth
        ? await salaryRepo.findAllExpiredPaidCompForEmployee(employee_id)
        : await salaryRepo.findCompBalancesForSettlement({ employee_id, year: y, month: m });

      return res.status(200).json({
        view: 'expiry',
        is_final_month: isFinalMonth,
        records: (raw || []).map(r => ({
          id: r.id,
          earned_at: r.earned_at,
          earned_hours: Number(r.earned_hours),
          used_hours: Number(r.used_hours),
          remaining_hours: Math.max(0, Number(r.earned_hours) - Number(r.used_hours)),
          expires_at: r.expires_at,
          expiry_processed_at: r.expiry_processed_at,
          expiry_payout_amount: Number(r.expiry_payout_amount) || 0,
          status: r.status,
          source_overtime_request_id: r.source_overtime_request_id,
        })),
      });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

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
      const { data: emps } = await applyExcludeSystemAccountsQuery(
        supabaseAdmin.from('employees').select('id, name, dept_id, departments(name)').in('id', empIds)
      );
      addDeptName(emps);
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
          dept_id:  empMap[eid]?.dept_id || null,
          dept_name: empMap[eid]?.dept_name || null,
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
        admin_audit_note: r.admin_audit_note,
      });
    }
    return res.status(200).json({ employees: Object.values(byEmp) });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
