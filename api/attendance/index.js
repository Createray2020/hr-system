// api/attendance/index.js
//
// 本檔同時服務兩條路徑：
//   舊路徑（legacy）：employee-app.html / dashboard.html / attendance.html.old
//     - GET  ?employee_id&month / ?date / ?all=true&start&end / ?_action=today
//     - POST ?_action=punch  body { employee_id, type:'in'|'out' }
//     - POST manual          body { employee_id, work_date, clock_in_time, ... }
//     - DELETE ?_id=xxx      （legacy fallback；vercel.json 的 /:id rewrite 已移除，
//                             正式路徑改走 [id].js,本分支保留以防漏接）
//   新路徑（Batch 4+）：attendance.html (新版) / attendance-admin.html
//     - POST body { action: 'clock_in' | 'clock_out' } → 走 lib/attendance/clock.js
//     - timestamp 由 server 產生，不接受 client 傳
//
// _resource=shift_types 不適用此檔（那是 schedules 的）。
//
// 對應設計文件：docs/attendance-system-design-v1.md §4.2.4
// 對應實作計畫：docs/attendance-system-implementation-plan-v1.md §6.4
//
// Routing 假設（Vercel file-system routing）：
//   `api/attendance/[id].js` 跟 `api/attendance/anomaly.js` 同目錄共存。
//   Vercel 慣例:靜態檔名(anomaly.js)優先於 dynamic route([id].js)。
//   本 repo precedent: api/holidays/{[id].js, import.js, index.js} 已驗證 work,
//   不需要 vercel.json rewrite 輔助。Batch 10 上 prod 後手測再次確認。

import { supabase } from '../../lib/supabase.js';
import { requireAuth, getEmployee } from '../../lib/auth.js';
import {
  clockIn, clockOut,
  NoScheduleError, AlreadyClockedInError, NoOpenAttendanceError,
} from '../../lib/attendance/clock.js';

const WORK_START_HOUR = 9;

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── 新路徑分流（POST body.action = clock_in / clock_out）──
  if (req.method === 'POST' && req.body && (req.body.action === 'clock_in' || req.body.action === 'clock_out')) {
    return handleNewPunch(req, res);
  }

  // ── Legacy: GET ─────────────────────────────────────────────
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

    const { employee_id, month, date, status, all: allRecords, start, end, dept } = req.query;

    // ── GET all employees' records (管理者用，JS 合併員工資料) ─────────────
    if (allRecords === 'true') {
      // 取打卡紀錄
      let q = supabase.from('attendance').select('*').order('work_date', { ascending: false });
      if (start)  q = q.gte('work_date', start);
      if (end)    q = q.lte('work_date', end);
      if (status) q = q.eq('status', status);
      const { data: attData, error: attErr } = await q;
      if (attErr) return res.status(500).json({ error: attErr.message });

      // 取員工資料（一次全撈，在 JS 合併）
      const { data: empData } = await supabase.from('employees').select('id, name, dept, avatar');
      const empMap = {};
      (empData || []).forEach(e => { empMap[e.id] = e; });

      let rows = (attData || []).map(r => ({
        ...r,
        employees: empMap[r.employee_id] || null,
      }));

      if (dept) rows = rows.filter(r => r.employees?.dept === dept);
      return res.status(200).json(rows);
    }

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
    // ── 打卡 (_action=punch) ─── legacy(employee-app.html / attendance.html.old)
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

    const clockInIso  = clock_in_time  ? `${work_date}T${clock_in_time}:00+08:00`  : null;
    const clockOutIso = clock_out_time ? `${work_date}T${clock_out_time}:00+08:00` : null;
    let workHours = 0;
    if (clockInIso && clockOutIso) {
      workHours = Math.round((new Date(clockOutIso) - new Date(clockInIso)) / 36000) / 100;
    }

    const payload = {
      clock_in:       clockInIso,
      clock_out:      clockOutIso,
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

  if (req.method === 'DELETE') {
    // legacy fallback：vercel.json 的 /:id rewrite 已在 Batch 4 移除。
    // 此分支保留以防漏接(舊 client 直接 call ?_id=xxx)。正式路徑請走 [id].js。
    const id = req.query._id || req.url.split('/').pop().split('?')[0];
    if (!id || id === 'index') return res.status(400).json({ error: '缺少 id' });
    const { error } = await supabase.from('attendance').delete().eq('id', id);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ message: '已刪除' });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

// ─────────────────────────────────────────────────────────────────
// 新路徑（Batch 4+）：用 lib/attendance/clock.js + repo 注入
// ─────────────────────────────────────────────────────────────────

async function handleNewPunch(req, res) {
  const caller = await requireAuth(req, res);
  if (!caller) return;

  const { action } = req.body;
  // 規範：employee 自己打卡。employee_id 由 caller 決定，不接受 client 傳。
  // HR / admin 也不能透過此 endpoint 替他人打卡(走 [id].js PUT 修改)。
  const employee_id = caller.id;
  if (!employee_id) return res.status(401).json({ error: 'caller has no employee id' });

  const timestamp = new Date().toISOString();

  try {
    if (action === 'clock_in') {
      const att = await clockIn(makeRepo(), { employee_id, timestamp });
      return res.status(200).json({ ok: true, attendance: att });
    }
    if (action === 'clock_out') {
      const att = await clockOut(makeRepo(), { employee_id, timestamp });
      return res.status(200).json({ ok: true, attendance: att });
    }
    return res.status(400).json({ error: 'unknown action' });
  } catch (e) {
    if (e instanceof NoScheduleError)        return res.status(400).json({ error: 'NO_SCHEDULE',         detail: e.message });
    if (e instanceof AlreadyClockedInError)  return res.status(409).json({ error: 'ALREADY_CLOCKED_IN',  detail: e.message });
    if (e instanceof NoOpenAttendanceError)  return res.status(409).json({ error: 'NO_OPEN_ATTENDANCE',  detail: e.message });
    console.error('[attendance:newPunch]', e);
    return res.status(500).json({ error: 'internal', detail: e.message });
  }
}

// 抽出去因為 [id].js 跟 anomaly.js 也用同一組 supabase repo 介面。
export function makeRepo() {
  return {
    async findSchedulesForDate(employee_id, date) {
      const { data: scheds, error } = await supabase
        .from('schedules')
        .select('id, employee_id, work_date, period_id, segment_no, start_time, end_time, crosses_midnight, scheduled_work_minutes')
        .eq('employee_id', employee_id).eq('work_date', date)
        .order('segment_no');
      if (error) throw error;
      if (!scheds || scheds.length === 0) return [];
      const periodIds = [...new Set(scheds.map(s => s.period_id).filter(Boolean))];
      if (periodIds.length === 0) return []; // 沒 period_id 的 legacy schedule 視同沒排班
      const { data: periods } = await supabase
        .from('schedule_periods').select('id, status').in('id', periodIds);
      const valid = new Set((periods || [])
        .filter(p => p.status === 'locked' || p.status === 'approved').map(p => p.id));
      return scheds.filter(s => valid.has(s.period_id));
    },

    async findHolidayByDate(date) {
      const { data, error } = await supabase
        .from('holidays').select('id, holiday_type')
        .eq('date', date).limit(1).maybeSingle();
      if (error) throw error;
      return data || null;
    },

    async findAttendanceByDateSegment(employee_id, date, segment_no) {
      const { data, error } = await supabase
        .from('attendance').select('*')
        .eq('employee_id', employee_id).eq('work_date', date).eq('segment_no', segment_no)
        .maybeSingle();
      if (error) throw error;
      return data || null;
    },

    async findOpenAttendanceForEmployee(employee_id, candidate_dates) {
      const { data, error } = await supabase
        .from('attendance').select('*')
        .eq('employee_id', employee_id).in('work_date', candidate_dates)
        .is('clock_out', null).not('clock_in', 'is', null)
        .order('clock_in', { ascending: false }).limit(1);
      if (error) throw error;
      return (data && data[0]) || null;
    },

    async findScheduleById(id) {
      const { data, error } = await supabase
        .from('schedules').select('*').eq('id', id).maybeSingle();
      if (error) throw error;
      return data || null;
    },

    async upsertAttendance(row) {
      const { data, error } = await supabase
        .from('attendance')
        .upsert([row], { onConflict: 'id' })
        .select().maybeSingle();
      if (error) throw error;
      return data;
    },

    async updateAttendance(id, patch) {
      const { data, error } = await supabase
        .from('attendance').update(patch).eq('id', id).select().maybeSingle();
      if (error) throw error;
      return data;
    },
  };
}
