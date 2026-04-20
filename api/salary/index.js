// api/salary/index.js — GET list / POST batch（合併自 salary/batch.js）
// GET  /api/salary              → 薪資清單
// POST /api/salary?_action=batch → 批次產生草稿
import { supabase } from '../../lib/supabase.js';

function calcAttendanceBonus(emp) {
  if (!emp) return 0;
  if (emp.employment_type === 'part_time') return 0;
  if (['manager','ceo','chairman'].includes(emp.role)) return 0;
  if (emp.is_manager === true) return 0;
  return parseFloat(emp.attendance_bonus) || 0;
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── GET: 薪資清單 ───────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    const { year, month, dept, status, employee_id } = req.query;
    let q = supabase.from('salary_records')
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
      const noBonus = !emp || emp.employment_type === 'part_time' ||
                      ['manager','ceo','chairman'].includes(emp.role) ||
                      emp.is_manager === true;
      const correctedBonus = noBonus ? 0 : (r.bonus || 0);
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
        employees:      undefined,
      };
    });
    return res.status(200).json(rows);
  }

  // ── POST ?_action=batch: 批次產生薪資草稿 ──────────────────────────────────
  if (req.method === 'POST' && req.query._action === 'batch') {
    const { year, month } = req.body;
    if (!year || !month) return res.status(400).json({ error: '缺少 year/month' });

    const { data: emps, error: empErr } = await supabase
      .from('employees')
      .select('id, employment_type, base_salary, attendance_bonus, grade_allowance, manager_allowance, extra_allowance, hourly_rate, role, is_manager, has_insurance')
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

    // Fetch insurance settings for employee contribution amounts
    const { data: insData } = await supabase
      .from('insurance_settings').select('employee_id, labor_ins_employee, health_ins_employee');
    const insMap = {};
    (insData || []).forEach(i => { insMap[i.employee_id] = i; });

    // Delete existing drafts for this period before regenerating
    await supabase.from('salary_records')
      .delete()
      .eq('year', parseInt(year))
      .eq('month', parseInt(month))
      .eq('status', 'draft');

    const records = emps.map(emp => {
      const isPart = emp.employment_type === 'part_time';
      const ym     = `S${emp.id}${year}${String(month).padStart(2,'0')}`;

      if (isPart) {
        const totalHours = workHoursMap[emp.id] || 0;
        const hourlyRate = parseFloat(emp.hourly_rate) || 200;
        return {
          id: ym, employee_id: emp.id,
          year: parseInt(year), month: parseInt(month),
          base_salary: 0, overtime_pay: 0, bonus: 0, allowance: 0, extra_allowance: 0,
          deduct_absence: 0, deduct_labor_ins: 0, deduct_health_ins: 0, deduct_tax: 0,
          work_hours: totalHours, hourly_rate: hourlyRate,
          employment_type: 'part_time',
          status: 'draft',
        };
      } else {
        const base       = parseFloat(emp.base_salary)       || 30000;
        const attBonus   = calcAttendanceBonus(emp);
        const gradeAllow = parseFloat(emp.grade_allowance)   || 0;
        const mgrAllow   = parseFloat(emp.manager_allowance) || 0;
        const extraAllow = parseFloat(emp.extra_allowance)   || 0;

        const ins = insMap[emp.id];
        const absentDays   = absentMap[emp.id] || 0;
        const deductAbsent = Math.round((base / 30) * absentDays);
        const laborIns     = emp.has_insurance ? (ins?.labor_ins_employee  || 0) : 0;
        const healthIns    = emp.has_insurance ? (ins?.health_ins_employee || 0) : 0;

        return {
          id: ym, employee_id: emp.id,
          year: parseInt(year), month: parseInt(month),
          base_salary: base, overtime_pay: 0,
          bonus: attBonus, allowance: gradeAllow + mgrAllow, extra_allowance: extraAllow,
          deduct_absence: deductAbsent, deduct_labor_ins: laborIns,
          deduct_health_ins: healthIns, deduct_tax: 0,
          work_hours: null, hourly_rate: null,
          employment_type: 'full_time',
          status: 'draft',
        };
      }
    });

    const { error } = await supabase.from('salary_records').insert(records);
    if (error) return res.status(500).json({ error: error.message });

    return res.status(200).json({ created: records.length, message: '批次產生完成' });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
