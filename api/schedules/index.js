// api/schedules/index.js — schedules CRUD + shift_types (merged to save function count)
import { supabase } from '../../lib/supabase.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── /api/shift-types routed here via vercel.json ──
  // Detected by ?_resource=shift_types query param
  if (req.query._resource === 'shift_types') {
    if (req.method === 'GET') {
      const { data, error } = await supabase.from('shift_types').select('*').order('id');
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json(data);
    }
    if (req.method === 'POST') {
      const { name, start_time, end_time, is_flexible, is_off, color } = req.body;
      if (!name) return res.status(400).json({ error: '班別名稱為必填' });
      const id = 'ST' + Date.now();
      const { error } = await supabase.from('shift_types').insert([{
        id, name,
        start_time:  start_time  || null,
        end_time:    end_time    || null,
        is_flexible: !!is_flexible,
        is_off:      !!is_off,
        color:       color || '#5B8DEF',
      }]);
      if (error) return res.status(500).json({ error: error.message });
      return res.status(201).json({ id, message: '班別已建立' });
    }
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ── Schedules ──
  if (req.method === 'GET') {
    try {
      const { dept, start, end, employee_id } = req.query;

      let q = supabase
        .from('schedules')
        .select('*, shift_types(name, color, is_off, is_flexible, start_time, end_time)')
        .order('work_date');
      if (start)       q = q.gte('work_date', start);
      if (end)         q = q.lte('work_date', end);
      if (employee_id) q = q.eq('employee_id', employee_id);
      if (dept)        q = q.eq('dept', dept);

      const { data: schedules, error } = await q;
      if (error) return res.status(500).json({ error: error.message });
      if (!schedules.length) return res.status(200).json([]);

      // Two-step: fetch employees
      const empIds = [...new Set(schedules.map(s => s.employee_id))];
      const { data: emps, error: empErr } = await supabase
        .from('employees').select('id, name, dept, avatar').in('id', empIds);
      if (empErr) return res.status(500).json({ error: empErr.message });

      const empMap = Object.fromEntries((emps || []).map(e => [e.id, e]));

      return res.status(200).json(schedules.map(s => {
        const emp = empMap[s.employee_id] || {};
        return {
          ...s,
          emp_name:    emp.name    || '',
          emp_dept:    emp.dept    || s.dept || '',
          avatar:      emp.avatar  || '',
          shift_name:  s.shift_types?.name        || '',
          shift_color: s.shift_types?.color       || '#5B8DEF',
          is_off:      s.shift_types?.is_off      || false,
          is_flexible: s.shift_types?.is_flexible || false,
          shift_start: s.start_time || s.shift_types?.start_time || '',
          shift_end:   s.end_time   || s.shift_types?.end_time   || '',
        };
      }));
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (req.method === 'POST') {
    try {
      const { employee_id, work_date, shift_type_id, start_time, end_time, note, dept, created_by } = req.body;
      if (!employee_id || !work_date || !shift_type_id)
        return res.status(400).json({ error: '缺少必填欄位' });

      const id = `S${employee_id}${work_date.replace(/-/g, '')}`;
      const { error } = await supabase.from('schedules').upsert([{
        id, employee_id, work_date, shift_type_id,
        start_time:  start_time || null,
        end_time:    end_time   || null,
        note:        note       || '',
        dept:        dept       || '',
        created_by:  created_by || null,
        updated_at:  new Date().toISOString(),
      }], { onConflict: 'employee_id,work_date' });

      if (error) return res.status(500).json({ error: error.message });
      return res.status(201).json({ id, message: '班表已儲存' });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
