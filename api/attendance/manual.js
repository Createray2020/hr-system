// api/attendance/manual.js — POST 人工補登
import { supabase } from '../../lib/supabase.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { employee_id, work_date, clock_in_time, clock_out_time, status, overtime_hours, note } = req.body;
  if (!employee_id || !work_date) return res.status(400).json({ error: '缺少必填欄位' });

  const clockIn  = clock_in_time  ? `${work_date}T${clock_in_time}:00+08:00`  : null;
  const clockOut = clock_out_time ? `${work_date}T${clock_out_time}:00+08:00` : null;

  let workHours = 0;
  if (clockIn && clockOut) {
    workHours = Math.round((new Date(clockOut) - new Date(clockIn)) / 36000) / 100;
  }

  const id = `AM${Date.now()}`;

  // Upsert（若同一天同員工已有紀錄則更新）
  const { error } = await supabase.from('attendance').upsert([{
    id, employee_id, work_date,
    clock_in:       clockIn,
    clock_out:      clockOut,
    work_hours:     workHours,
    overtime_hours: parseFloat(overtime_hours)||0,
    status:         status || 'normal',
    note:           note || '',
  }], { onConflict: 'employee_id,work_date', ignoreDuplicates: false });

  if (error) return res.status(500).json({ error: error.message });
  return res.status(201).json({ message: '補登成功' });
}
