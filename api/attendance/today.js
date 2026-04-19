// api/attendance/today.js — GET today's punch record for an employee
import { supabase } from '../../lib/supabase.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { employee_id } = req.query;
  if (!employee_id) return res.status(400).json({ error: '缺少 employee_id' });

  // Use UTC+8 for "today"
  const now = new Date();
  const tzOffset = 8 * 60;
  const localMs  = now.getTime() + (tzOffset + now.getTimezoneOffset()) * 60000;
  const local     = new Date(localMs);
  const today     = `${local.getFullYear()}-${String(local.getMonth()+1).padStart(2,'0')}-${String(local.getDate()).padStart(2,'0')}`;

  const { data, error } = await supabase
    .from('attendance')
    .select('*')
    .eq('employee_id', employee_id)
    .eq('work_date', today)
    .single();

  if (error && error.code !== 'PGRST116') {
    return res.status(500).json({ error: error.message });
  }

  if (!data) {
    return res.status(200).json({ date: today, punch_in: null, punch_out: null });
  }

  const fmtTime = iso => {
    if (!iso) return null;
    const d = new Date(iso);
    const h = d.getUTCHours() + 8; // convert to UTC+8
    const actualH = h >= 24 ? h - 24 : h;
    return `${String(actualH).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')}`;
  };

  return res.status(200).json({
    date:       today,
    punch_in:   fmtTime(data.clock_in),
    punch_out:  fmtTime(data.clock_out),
    status:     data.status,
    work_hours: data.work_hours,
  });
}
