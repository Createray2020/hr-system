// api/annual-leaves/index.js
// GET  /api/annual-leaves?employee_id=X&status=active|all  → 員工特休餘額或記錄
// GET  /api/annual-leaves                                  → HR 全部員工的 active records
// POST /api/annual-leaves                                  → HR 手動建立 record
//
// 對應設計文件：docs/attendance-system-design-v1.md §4.3.3
// 對應實作計畫：docs/attendance-system-implementation-plan-v1.md §7.6

import { supabase } from '../../lib/supabase.js';
import { requireAuth, requireRole } from '../../lib/auth.js';
import { isBackofficeRole, BACKOFFICE_ROLES } from '../../lib/roles.js';
import { calculateLegalDays, calculatePeriodBoundary } from '../../lib/leave/annual.js';
import { getAnnualBalance } from '../../lib/leave/balance.js';
import { makeLeaveRepo } from '../leaves/_repo.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET')  return handleGet(req, res);
  if (req.method === 'POST') return handlePost(req, res);
  return res.status(405).json({ error: 'Method not allowed' });
}

async function handleGet(req, res) {
  const caller = await requireAuth(req, res);
  if (!caller) return;

  const { employee_id, status } = req.query;
  const isHR = isBackofficeRole(caller);

  // 員工查自己餘額(快速路徑)
  if (employee_id && (employee_id === caller.id || isHR)) {
    if (status === 'all') {
      const repo = makeLeaveRepo();
      const list = await repo.listAnnualRecords({ employee_id });
      return res.status(200).json({ records: list });
    }
    const balance = await getAnnualBalance(makeLeaveRepo(), employee_id);
    return res.status(200).json({ balance });
  }

  // HR 查全部
  if (!isHR) return res.status(403).json({ error: 'HR / admin only' });

  let q = supabase.from('annual_leave_records').select('*').order('period_start', { ascending: false });
  if (status) q = q.eq('status', status);
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });

  // 補員工資料
  const empIds = [...new Set((data || []).map(r => r.employee_id))];
  const empMap = {};
  if (empIds.length) {
    const { data: emps } = await supabase
      .from('employees').select('id, name, dept, annual_leave_seniority_start').in('id', empIds);
    for (const e of (emps || [])) empMap[e.id] = e;
  }
  const rows = (data || []).map(r => ({
    ...r,
    emp_name: empMap[r.employee_id]?.name || '',
    dept:     empMap[r.employee_id]?.dept || '',
    seniority_start: empMap[r.employee_id]?.annual_leave_seniority_start || null,
  }));
  return res.status(200).json({ records: rows });
}

async function handlePost(req, res) {
  const caller = await requireRole(req, res, BACKOFFICE_ROLES);
  if (!caller) return;

  const { employee_id, period_start, period_end, granted_days, note } = req.body || {};
  if (!employee_id) return res.status(400).json({ error: 'employee_id required' });

  // 自動算 seniority_years / legal_days 若未提供
  let { seniority_years, legal_days } = req.body || {};
  if (seniority_years == null || legal_days == null || !period_start || !period_end) {
    const { data: emp } = await supabase
      .from('employees').select('annual_leave_seniority_start').eq('id', employee_id).maybeSingle();
    if (!emp?.annual_leave_seniority_start) {
      return res.status(400).json({ error: 'employee has no annual_leave_seniority_start' });
    }
    const today = new Date().toISOString().slice(0, 10);
    const b = calculatePeriodBoundary(emp.annual_leave_seniority_start, today);
    seniority_years = seniority_years ?? b.seniority_years;
    legal_days      = legal_days      ?? calculateLegalDays(b.seniority_years);
  }

  const row = {
    employee_id,
    period_start: period_start || null,
    period_end:   period_end   || null,
    seniority_years,
    legal_days,
    granted_days: granted_days != null ? Number(granted_days) : legal_days,
    used_days: 0,
    status: 'active',
    note: note || null,
  };
  // 過濾 null period_start / period_end(NOT NULL 約束)
  if (!row.period_start || !row.period_end) {
    return res.status(400).json({ error: 'period_start / period_end required' });
  }

  const repo = makeLeaveRepo();
  try {
    const created = await repo.insertAnnualRecord(row);
    if (legal_days > 0) {
      await repo.insertBalanceLog({
        employee_id,
        balance_type: 'annual',
        annual_record_id: created.id,
        comp_record_id: null,
        leave_request_id: null,
        change_type: 'grant',
        hours_delta: row.granted_days * 8,
        changed_by: caller.id || employee_id,
        reason: 'manual create by HR',
      });
    }
    return res.status(201).json({ record: created });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
