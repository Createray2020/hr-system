// api/leaves.js
import { supabase } from '../lib/supabase.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') {
    const { status, dept, type, search } = req.query;
    let q = supabase.from('leave_requests')
      .select('*, employees!inner(name, dept, position, avatar)')
      .order('applied_at', { ascending: false });
    if (status) q = q.eq('status', status);
    if (type)   q = q.eq('leave_type', type);
    if (dept)   q = q.eq('employees.dept', dept);
    if (search) q = q.ilike('employees.name', `%${search}%`);
    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json(data.map(r => ({
      ...r, emp_name: r.employees.name, dept: r.employees.dept,
      position: r.employees.position, avatar: r.employees.avatar, employees: undefined,
    })));
  }

  if (req.method === 'POST') {
    const { employee_id, leave_type, start_date, end_date, days, reason } = req.body;
    if (!employee_id||!leave_type||!start_date||!end_date||!days)
      return res.status(400).json({ error: '缺少必填欄位' });
    const id = 'L' + Date.now();
    const { error } = await supabase.from('leave_requests')
      .insert([{ id, employee_id, leave_type, start_date, end_date, days, reason, status:'pending' }]);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(201).json({ id, message: '假單已建立' });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
