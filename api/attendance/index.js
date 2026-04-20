// api/attendance/index.js — GET list / POST manual entry / POST punch (merged)
// POST ?_action=punch → 打卡（原 punch.js）
import { supabase } from '../../lib/supabase.js';
import { requireAuth, getEmployee } from '../../lib/auth.js';

const WORK_START_HOUR = 9;

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') {
    // ── GET today's punch record (_action=today) ──────────────────────────
    if (req.query._action === 'today') {
      const { employee_id } = req.query;
      if (!employee_id) return res.status(400).json({ error: '缺少 employee_id' });
      const now = new Date();
      const localMs = now.getTime() + (8 * 60 + now.getTimezoneOffset()) * 60000;
      const local = new Date(localMs);
      const today = `${local.getFullYear()}-${String(local.getMonth()+1).padStart(2,'0')}-${String(local.getDate()).padStart(2,'0')}`;
      const { data, error } = await supabase.from('attendance').select('*')
        .eq('employee_id', employee_id).eq('work_date', today).single();
      if (error && error.code !== 'PGRST116') return res.status(500).json({ error: error.message });
      if (!data) return res.status(200).json({ date: today, punch_in: null, punch_out: null });
      const fmtTime = iso => {
        if (!iso) return null;
        const d = new Date(iso);
        const h = d.getUTCHours() + 8;
        return `${String(h >= 24 ? h-24 : h).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')}`;
      };
      return res.status(200).json({ date: today, punch_in: fmtTime(data.clock_in), punch_out: fmtTime(data.clock_out), status: data.status, work_hours: data.work_hours });
    }

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

  if (req.method === 'POST') {
    // ── 打卡 (_action=punch) ─────────────────────────────────────────
    if (req.query._action === 'punch') {
      const { employee_id, type } = req.body;
      if (!employee_id || !['in','out'].includes(type))
        return res.status(400).json({ error: '缺少必要參數' });

      const user = await requireAuth(req, res);
      if (!user) return;
      const emp = await getEmployee(user);
      if (!emp) return res.status(403).json({ error: '找不到員工資料' });
      if (emp.id !== employee_id) return res.status(403).json({ error: '無法替他人打卡' });

      const now    = new Date();
      const today  = now.toISOString().split('T')[0];
      const timeStr = now.toISOString();
      const id     = `A${Date.now()}`;

      if (type === 'in') {
        const isLate = now.getHours() > WORK_START_HOUR ||
                       (now.getHours() === WORK_START_HOUR && now.getMinutes() > 5);
        const { data: existing } = await supabase
          .from('attendance').select('id').eq('employee_id', employee_id).eq('work_date', today).single();
        if (existing) {
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
        const { data: rec } = await supabase
          .from('attendance').select('*').eq('employee_id', employee_id).eq('work_date', today).single();
        if (!rec) return res.status(400).json({ error: '尚未上班打卡' });
        const clockIn   = rec.clock_in ? new Date(rec.clock_in) : null;
        const workHours = clockIn ? Math.round((now - clockIn) / 36000) / 100 : 0;
        const otHours   = Math.max(0, Math.round((workHours - 8) * 2) / 2);
        const { error } = await supabase.from('attendance')
          .update({ clock_out: timeStr, work_hours: workHours, overtime_hours: otHours })
          .eq('id', rec.id);
        if (error) return res.status(500).json({ error: error.message });
        return res.status(200).json({ message: '下班打卡成功', time: timeStr, work_hours: workHours, overtime_hours: otHours });
      }
    }

    // ── 人工補登（原 manual.js 邏輯）───────────────────────────────────
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
