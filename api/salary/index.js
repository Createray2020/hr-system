// api/salary/index.js — GET list / POST batch（合併自 salary/batch.js）
// GET  /api/salary              → 薪資清單
// POST /api/salary?_action=batch → 批次產生草稿
import { supabase } from '../../lib/supabase.js';

// 簡易勞健保費率（台灣 2024 參考值）
const LABOR_INS_RATE  = 0.001;   // 員工自付勞保費 0.1%
const HEALTH_INS_RATE = 0.0236;  // 健保費率 2.36%（員工自付 30%）
const TAX_RATE        = 0.05;    // 薪資所得稅 5%（簡化）
const LABOR_INS_CAP   = 45800;   // 投保薪資上限

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── GET: 薪資清單 ───────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    const { year, month, dept, status, employee_id } = req.query;
    let q = supabase.from('salary_records')
      .select(`*, employees!inner(name, dept, avatar)`)
      .order('employee_id');

    if (year)        q = q.eq('year',        parseInt(year));
    if (month)       q = q.eq('month',       parseInt(month));
    if (status)      q = q.eq('status',      status);
    if (employee_id) q = q.eq('employee_id', employee_id);
    if (dept)        q = q.eq('employees.dept', dept);

    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });

    const rows = data.map(r => ({
      ...r,
      emp_name:  r.employees.name,
      dept:      r.employees.dept,
      avatar:    r.employees.avatar,
      employees: undefined,
    }));
    return res.status(200).json(rows);
  }

  // ── POST ?_action=batch: 批次產生薪資草稿 ──────────────────────────────────
  if (req.method === 'POST' && req.query._action === 'batch') {
    const { year, month } = req.body;
    if (!year || !month) return res.status(400).json({ error: '缺少 year/month' });

    const { data: emps, error: empErr } = await supabase
      .from('employees')
      .select('id, employment_type, base_salary, attendance_bonus, grade_allowance, manager_allowance, extra_allowance, hourly_rate')
      .eq('status', 'active');
    if (empErr) return res.status(500).json({ error: empErr.message });

    const ymStart = `${year}-${String(month).padStart(2,'0')}-01`;
    const ymEnd   = `${year}-${String(month).padStart(2,'0')}-31`;

    const { data: attData } = await supabase
      .from('attendance').select('employee_id, work_hours, status')
      .gte('work_date', ymStart).lte('work_date', ymEnd);

    const workHoursMap = {}, absentMap = {};
    (attData || []).forEach(a => {
      workHoursMap[a.employee_id] = (workHoursMap[a.employee_id] || 0) + (a.work_hours || 0);
      absentMap[a.employee_id]    = (absentMap[a.employee_id]    || 0) + (a.status === 'absent' ? 1 : 0);
    });

    // Fetch insurance settings (use DB values instead of calculated rates)
    const { data: insData } = await supabase
      .from('insurance_settings').select('employee_id, has_insurance, labor_ins_employee, health_ins_employee');
    const insMap = {};
    (insData || []).forEach(i => { insMap[i.employee_id] = i; });

    const records = emps.map(emp => {
      const isPart = emp.employment_type === 'part_time';
      const ym     = `S${emp.id}${year}${String(month).padStart(2,'0')}`;

      if (isPart) {
        const totalHours = workHoursMap[emp.id] || 0;
        const hourlyRate = parseFloat(emp.hourly_rate) || 200;
        const gross      = Math.round(totalHours * hourlyRate);
        return {
          id: ym, employee_id: emp.id,
          year: parseInt(year), month: parseInt(month),
          base_salary: 0, overtime_pay: 0, bonus: 0, allowance: 0, extra_allowance: 0,
          deduct_absence: 0, deduct_labor_ins: 0, deduct_health_ins: 0, deduct_tax: 0,
          work_hours: totalHours, hourly_rate: hourlyRate,
          employment_type: 'part_time',
          gross_salary: gross, net_salary: gross,
          status: 'draft',
        };
      } else {
        const base       = parseFloat(emp.base_salary)       || 30000;
        const attBonus   = parseFloat(emp.attendance_bonus)  || 0;
        const gradeAllow = parseFloat(emp.grade_allowance)   || 0;
        const mgrAllow   = parseFloat(emp.manager_allowance) || 0;
        const extraAllow = parseFloat(emp.extra_allowance)   || 0;
        const gross      = base + attBonus + gradeAllow + mgrAllow + extraAllow;

        const ins = insMap[emp.id];
        const absentDays   = absentMap[emp.id] || 0;
        const deductAbsent = Math.round((base / 30) * absentDays);
        const laborIns     = (ins && ins.has_insurance !== false) ? (ins.labor_ins_employee  || 0) : 0;
        const healthIns    = (ins && ins.has_insurance !== false) ? (ins.health_ins_employee || 0) : 0;
        const tax          = gross > 88501 ? Math.round((gross - 88501) * TAX_RATE) : 0;
        const net          = gross - deductAbsent - laborIns - healthIns - tax;

        return {
          id: ym, employee_id: emp.id,
          year: parseInt(year), month: parseInt(month),
          base_salary: base, overtime_pay: 0,
          bonus: attBonus, allowance: gradeAllow + mgrAllow, extra_allowance: extraAllow,
          deduct_absence: deductAbsent, deduct_labor_ins: laborIns,
          deduct_health_ins: healthIns, deduct_tax: tax,
          work_hours: null, hourly_rate: null,
          employment_type: 'full_time',
          gross_salary: gross, net_salary: net,
          status: 'draft',
        };
      }
    });

    const { error } = await supabase.from('salary_records')
      .upsert(records, { onConflict: 'employee_id,year,month', ignoreDuplicates: true });
    if (error) return res.status(500).json({ error: error.message });

    return res.status(200).json({ created: records.length, message: '批次產生完成（已存在者略過）' });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
