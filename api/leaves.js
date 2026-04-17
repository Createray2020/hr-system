// api/leaves.js
import { supabase } from '../lib/supabase.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') {
    const { status, dept, type, search } = req.query;

    // 步驟一：查詢 leave_requests
    let q = supabase.from('leave_requests')
      .select('*')
      .order('applied_at', { ascending: false });
    if (status) q = q.eq('status', status);
    if (type)   q = q.eq('leave_type', type);

    const { data: leaves, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    if (!leaves.length) return res.status(200).json([]);

    // 步驟二：查詢相關員工
    const empIds = [...new Set(leaves.map(l => l.employee_id))];
    const { data: emps, error: empErr } = await supabase
      .from('employees')
      .select('id, name, dept, position, avatar')
      .in('id', empIds);
    if (empErr) return res.status(500).json({ error: empErr.message });

    const empMap = Object.fromEntries(emps.map(e => [e.id, e]));

    // 手動合併，套用 dept / search 過濾
    let rows = leaves.map(l => {
      const e = empMap[l.employee_id] || {};
      return { ...l, emp_name: e.name, dept: e.dept, position: e.position, avatar: e.avatar };
    });
    if (dept)   rows = rows.filter(r => r.dept === dept);
    if (search) rows = rows.filter(r => (r.emp_name || '').includes(search));

    return res.status(200).json(rows);
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
