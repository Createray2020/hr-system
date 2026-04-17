// api/leave.js
import { supabase } from '../lib/supabase.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  const { id } = req.query;
  if (!id) return res.status(400).json({ error: '缺少 id' });

  if (req.method === 'GET') {
    const { data, error } = await supabase
      .from('leave_requests')
      .select('*, employees!inner(name, dept, position, avatar)')
      .eq('id', id).single();
    if (error) return res.status(404).json({ error: '找不到假單' });
    return res.status(200).json({
      ...data, emp_name: data.employees.name, dept: data.employees.dept,
      position: data.employees.position, avatar: data.employees.avatar, employees: undefined,
    });
  }

  if (req.method === 'PUT') {
    const { status, handler_note } = req.body;
    if (!['approved','rejected'].includes(status))
      return res.status(400).json({ error: '無效的 status' });
    const { error } = await supabase.from('leave_requests')
      .update({ status, handler_note: handler_note||'', handled_at: new Date().toISOString() })
      .eq('id', id);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ message: '審核完成' });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
