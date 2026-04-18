// api/attendance/index.js — GET list / POST manual entry (merged from manual.js)
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

  // POST — 人工補登（原 manual.js 邏輯）
  if (req.method === 'POST') {
    const { employee_id, work_date, clock_in_time, clock_out_time, status, overtime_hours, note } = req.body;
    if (!employee_id || !work_date) return res.status(400).json({ error: '缺少必填欄位' });

    const clockIn  = clock_in_time  ? `${work_date}T${clock_in_time}:00+08:00`  : null;
    const clockOut = clock_out_time ? `${work_date}T${clock_out_time}:00+08:00` : null;

    let workHours = 0;
    if (clockIn && clockOut) {
      workHours = Math.round((new Date(clockOut) - new Date(clockIn)) / 36000) / 100;
    }

    const payload = {
      clock_in:       clockIn,
      clock_out:      clockOut,
      work_hours:     workHours,
      overtime_hours: parseFloat(overtime_hours) || 0,
      status:         status || 'normal',
      note:           note   || '',
    };

    const { data: existing } = await supabase
      .from('attendance').select('id').eq('employee_id', employee_id).eq('work_date', work_date).single();

    let error;
    if (existing) {
      ({ error } = await supabase.from('attendance').update(payload).eq('id', existing.id));
    } else {
      ({ error } = await supabase.from('attendance').insert([{
        id: `AM${Date.now()}`, employee_id, work_date, ...payload
      }]));
    }

    if (error) return res.status(500).json({ error: error.message });
    return res.status(201).json({ message: '補登成功' });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
