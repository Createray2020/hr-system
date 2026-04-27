// api/schedules/index.js
//
// 本檔同時服務兩條路徑：
//   舊路徑（legacy）：employee-app.html / calendar.html 用 dept/start/end 查
//   新路徑（Batch 3+）：employee-schedule.html / schedule.html 用 period_id/year+month 查
//   兩條路徑透過 query / body 形狀分流；_resource=shift_types 分支獨立。
//
// 共用：同一個 schedules 表、同一個 schema、同一個 supabase client。
// work_date 是兩條路徑共用的核心欄位；新路徑「不」對舊路徑有任何假設。
//
// 對應設計文件：docs/attendance-system-design-v1.md §4.2.2
// 對應實作計畫：docs/attendance-system-implementation-plan-v1.md §5.8

import { supabase } from '../../lib/supabase.js';
import { requireRoleOrPass } from '../../lib/auth.js';
import { canEmployeeEditSchedule, canManagerEditSchedule } from '../../lib/schedule/permissions.js';
import { logScheduleChange } from '../../lib/schedule/change-logger.js';
import { calculateScheduleWorkMinutes } from '../../lib/schedule/work-hours.js';
import { sendPushToRoles, createNotificationsForRoles } from '../../lib/push.js';

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

  // ── 分流：新路徑 vs 舊路徑 ──
  const isNewGet  = req.method === 'GET'  && (req.query.period_id || req.query.year);
  const isNewPost = req.method === 'POST' && req.body && req.body.period_id;

  if (isNewGet)  return handleNewGet(req, res);
  if (isNewPost) return handleNewPost(req, res);

  // ── Schedules（legacy，原邏輯一行不動）──
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

// ─────────────────────────────────────────────────────────────────
// 新路徑（Batch 3+）：用 schedule_periods + segment_no + work-hours 計算
// ─────────────────────────────────────────────────────────────────

async function handleNewGet(req, res) {
  const caller = await requireRoleOrPass(req, res, []);
  if (!caller) return;

  const { period_id, employee_id, year, month } = req.query;

  let q = supabase.from('schedules').select('*').order('work_date').order('segment_no');
  if (period_id) q = q.eq('period_id', period_id);
  if (employee_id) q = q.eq('employee_id', employee_id);
  if (year)  q = q.gte('work_date', `${parseInt(year)}-01-01`).lte('work_date', `${parseInt(year)}-12-31`);
  if (year && month) {
    const y = parseInt(year), m = parseInt(month);
    const start = `${y}-${String(m).padStart(2,'0')}-01`;
    const last = new Date(Date.UTC(y, m, 0)).toISOString().slice(0,10);
    q = q.gte('work_date', start).lte('work_date', last);
  }

  // 員工只能看自己（dev mode 寬鬆）
  const callerIsManagerOrHR = caller.is_manager === true || ['hr', 'admin', 'ceo'].includes(caller.role || '');
  if (!callerIsManagerOrHR && caller.id) q = q.eq('employee_id', caller.id);

  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ schedules: data || [] });
}

async function handleNewPost(req, res) {
  const caller = await requireRoleOrPass(req, res, []);
  if (!caller) return;

  const {
    period_id, employee_id, work_date,
    shift_type_id, start_time, end_time, crosses_midnight,
    break_minutes, segment_no, note,
  } = req.body || {};

  if (!period_id || !employee_id || !work_date) {
    return res.status(400).json({ error: 'period_id / employee_id / work_date 必填' });
  }

  const { data: period, error: pErr } = await supabase
    .from('schedule_periods').select('*').eq('id', period_id).maybeSingle();
  if (pErr) return res.status(500).json({ error: pErr.message });
  if (!period) return res.status(404).json({ error: 'period not found' });

  // 權限：員工 vs 主管/HR
  const today = new Date().toISOString().slice(0, 10);
  const isSelf = caller.id && caller.id === employee_id;
  let allowed = false;
  let isLateChange = false;
  let actorKind = 'employee';

  if (isSelf) {
    const r = canEmployeeEditSchedule(period, employee_id, today);
    allowed = r.ok;
    if (!r.ok) return res.status(403).json({ error: r.reason });
  } else {
    const isHR = ['hr', 'admin', 'ceo'].includes(caller.role || '');
    let manages = false;
    if (caller.is_manager === true && caller.id) {
      const { data: emp } = await supabase.from('employees')
        .select('manager_id').eq('id', employee_id).maybeSingle();
      manages = !!emp && emp.manager_id === caller.id;
    }
    const manager = {
      id: caller.id, role: caller.role,
      is_manager: caller.is_manager === true,
      manages_employee_id: manages ? employee_id : null,
    };
    const r = canManagerEditSchedule(period, manager, today);
    if (!r.ok) return res.status(403).json({ error: r.reason });
    allowed = true;
    actorKind = isHR ? 'hr' : 'manager';
    // 精準判定：locked 期間且改的就是 today 那天才算 late
    isLateChange = !!r.isLateChange && work_date === today;
  }

  if (!allowed) return res.status(403).json({ error: 'forbidden' });

  // 計算 scheduled_work_minutes
  const seg = parseInt(segment_no) || 1;
  const cm = !!crosses_midnight || (start_time && end_time && end_time < start_time);
  const minutes = calculateScheduleWorkMinutes(start_time, end_time, break_minutes, cm);

  const id = `S${employee_id}${work_date.replace(/-/g, '')}_${seg}`;
  const row = {
    id,
    employee_id,
    work_date,
    period_id,
    shift_type_id: shift_type_id || null,
    start_time:    start_time || null,
    end_time:      end_time   || null,
    crosses_midnight: cm,
    scheduled_work_minutes: minutes,
    segment_no: seg,
    note: note || '',
    dept: period.dept || '',
    created_by: caller.id || null,
    updated_at: new Date().toISOString(),
  };

  // 撈舊值給 log
  const { data: before } = await supabase.from('schedules').select('*').eq('id', id).maybeSingle();

  const { data, error } = await supabase
    .from('schedules')
    .upsert([row], { onConflict: 'employee_id,work_date,segment_no' })
    .select().maybeSingle();
  if (error) return res.status(500).json({ error: error.message });

  // 寫 log（best-effort）
  try {
    await logScheduleChange(repoFromSupabase(), {
      schedule_id: id,
      employee_id,
      change_type: changeTypeFor(actorKind, isLateChange),
      changed_by: caller.id || employee_id,
      before_data: before || null,
      after_data:  data || row,
      reason: req.body?.reason || null,
      isLateChange,
    });
  } catch (e) {
    console.error('[schedules:newPost] log failed:', e.message);
  }

  // late_change 即時推播 HR + CEO
  if (isLateChange) {
    const payload = {
      title: '排班當日異動',
      body: `${employee_id} ${work_date} 排班於工作日當天被調整`,
      url: '/schedule',
      tag: 'late-change',
    };
    Promise.allSettled([
      sendPushToRoles(['hr', 'ceo'], payload),
      createNotificationsForRoles(['hr', 'ceo'], payload),
    ]).catch(() => {});
  }

  return res.status(201).json({ schedule: data, isLateChange });
}

function changeTypeFor(actorKind, isLateChange) {
  if (isLateChange) return 'late_change';
  if (actorKind === 'employee') return 'employee_draft';
  return 'manager_adjust';
}

function repoFromSupabase() {
  return {
    async insertScheduleChangeLog(row) {
      const { data, error } = await supabase
        .from('schedule_change_logs').insert([row]).select().single();
      if (error) throw error;
      return data;
    },
  };
}
