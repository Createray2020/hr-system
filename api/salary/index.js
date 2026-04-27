// api/salary/index.js
//
// 本檔同時服務兩條路徑(同 Batch 3/4/5 模式向後相容):
//   舊路徑(legacy):salary.html.old / employee-salary.html.old / dashboard.html
//     - GET  ?year&month&dept&status&employee_id   清單(回 row 含 client-side gross/net 算的)
//     - POST ?_action=batch                        舊批次產生草稿(legacy schema)
//   新路徑(Batch 9):salary.html / employee-salary.html(新版)
//     - GET ?year&month[&employee_id][&v=2]       清單(直接回 GENERATED gross_salary/net_salary)
//     - POST body { action:'batch_v2', year, month }  新批次產生 → 走 lib/salary/calculator.js
//
// 分流訊號:
//   GET:預設走 legacy(client-side 算 gross/net 跟舊欄位 bonus / overtime_pay 對齊);
//        ?v=2 走新邏輯(直接從 DB 拿 GENERATED 欄位 + 新 _auto/_manual 欄位)
//   POST:?_action=batch + body 沒 action='batch_v2' → legacy
//        body action='batch_v2' → 新邏輯
//
// 對應實作計畫:docs/attendance-system-implementation-plan-v1.md §11.4

import { supabaseAdmin } from '../../lib/supabase.js';
import { skipAttendanceBonus, isBackofficeRole, BACKOFFICE_ROLES } from '../../lib/roles.js';
import { requireAuth, requireRole } from '../../lib/auth.js';
import { calculateMonthlySalary } from '../../lib/salary/calculator.js';
import { makeSalaryRepo } from './_repo.js';

function calcAttendanceBonus(emp) {
  if (!emp) return 0;
  if (emp.employment_type === 'part_time') return 0;
  if (skipAttendanceBonus(emp)) return 0;
  return parseFloat(emp.attendance_bonus) || 0;
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── 新路徑分流 ──────────────────────────────────────────
  if (req.method === 'GET' && req.query.v === '2') {
    return handleNewGet(req, res);
  }
  if (req.method === 'POST' && req.body && req.body.action === 'batch_v2') {
    return handleNewBatch(req, res);
  }

  // ── Legacy GET ──────────────────────────────────────────
  if (req.method === 'GET') {
    const { year, month, dept, status, employee_id } = req.query;
    let q = supabaseAdmin.from('salary_records')
      .select(`*, employees!inner(name, dept, avatar, role, is_manager, employment_type)`)
      .order('employee_id');
    if (year)        q = q.eq('year',        parseInt(year));
    if (month)       q = q.eq('month',       parseInt(month));
    if (status)      q = q.eq('status',      status);
    if (employee_id) q = q.eq('employee_id', employee_id);
    if (dept)        q = q.eq('employees.dept', dept);

    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });

    const rows = data.map(r => {
      const emp = r.employees;
      const noBonus = !emp || emp.employment_type === 'part_time' || skipAttendanceBonus(emp);
      const correctedBonus = noBonus ? 0 : (r.bonus || 0);
      // legacy gross/net 公式(client-side):跟 batch_c GENERATED 公式不同,
      // 只服務舊 client(讀舊欄位 bonus / overtime_pay)。新 client 用 v=2 取 GENERATED。
      const gross = (r.base_salary||0) + correctedBonus + (r.allowance||0) +
                    (r.extra_allowance||0) + (r.overtime_pay||0);
      const totalDeduct = (r.deduct_absence||0) + (r.deduct_labor_ins||0) + (r.deduct_health_ins||0);
      const net = gross - totalDeduct;
      return {
        ...r,
        bonus:          correctedBonus,
        gross_salary:   gross,
        net_salary:     net,
        emp_name:       emp?.name,
        dept:           emp?.dept,
        avatar:         emp?.avatar,
        emp_role:       emp?.role,
        emp_is_manager: emp?.is_manager,
      };
    });
    return res.status(200).json(rows);
  }

  // ── Legacy POST ?_action=batch ──────────────────────────
  if (req.method === 'POST' && req.query._action === 'batch') {
    const caller = await requireRole(req, res, BACKOFFICE_ROLES);
    if (!caller) return;
    const { year, month } = req.body || {};
    if (!Number.isInteger(year) || !Number.isInteger(month)) {
      return res.status(400).json({ error: 'year / month required' });
    }
    // legacy:只建 row + 預填 base_salary / attendance_bonus,不算 overtime/penalty/settlement
    const { data: emps } = await supabaseAdmin
      .from('employees').select('id, base_salary, attendance_bonus, employment_type').eq('status', 'active');
    let created = 0;
    for (const emp of (emps || [])) {
      const id = `S_${emp.id}_${year}_${String(month).padStart(2,'0')}`;
      const bonus = calcAttendanceBonus(emp);
      const { error } = await supabaseAdmin.from('salary_records').upsert([{
        id, employee_id: emp.id, year, month,
        base_salary: emp.base_salary || 0,
        bonus, status: 'draft',
      }], { onConflict: 'id', ignoreDuplicates: true });
      if (!error) created += 1;
    }
    return res.status(200).json({
      message: 'legacy batch done', created,
      note: 'Batch 9 後請改用 action=batch_v2 接通完整重算流程',
    });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

// ─────────────────────────────────────────────────────────────
// 新路徑(Batch 9):用 lib/salary/calculator.js 完整重算
// ─────────────────────────────────────────────────────────────

async function handleNewGet(req, res) {
  const caller = await requireAuth(req, res);
  if (!caller) return;
  const { year, month, employee_id, status } = req.query;
  const isHR = isBackofficeRole(caller);

  const queryEmpId = employee_id || (isHR ? null : caller.id);
  if (employee_id && employee_id !== caller.id && !isHR) {
    return res.status(403).json({ error: 'employee can only see own records' });
  }

  const repo = makeSalaryRepo();
  try {
    const records = await repo.listSalaryRecords({
      year: year ? parseInt(year) : null,
      month: month ? parseInt(month) : null,
      employee_id: queryEmpId,
      status,
    });
    const ids = [...new Set(records.map(r => r.employee_id))];
    let empMap = {};
    if (ids.length) {
      const { data: emps } = await supabaseAdmin
        .from('employees').select('id, name, dept').in('id', ids);
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

async function handleNewBatch(req, res) {
  const caller = await requireRole(req, res, BACKOFFICE_ROLES);
  if (!caller) return;

  const { year, month, employee_id } = req.body || {};
  const y = parseInt(year), m = parseInt(month);
  if (!Number.isInteger(y) || !Number.isInteger(m) || m < 1 || m > 12) {
    return res.status(400).json({ error: 'year / month required' });
  }

  const repo = makeSalaryRepo();
  try {
    let targets;
    if (employee_id) {
      targets = [{ id: employee_id }];
    } else {
      targets = await repo.listActiveEmployees();
    }

    const results = [];
    let success = 0, failed = 0;
    for (const emp of targets) {
      try {
        const r = await calculateMonthlySalary(repo, { employee_id: emp.id, year: y, month: m });
        results.push({ employee_id: emp.id, ok: true, record_id: r.record.id });
        success += 1;
      } catch (e) {
        results.push({ employee_id: emp.id, ok: false, error: e.message });
        failed += 1;
      }
    }
    return res.status(200).json({ ok: true, year: y, month: m, success, failed, results });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
