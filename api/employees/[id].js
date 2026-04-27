// api/employees/[id].js — GET one / PUT update / DELETE / /me route
import { supabase } from '../../lib/supabase.js';
import { requireRole } from '../../lib/auth.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { id } = req.query;

  // /api/employees/me — 用 JWT 找自己
  if (id === 'me') {
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !user) return res.status(401).json({ error: 'Invalid token' });
    const { data, error } = await supabase
      .from('employees').select('*').eq('email', user.email).single();
    if (error) {
      return res.status(200).json({ id: null, name: user.email.split('@')[0], email: user.email, role: 'employee' });
    }
    return res.status(200).json(data);
  }

  // GET — 不需要權限驗證
  if (req.method === 'GET') {
    const { data, error } = await supabase.from('employees').select('*').eq('id', id).single();
    if (error) return res.status(404).json({ error: '找不到員工' });
    return res.status(200).json(data);
  }

  if (req.method === 'PUT') {
    try {
      const caller = await requireRole(req, res, ['hr', 'ceo', 'chairman', 'admin'], { allowManager: true });
      if (!caller) return;

      const body = req.body;
      // 前端負責計算薪資欄位後傳入，PUT 只負責寫入 employees 資料表
      const { error } = await supabase
        .from('employees')
        .update({ ...body, updated_at: new Date().toISOString() })
        .eq('id', id);
      if (error) return res.status(500).json({ error: error.message });

      // ── 薪資變動時檢查勞健保級距是否需要更新 ──────────────────────────
      const salaryFields = ['base_salary','attendance_bonus','grade_allowance','manager_allowance','extra_allowance'];
      const hasSalaryChange = salaryFields.some(f => body[f] !== undefined);

      if (hasSalaryChange) {
        const { data: updatedEmp } = await supabase
          .from('employees').select('*').eq('id', id).single();

        if (updatedEmp && updatedEmp.employment_type !== 'part_time' && updatedEmp.has_insurance !== false) {
          const newMonthly = (updatedEmp.base_salary||0) + (updatedEmp.attendance_bonus||0) +
                             (updatedEmp.grade_allowance||0) + (updatedEmp.manager_allowance||0) +
                             (updatedEmp.extra_allowance||0);

          const { data: ins } = await supabase
            .from('insurance_settings').select('*').eq('employee_id', id).single();

          if (ins && ins.has_insurance !== false) {
            const { data: laborBracket } = await supabase
              .from('labor_insurance_brackets').select('*')
              .lte('monthly_wage_min', newMonthly).gte('monthly_wage_max', newMonthly)
              .single();

            const { data: healthBracket } = await supabase
              .from('health_insurance_brackets').select('*')
              .lte('monthly_wage_min', newMonthly).gte('monthly_wage_max', newMonthly)
              .single();

            const laborChanged  = laborBracket?.insured_salary  && laborBracket.insured_salary  !== Number(ins.labor_ins_bracket);
            const healthChanged = healthBracket?.insured_salary && healthBracket.insured_salary !== Number(ins.health_ins_bracket);

            if (laborChanged || healthChanged) {
              const changeId = 'ICR' + Date.now();
              const deps = ins.health_ins_dependents || 0;

              await supabase.from('insurance_change_requests').insert([{
                id: changeId,
                employee_id: id,
                old_monthly_salary:  Number(ins.labor_ins_bracket) || 0,
                new_monthly_salary:  newMonthly,
                old_labor_bracket:   ins.labor_ins_bracket,
                old_labor_employee:  ins.labor_ins_employee,
                old_labor_company:   ins.labor_ins_company,
                old_health_bracket:  ins.health_ins_bracket,
                old_health_employee: ins.health_ins_employee,
                old_health_company:  ins.health_ins_company,
                new_labor_bracket:   laborBracket?.insured_salary   || ins.labor_ins_bracket,
                new_labor_employee:  laborBracket?.employee_premium  || ins.labor_ins_employee,
                new_labor_company:   laborBracket?.company_premium   || ins.labor_ins_company,
                new_health_bracket:  healthBracket?.insured_salary   || ins.health_ins_bracket,
                new_health_employee: healthBracket
                  ? (healthBracket.employee_premium||0) + deps * (healthBracket.per_dependent||0)
                  : ins.health_ins_employee,
                new_health_company:  healthBracket?.company_premium  || ins.health_ins_company,
                trigger_reason: '薪資調整觸發自動試算',
                status: 'pending',
              }]);

              return res.status(200).json({
                message: '員工資料已更新',
                insurance_change: {
                  triggered: true,
                  change_id: changeId,
                  labor_changed:  !!laborChanged,
                  health_changed: !!healthChanged,
                  old_labor_bracket:   ins.labor_ins_bracket,
                  old_health_bracket:  ins.health_ins_bracket,
                  old_labor_employee:  ins.labor_ins_employee,
                  old_health_employee: ins.health_ins_employee,
                  new_labor_bracket:   laborBracket?.insured_salary,
                  new_health_bracket:  healthBracket?.insured_salary,
                  new_labor_employee:  laborBracket?.employee_premium,
                  new_health_employee: healthBracket
                    ? (healthBracket.employee_premium||0) + deps * (healthBracket.per_dependent||0)
                    : ins.health_ins_employee,
                }
              });
            }
          }
        }
      }

      return res.status(200).json({ message: '已更新' });
    } catch(e) {
      return res.status(500).json({ error: e.message, stack: e.stack });
    }
  }

  if (req.method === 'DELETE') {
    const caller = await requireRole(req, res, ['hr', 'admin', 'ceo']);
    if (!caller) return;
    const { error } = await supabase.from('employees').update({ status: 'resigned' }).eq('id', id);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ message: '已設為離職' });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
