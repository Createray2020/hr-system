// api/attendance/index.js — GET list
import { supabase } from '../../lib/supabase.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') {
    const { employee_id, month, date, status } = req.query;
    let q = supabase.from('attendance').select('*').order('work_date', { ascending: false });
    if (employee_id) q = q.eq('employee_id', employee_id);
    if (status)      q = q.eq('status', status);
    if (date)        q = q.eq('work_date', date);
    if (month) {
      const [y, m] = month.split('-');
      const start   = `${y}-${m.padStart(2,'0')}-01`;
      const endDate = new Date(parseInt(y), parseInt(m), 0);
      const end     = `${endDate.getFullYear()}-${String(endDate.getMonth()+1).padStart(2,'0')}-${String(endDate.getDate()).padStart(2,'0')}`;
      q = q.gte('work_date', start).lte('work_date', end);
    }
    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json(data);
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
