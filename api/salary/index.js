// api/salary/index.js
//
// 本檔同時服務兩條路徑(同 Batch 3/4/5 模式向後相容):
//   舊路徑(legacy)：僅留作 HR 後台 fallback、frontend 已全改 ?v=2
//     - GET  ?year&month&dept&status&employee_id   清單(client-side gross/net、含 avatar/emp_role)
//                                                 ※ requireRole(BACKOFFICE_ROLES) — cleanup 3 加上
//     - POST ?_action=batch                        舊批次產生草稿(legacy schema)
//   新路徑(Batch 9):salary.html / employee-salary.html / dashboard.html(本次遷移)
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
import { canExecuteTransition } from '../../lib/salary/period-state.js';
import { reconcilePeriodStats } from '../../lib/salary/period-stats.js';
import { isSystemAccount, excludeSystemAccounts, applyExcludeSystemAccountsQuery } from '../../lib/salary/system-accounts.js';
import { makeSalaryRepo } from './_repo.js';
import { addDeptName, addDeptNameNested } from '../../lib/dept-name-mapper.js';

function calcAttendanceBonus(emp) {
  if (!emp) return 0;
  if (emp.employment_type === 'part_time') return 0;
  if (skipAttendanceBonus(emp)) return 0;
  return parseFloat(emp.attendance_bonus) || 0;
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── Periods resource(階段 1.4)─────────────────────────────────────────
  if (req.query._resource === 'periods') {
    const caller = await requireRole(req, res, BACKOFFICE_ROLES);
    if (!caller) return;

    const id = req.query.id;

    // GET list / detail
    if (req.method === 'GET') {
      if (id) {
        const { data, error } = await supabaseAdmin
          .from('payroll_periods').select('*').eq('id', id).maybeSingle();
        if (error) return res.status(500).json({ error: error.message });
        if (!data) return res.status(404).json({ error: 'Period not found' });
        return res.status(200).json(data);
      }
      let q = supabaseAdmin.from('payroll_periods').select('*')
        .order('year', { ascending: false }).order('month', { ascending: false });
      if (req.query.status) q = q.eq('status', req.query.status);
      if (req.query.year)   q = q.eq('year', Number(req.query.year));
      const { data, error } = await q;
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json(data || []);
    }

    // POST 開新期間
    if (req.method === 'POST') {
      const { year, month, period_start, period_end,
              attendance_cutoff_date, pay_date, note } = req.body || {};
      if (!year || !month)        return res.status(400).json({ error: '缺 year/month' });
      if (!period_start || !period_end) return res.status(400).json({ error: '缺 period_start/period_end' });
      if (month < 1 || month > 12)return res.status(400).json({ error: 'month 範圍 1-12' });

      const periodId = `PP_${year}_${String(month).padStart(2, '0')}`;
      const { error } = await supabaseAdmin.from('payroll_periods').insert([{
        id: periodId,
        year: Number(year), month: Number(month),
        period_start, period_end,
        attendance_cutoff_date: attendance_cutoff_date || null,
        pay_date:               pay_date               || null,
        status: 'draft',
        created_by: caller.id,
        note: note || null,
      }]);
      if (error) {
        if (error.code === '23505') return res.status(409).json({ error: '此年月期間已存在' });
        return res.status(500).json({ error: error.message });
      }
      return res.status(201).json({ id: periodId, message: '期間已建立' });
    }

    // PUT 改 status / note(走狀態機驗證)
    if (req.method === 'PUT') {
      if (!id) return res.status(400).json({ error: '缺 id' });
      const body = req.body || {};

      const { data: cur, error: cErr } = await supabaseAdmin
        .from('payroll_periods').select('status').eq('id', id).maybeSingle();
      if (cErr)  return res.status(500).json({ error: cErr.message });
      if (!cur)  return res.status(404).json({ error: 'Period not found' });

      // 狀態機驗證
      if (body.status && body.status !== cur.status) {
        const check = canExecuteTransition({
          callerRole: caller.role,
          from:       cur.status,
          to:         body.status,
        });
        if (!check.ok) {
          return res.status(403).json({ error: 'Transition not allowed', reason: check.reason });
        }
      }

      // 白名單欄位
      const allowed = ['status','note','attendance_cutoff_date','pay_date','period_start','period_end'];
      const update = {};
      for (const k of allowed) if (body[k] !== undefined) update[k] = body[k];

      // 自動 audit 欄位
      const now = new Date().toISOString();
      if (body.status === 'calculating'    && cur.status !== 'calculating')    update.calculated_at = now;
      if (body.status === 'pending_review' && cur.status !== 'pending_review') {
        update.reviewed_by = caller.id;
        update.reviewed_at = now;
      }
      if (body.status === 'approved') { update.approved_by = caller.id; update.approved_at = now; }
      if (body.status === 'paid')     { update.paid_at     = now; }
      if (body.status === 'locked')   { update.locked_at   = now; }

      const { error } = await supabaseAdmin.from('payroll_periods').update(update).eq('id', id);
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ message: '已更新' });
    }

    // DELETE 只能刪 draft
    if (req.method === 'DELETE') {
      if (!id) return res.status(400).json({ error: '缺 id' });
      const { data: cur } = await supabaseAdmin
        .from('payroll_periods').select('status').eq('id', id).maybeSingle();
      if (!cur) return res.status(404).json({ error: 'Period not found' });
      if (cur.status !== 'draft') {
        return res.status(409).json({ error: '只能刪除 status=draft 的期間' });
      }
      const { error } = await supabaseAdmin.from('payroll_periods').delete().eq('id', id);
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ message: '已刪除' });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ── Annual summary resource (階段 C2、年底給會計填扣繳憑單) ────────
  if (req.query._resource === 'annual_summary') {
    return handleAnnualSummary(req, res);
  }

  // ── 新路徑分流 ──────────────────────────────────────────
  if (req.method === 'GET' && req.query.v === '2') {
    return handleNewGet(req, res);
  }
  if (req.method === 'POST' && req.body && req.body.action === 'batch_v2') {
    return handleNewBatch(req, res);
  }

  // ── Legacy GET ──────────────────────────────────────────
  if (req.method === 'GET') {
    // cleanup 3：legacy GET 加 BACKOFFICE_ROLES gate（原本完全無 auth）
    const caller = await requireRole(req, res, BACKOFFICE_ROLES);
    if (!caller) return;
    const { year, month, dept, dept_id, status, employee_id } = req.query;
    let q = supabaseAdmin.from('salary_records')
      .select(`*, employees!inner(name, dept_id, avatar, role, is_manager, employment_type, departments(name))`)
      .order('employee_id');
    if (year)        q = q.eq('year',        parseInt(year));
    if (month)       q = q.eq('month',       parseInt(month));
    if (status)      q = q.eq('status',      status);
    if (employee_id) q = q.eq('employee_id', employee_id);
    if (dept_id)     q = q.eq('employees.dept_id', dept_id);

    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    addDeptNameNested(data, 'employees');

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
        dept_name:      emp?.dept_name,
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
    const { data: emps } = await applyExcludeSystemAccountsQuery(
      supabaseAdmin.from('employees').select('id, base_salary, attendance_bonus, employment_type').eq('status', 'active')
    );
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
      const { data: emps } = await applyExcludeSystemAccountsQuery(
        supabaseAdmin.from('employees').select('id, name, dept_id, departments(name)').in('id', ids)
      );
      addDeptName(emps);
      for (const e of (emps || [])) empMap[e.id] = e;
    }
    const enriched = records.map(r => ({
      ...r,
      emp_name:  empMap[r.employee_id]?.name || '',
      dept_id:   empMap[r.employee_id]?.dept_id || null,
      dept_name: empMap[r.employee_id]?.dept_name || null,
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

  // 系統帳號 guard:explicit employee_id = EMP_99999999 直接擋(repo .neq() 只擋 enum 路徑)
  if (employee_id && isSystemAccount(employee_id)) {
    return res.status(400).json({ error: '系統帳號不可進薪資計算', employee_id });
  }

  const repo = makeSalaryRepo();
  try {
    let targets;
    if (employee_id) {
      targets = [{ id: employee_id }];
    } else {
      // belt-and-suspenders:repo 已 .neq() 過濾、再 client-side 過濾防 query 漏接
      targets = excludeSystemAccounts(await repo.listActiveEmployees());
    }

    const results = [];
    let success = 0, failed = 0;
    for (const emp of targets) {
      try {
        const r = await calculateMonthlySalary(repo, {
          employee_id: emp.id, year: y, month: m,
          callerId: caller.id,
        });
        results.push({ employee_id: emp.id, ok: true, record_id: r.record.id });
        success += 1;
      } catch (e) {
        results.push({ employee_id: emp.id, ok: false, error: e.message });
        failed += 1;
      }
    }

    // 階段 2.5.3b: 跑完 batch 後 reconcile payroll_periods cache + status 自動推進
    // 若該 (year, month) 沒對應 period、跳過 cache 更新(只 warning、不 error)
    let periodWarning = null;
    try {
      const period = await repo.findActivePayrollPeriod(y, m);
      if (period) {
        const stats = await reconcilePeriodStats(repo, period.id);
        const periodPatch = {
          employee_count:      stats.employee_count,
          gross_total:         stats.gross_total,
          net_total:           stats.net_total,
          employer_cost_total: stats.employer_cost_total,
          calculated_at:       new Date().toISOString(),
        };
        // status 自動推進:只在 [draft, calculating, pending_review] 時切到 pending_review
        // approved / paid / locked 不動 status、只更新 cache + calculated_at
        if (failed === 0 && ['draft','calculating','pending_review'].includes(period.status)) {
          periodPatch.status = 'pending_review';
        }
        await repo.updatePayrollPeriod(period.id, periodPatch);
      } else {
        periodWarning = `payroll_periods 沒有 ${y}-${m} 的 period、cache 未更新。建議先透過 /api/salary/periods POST 建立期間`;
      }
    } catch (e) {
      periodWarning = `period cache reconcile 失敗: ${e.message}`;
    }

    return res.status(200).json({
      ok: true, year: y, month: m, success, failed, results,
      period_warning: periodWarning,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

// ─────────────────────────────────────────────────────────────
// 階段 C2:年度薪資合計 (HR-only、給會計填扣繳憑單)
// GET /api/salary?_resource=annual_summary&year=2025
// ─────────────────────────────────────────────────────────────
async function handleAnnualSummary(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const caller = await requireRole(req, res, BACKOFFICE_ROLES);
  if (!caller) return;

  const year = parseInt(req.query.year);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    return res.status(400).json({ error: 'invalid year (2000-2100)' });
  }

  try {
    // 撈該年度 status='paid' 或 'locked' 的 salary_records (避免 draft / pending_review、
    // 確保金額已確認、可給會計用)
    const { data: records, error: rErr } = await supabaseAdmin
      .from('salary_records')
      .select('employee_id, year, month, gross_salary, net_salary, ' +
              'bonus_yearend, bonus_festival, bonus_performance, bonus_other, ' +
              'deduct_labor_ins, deduct_health_ins, deduct_pension_voluntary, ' +
              'deduct_supplementary_health, deduct_tax')
      .eq('year', year)
      .in('status', ['paid', 'locked']);
    if (rErr) return res.status(500).json({ error: rErr.message });

    // 撈員工 name + dept_name (套 EMP_99999999 排除 + 系統帳號 filter)
    const empIds = [...new Set((records || []).map(r => r.employee_id).filter(Boolean))];
    let empMap = {};
    if (empIds.length) {
      const { data: emps } = await applyExcludeSystemAccountsQuery(
        supabaseAdmin
          .from('employees')
          .select('id, name, dept_id, departments(name)')
          .in('id', empIds)
      );
      addDeptName(emps);
      for (const e of (emps || [])) {
        empMap[e.id] = { name: e.name, dept_name: e.dept_name };
      }
      // EMP_99999999 / 系統帳號 → empMap 沒有對應、records 該 empId 不會出現在 summary
      // (filter 掉 records 裡 empId 不在 empMap 的 row)
    }
    const filteredRecords = (records || []).filter(r => empMap[r.employee_id]);

    return res.status(200).json({
      year,
      records: filteredRecords,    // 給 frontend builder 用
      employees: empMap,            // employee_id → { name, dept_name }
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
