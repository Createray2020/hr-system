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

// 2026-06-05:JS 浮點減法(69.5-25.13=44.370000000000005)round 到 2 位、避免 UI 尾數
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

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
          remaining_hours: round2(Math.max(0, Number(r.earned_hours) - Number(r.used_hours))),
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
      const remaining = round2(Math.max(0, Number(r.earned_hours) - Number(r.used_hours)));
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
    // 2026-06-05:total_remaining 是 row remaining 加總,再 round 一次防累加尾數
    for (const eid of Object.keys(byEmp)) byEmp[eid].total_remaining = round2(byEmp[eid].total_remaining);

    // 2026-06-05:enrich records[].source = 對應加班單(IN-query overtime_requests 一次撈)。
    //   - source_overtime_request_id 查得到 → { id, overtime_date, hours, reason, status }
    //   - 有 id 但查不到 → { id }(保底)
    //   - null → null(舊系統匯入/手動)
    //   守門:無任何非 null id 時略過 IN-query(prod 目前 15/15 NULL、會直接全 null)
    const otIds = [...new Set(
      (data || [])
        .map(r => r.source_overtime_request_id)
        .filter(id => id != null)
    )];
    let otMap = {};
    if (otIds.length > 0) {
      const { data: ots } = await supabaseAdmin
        .from('overtime_requests')
        .select('id, overtime_date, hours, reason, status')
        .in('id', otIds);
      for (const ot of (ots || [])) otMap[ot.id] = ot;
    }
    for (const eid of Object.keys(byEmp)) {
      for (const rec of byEmp[eid].records) {
        const sid = rec.source_overtime_request_id;
        if (sid == null) {
          rec.source = null;
        } else if (otMap[sid]) {
          rec.source = {
            id: otMap[sid].id,
            overtime_date: otMap[sid].overtime_date,
            hours: Number(otMap[sid].hours) || 0,
            reason: otMap[sid].reason,
            status: otMap[sid].status,
          };
        } else {
          rec.source = { id: sid };
        }
      }
    }

    return res.status(200).json({ employees: Object.values(byEmp) });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
