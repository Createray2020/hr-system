// api/attendance/punch.js — POST 打卡
import { supabase } from '../../lib/supabase.js';

const WORK_START_HOUR = 9;   // 09:00 以後算遲到

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { employee_id, type } = req.body;
  if (!employee_id || !['in','out'].includes(type)) {
    return res.status(400).json({ error: '缺少必要參數' });
  }

  const now     = new Date();
  const today   = now.toISOString().split('T')[0];
  const timeStr = now.toISOString();
  const id      = `A${Date.now()}`;

  if (type === 'in') {
    const isLate = now.getHours() >= WORK_START_HOUR && now.getMinutes() > 5;

    // 先查是否已有今日紀錄
    const { data: existing } = await supabase
      .from('attendance').select('id').eq('employee_id', employee_id).eq('work_date', today).single();

    if (existing) {
      // 更新上班時間
      const { error } = await supabase.from('attendance')
        .update({ clock_in: timeStr, status: isLate ? 'late' : 'normal' })
        .eq('id', existing.id);
      if (error) return res.status(500).json({ error: error.message });
    } else {
      const { error } = await supabase.from('attendance').insert([{
        id, employee_id, work_date: today,
        clock_in: timeStr,
        status: isLate ? 'late' : 'normal',
      }]);
      if (error) return res.status(500).json({ error: error.message });
    }
    return res.status(200).json({ message: '上班打卡成功', time: timeStr, status: isLate ? 'late' : 'normal' });
  }

  if (type === 'out') {
    // 找今日紀錄
    const { data: rec } = await supabase
      .from('attendance').select('*').eq('employee_id', employee_id).eq('work_date', today).single();

    if (!rec) return res.status(400).json({ error: '尚未上班打卡' });

    const clockIn    = rec.clock_in ? new Date(rec.clock_in) : null;
    const workHours  = clockIn ? Math.round((now - clockIn) / 36000) / 100 : 0;
    const otHours    = Math.max(0, Math.round((workHours - 8) * 2) / 2);

    const { error } = await supabase.from('attendance')
      .update({ clock_out: timeStr, work_hours: workHours, overtime_hours: otHours })
      .eq('id', rec.id);

    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ message: '下班打卡成功', time: timeStr, work_hours: workHours, overtime_hours: otHours });
  }
}
