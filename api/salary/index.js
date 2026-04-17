// api/salary/index.js — GET list / POST batch
import { supabase } from '../../lib/supabase.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') {
    const { year, month, dept, status, employee_id } = req.query;
    let q = supabase.from('salary_records')
      .select(`*, employees!inner(name, dept, avatar)`)
      .order('employee_id');

    if (year)        q = q.eq('year',  parseInt(year));
    if (month)       q = q.eq('month', parseInt(month));
    if (status)      q = q.eq('status', status);
    if (employee_id) q = q.eq('employee_id', employee_id);
    if (dept)        q = q.eq('employees.dept', dept);

    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });

    const rows = data.map(r => ({
      ...r,
      emp_name: r.employees.name,
      dept:     r.employees.dept,
      avatar:   r.employees.avatar,
      employees: undefined,
    }));
    return res.status(200).json(rows);
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
