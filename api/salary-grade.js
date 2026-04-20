// api/salary-grade.js
// GET  /api/salary-grade                         → 職等薪資級距
// GET  /api/salary-grade?_resource=insurance     → 員工勞健保設定清單
// GET  /api/salary-grade?_resource=insurance&brackets=labor  → 勞保級距表
// GET  /api/salary-grade?_resource=insurance&brackets=health → 健保級距表
// POST /api/salary-grade?_resource=insurance     → upsert 員工設定
import { supabase } from '../lib/supabase.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { _resource, employee_id, brackets } = req.query;

  // ── Insurance resource ────────────────────────────────────────────────────
  if (_resource === 'insurance') {
    if (req.method === 'GET') {
      if (brackets === 'labor') {
        const { data, error } = await supabase
          .from('labor_insurance_brackets').select('*').order('bracket_level');
        if (error) return res.status(500).json({ error: error.message });
        return res.status(200).json(data);
      }
      if (brackets === 'health') {
        const { data, error } = await supabase
          .from('health_insurance_brackets').select('*').order('bracket_level');
        if (error) return res.status(500).json({ error: error.message });
        return res.status(200).json(data);
      }
      // Insurance settings list (join employees)
      let q = supabase.from('insurance_settings')
        .select('*, employees(name, emp_no, dept, position, base_salary, attendance_bonus, grade_allowance, manager_allowance, extra_allowance, has_insurance, employment_type)');
      if (employee_id) q = q.eq('employee_id', employee_id).single();
      const { data, error } = await q;
      if (error) return res.status(employee_id ? 404 : 500).json({ error: error.message });
      return res.status(200).json(data);
    }
    if (req.method === 'POST') {
      const body = req.body;
      if (!body.employee_id) return res.status(400).json({ error: '缺少 employee_id' });
      const id = 'INS_' + body.employee_id;
      const { error } = await supabase.from('insurance_settings')
        .upsert([{ id, ...body, updated_at: new Date().toISOString() }],
          { onConflict: 'employee_id' });
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ message: '已儲存' });
    }
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ── Salary grade (original) ───────────────────────────────────────────────
  if (req.method === 'GET') {
    const { data, error } = await supabase
      .from('salary_grade').select('*').order('grade').order('grade_level');
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json(data);
  }
  return res.status(405).json({ error: 'Method not allowed' });
}
