// api/resigned-archive.js
// Phase 1.7 MVP:離職員工檔案頁 backend
//
// GET /api/resigned-archive          → 列表(全部 status='resigned'、order by resigned_at DESC)
// GET /api/resigned-archive?id=:id   → detail(員工 + 從 resigned_at 倒推 6 個月歷史聚合)
//
// Role gate:hr / admin / ceo / chairman(BACKOFFICE_ROLES)
// 一般主管不能看(離職涉個資 + 法律敏感)、不走 selfOrDept scope filter
// (離職員工沒「caller 自查」語義、本 endpoint 純 backoffice 工具)
//
// 6 個月歷史範圍:resigned_at - 6 months → resigned_at(若 resigned_at null、用 updated_at 替代)

import { supabaseAdmin } from '../lib/supabase.js';
import { requireRole } from '../lib/auth.js';
import { BACKOFFICE_ROLES } from '../lib/roles.js';
import { addDeptName, addDeptNameSingle } from '../lib/dept-name-mapper.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const caller = await requireRole(req, res, BACKOFFICE_ROLES);
  if (!caller) return;

  const { id } = req.query;

  // ── Detail:?id=X ─────────────────────────────────────────
  if (id) return handleDetail(req, res, id);

  // ── List ────────────────────────────────────────────────
  return handleList(req, res);
}

async function handleList(req, res) {
  const { data: emps, error } = await supabaseAdmin
    .from('employees')
    .select('id, emp_no, name, email, phone, dept_id, position, role, is_manager, hire_date, resigned_at, resigned_reason, updated_at, departments(name)')
    .eq('status', 'resigned')
    .order('resigned_at', { ascending: false, nullsLast: true });
  if (error) return res.status(500).json({ error: error.message });
  addDeptName(emps);
  // 在職年資 = resigned_at(or updated_at fallback)- hire_date(client 顯示用、純 audit)
  return res.status(200).json(emps || []);
}

async function handleDetail(req, res, id) {
  // ── 員工 row ────────────────────────────────────────────
  const { data: emp, error: empErr } = await supabaseAdmin
    .from('employees')
    .select('*, departments(name)')
    .eq('id', id)
    .maybeSingle();
  if (empErr) return res.status(500).json({ error: empErr.message });
  if (!emp) return res.status(404).json({ error: 'employee not found' });
  if (emp.status !== 'resigned') {
    return res.status(400).json({ error: 'employee is not resigned', status: emp.status });
  }
  addDeptNameSingle(emp);

  // ── 6 個月歷史時間範圍 ──────────────────────────────────
  // 從 resigned_at 倒推;resigned_at null fallback 到 updated_at
  const anchorIso = emp.resigned_at || emp.updated_at || new Date().toISOString();
  const anchor = new Date(anchorIso);
  const sixMonthsBefore = new Date(anchor);
  sixMonthsBefore.setUTCMonth(sixMonthsBefore.getUTCMonth() - 6);
  const startIso  = sixMonthsBefore.toISOString();
  const startDate = startIso.slice(0, 10);   // 'YYYY-MM-DD'
  const endDate   = anchorIso.slice(0, 10);

  // ── 聚合資料(平行撈)───────────────────────────────────
  const [
    salaryRes, attendanceRes, leavesRes, overtimeRes, compBalanceRes,
  ] = await Promise.all([
    // salary_records:per-month、用 year/month 過濾
    supabaseAdmin.from('salary_records')
      .select('id, year, month, base_salary, overtime_pay, bonus, allowance, deduct_absence, deduct_labor_ins, deduct_health_ins, deduct_tax, gross_salary, net_salary, status, pay_date')
      .eq('employee_id', id)
      .gte('year', sixMonthsBefore.getUTCFullYear())
      .order('year', { ascending: false }).order('month', { ascending: false })
      .limit(12),

    // attendance:用 work_date 過濾
    supabaseAdmin.from('attendance')
      .select('id, work_date, segment_no, clock_in, clock_out, work_hours, overtime_hours, late_minutes, early_arrival_minutes, early_leave_minutes, status, is_holiday_work, is_anomaly')
      .eq('employee_id', id)
      .gte('work_date', startDate).lte('work_date', endDate)
      .order('work_date', { ascending: false })
      .limit(500),

    // leave_requests:含 Phase 1.6 全 7 status
    supabaseAdmin.from('leave_requests')
      .select('id, leave_type, start_at, end_at, start_date, end_date, days, hours, finalized_hours, status, proof_status, applied_at, archived_at, terminated_at')
      .eq('employee_id', id)
      .gte('start_date', startDate).lte('start_date', endDate)
      .order('applied_at', { ascending: false })
      .limit(100),

    // overtime_requests
    supabaseAdmin.from('overtime_requests')
      .select('id, applies_to_year, applies_to_month, hours, compensation_type, status, submitted_at')
      .eq('employee_id', id)
      .gte('applies_to_year', sixMonthsBefore.getUTCFullYear())
      .order('submitted_at', { ascending: false })
      .limit(50),

    // comp_time_balance:當前可用補休(含 expiring soon、status='active')
    supabaseAdmin.from('comp_time_balance')
      .select('id, hours_total, hours_used, hours_remaining, earned_at, expires_at, status')
      .eq('employee_id', id)
      .order('earned_at', { ascending: false })
      .limit(20),
  ]);

  // 任一段失敗 → 不致命、回部分資料 + error 字串給 frontend 顯示
  const errors = [];
  if (salaryRes.error)     errors.push({ source: 'salary_records', error: salaryRes.error.message });
  if (attendanceRes.error) errors.push({ source: 'attendance', error: attendanceRes.error.message });
  if (leavesRes.error)     errors.push({ source: 'leave_requests', error: leavesRes.error.message });
  if (overtimeRes.error)   errors.push({ source: 'overtime_requests', error: overtimeRes.error.message });
  if (compBalanceRes.error)errors.push({ source: 'comp_time_balance', error: compBalanceRes.error.message });

  return res.status(200).json({
    employee: emp,
    history: {
      window: { start: startDate, end: endDate, anchor: anchorIso },
      salary: salaryRes.data || [],
      attendance: attendanceRes.data || [],
      leave_requests: leavesRes.data || [],
      overtime_requests: overtimeRes.data || [],
      comp_time_balance: compBalanceRes.data || [],
    },
    errors: errors.length ? errors : undefined,
  });
}
