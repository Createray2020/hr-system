// api/attendance/index.js
//
// 本檔同時服務兩條路徑：
//   舊路徑（legacy）：employee-app.html / dashboard.html
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

import { supabaseAdmin } from '../../lib/supabase.js';
import { requireAuth } from '../../lib/auth.js';
import {
  clockIn, clockOut,
  NoScheduleError, AlreadyClockedInError, NoOpenAttendanceError,
} from '../../lib/attendance/clock.js';
import { addDeptName } from '../../lib/dept-name-mapper.js';
import { applyExcludeSystemAccountsQuery } from '../../lib/salary/system-accounts.js';
import { applyLeaveOverlay, buildVirtualLeaveAttendance } from '../../lib/leave/overlay.js';

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
      const { data, error } = await supabaseAdmin.from('attendance').select('*')
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

    const { employee_id, month, date, status, all: allRecords, start, end, dept, dept_id } = req.query;

    // ── GET all employees' records (管理者用，JS 合併員工資料) ─────────────
    if (allRecords === 'true') {
      // 取打卡紀錄
      let q = supabaseAdmin.from('attendance').select('*').order('work_date', { ascending: false });
      if (start)  q = q.gte('work_date', start);
      if (end)    q = q.lte('work_date', end);
      if (status) q = q.eq('status', status);
      const { data: attData, error: attErr } = await q;
      if (attErr) return res.status(500).json({ error: attErr.message });

      // 取員工資料（一次全撈，在 JS 合併）
      const { data: empData } = await applyExcludeSystemAccountsQuery(
        supabaseAdmin.from('employees').select('id, name, dept_id, avatar, departments(name)')
      );
      addDeptName(empData);
      const empMap = {};
      (empData || []).forEach(e => { empMap[e.id] = e; });

      let rows = (attData || []).map(r => ({
        ...r,
        employees: empMap[r.employee_id] || null,
      }));

      if (dept_id)   rows = rows.filter(r => r.employees?.dept_id === dept_id);

      // 階段 B1:已有 attendance row 加 leave_overlay(post-hoc detection、UI 自己決定怎麼顯示)
      // 注意:?all=true 全員 enrichment、virtual row 補不補? 這裡量大、補 virtual 會多一輪 schedules 撈、
      //       且 admin 端如果想看「該日有 leave 但沒 attendance」可以另外開 schedule 頁、本 path 暫不補 virtual
      rows = await attachLeaveOverlayAttendance(rows, { virtualFromSchedules: false });
      return res.status(200).json(rows);
    }

    let q = supabaseAdmin.from('attendance').select('*').order('work_date', { ascending: false });
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

    // 階段 B1:已有 attendance row 加 leave_overlay + 補 virtual leave row
    // (cron 還沒跑時 attendance 沒 row、有 approved leave、補一個 virtual 給前端顯示「請假中」)
    const enriched = await attachLeaveOverlayAttendance(data || [], {
      virtualFromSchedules: true, employee_id, date, month,
    });
    return res.status(200).json(enriched);
  }

  if (req.method === 'POST') {
    // legacy ?_action=punch 員工打卡 path 已拔(0 frontend caller、WORK_START_HOUR=9
    // 寫死 ≠ 員工 schedule.start_time)。新路徑走 body { action: 'clock_in'|'clock_out' }
    // → handleNewPunch、commit a347cf5 / dashboard fix 之後 attendance.html /
    // employee-app.html 都已遷移。
    if (req.query._action === 'punch') {
      return res.status(410).json({
        error: 'GONE',
        detail: 'legacy ?_action=punch 已棄用、請改用 POST body { action: "clock_in"|"clock_out" }',
      });
    }

    // 既有 POST body { action: 'clock_in'|'clock_out' } 已在 handler 開頭分流到 handleNewPunch。
    // 走到這裡 = body 不是新 path、也不是 _action=punch legacy = 未知 shape、回 400。
    //
    // legacy manual punch shape body { employee_id, work_date, clock_in_time } 已拔
    // (0 frontend caller、無 requireAuth / 無 role gate、curl 任何 authed user 可寫
    //  任何人 attendance row 影響薪資結算 — CRITICAL 安全洞、Phase 2.x systematic
    //  audit 收尾一併拔)。HR 補登需求請走 PUT /api/attendance/[id](已有 BACKOFFICE_ROLES gate)。
    return res.status(400).json({
      error: 'INVALID_ACTION',
      detail: 'POST 必須 body { action: "clock_in" | "clock_out" }',
    });
  }

  if (req.method === 'DELETE') {
    // legacy fallback：vercel.json 的 /:id rewrite 已在 Batch 4 移除。
    // 此分支保留以防漏接(舊 client 直接 call ?_id=xxx)。正式路徑請走 [id].js。
    const id = req.query._id || req.url.split('/').pop().split('?')[0];
    if (!id || id === 'index') return res.status(400).json({ error: '缺少 id' });
    const { error } = await supabaseAdmin.from('attendance').delete().eq('id', id);
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

  // GPS Phase A:body.geo validation(三態 undefined / null / object)
  // body.geo === undefined → 不傳給 lib(向後相容、lib 不動 GPS 欄位)
  // body.geo === null      → pass null(denied 語意)
  // body.geo === object    → 驗 lat/lng/accuracy 範圍、pass object
  const geoValidation = validateGeoBody(req.body?.geo);
  if (!geoValidation.ok) {
    return res.status(400).json({ error: 'INVALID_GEO', detail: geoValidation.detail });
  }
  const geo = geoValidation.geo;  // undefined / null / { lat, lng, accuracy }

  const timestamp = new Date().toISOString();

  try {
    if (action === 'clock_in') {
      const att = await clockIn(makeRepo(), { employee_id, timestamp, geo });
      return res.status(200).json({ ok: true, attendance: att });
    }
    if (action === 'clock_out') {
      const att = await clockOut(makeRepo(), { employee_id, timestamp, geo });
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

// GPS Phase A:body.geo 三態驗證(undefined / null / object)
//   undefined → ok、回 { ok:true, geo:undefined }
//   null      → ok、回 { ok:true, geo:null }
//   object    → 驗 lat/lng/accuracy 範圍(任一欄位可為 null、表示部分缺)
//   string / array / number / boolean / function → 400 INVALID_GEO
function validateGeoBody(g) {
  if (g === undefined) return { ok: true, geo: undefined };
  if (g === null)      return { ok: true, geo: null };
  if (typeof g !== 'object' || Array.isArray(g)) {
    return { ok: false, detail: 'geo must be object or null' };
  }
  // lat
  if (g.lat !== undefined && g.lat !== null) {
    if (typeof g.lat !== 'number' || !Number.isFinite(g.lat)) {
      return { ok: false, detail: 'geo.lat must be number or null' };
    }
    if (g.lat < -90 || g.lat > 90) {
      return { ok: false, detail: 'geo.lat must be in [-90, 90]' };
    }
  }
  // lng
  if (g.lng !== undefined && g.lng !== null) {
    if (typeof g.lng !== 'number' || !Number.isFinite(g.lng)) {
      return { ok: false, detail: 'geo.lng must be number or null' };
    }
    if (g.lng < -180 || g.lng > 180) {
      return { ok: false, detail: 'geo.lng must be in [-180, 180]' };
    }
  }
  // accuracy(>= 0、unit: meters)
  if (g.accuracy !== undefined && g.accuracy !== null) {
    if (typeof g.accuracy !== 'number' || !Number.isFinite(g.accuracy)) {
      return { ok: false, detail: 'geo.accuracy must be number or null' };
    }
    if (g.accuracy < 0) {
      return { ok: false, detail: 'geo.accuracy must be >= 0' };
    }
  }
  // 多餘 key 忽略(向前相容)
  return {
    ok: true,
    geo: {
      lat: g.lat ?? null,
      lng: g.lng ?? null,
      accuracy: g.accuracy ?? null,
    },
  };
}

// 抽出去因為 [id].js 跟 anomaly.js 也用同一組 supabase repo 介面。
export function makeRepo() {
  return {
    async findSchedulesForDate(employee_id, date) {
      const { data: scheds, error } = await supabaseAdmin
        .from('schedules')
        .select('id, employee_id, work_date, period_id, segment_no, start_time, end_time, crosses_midnight, scheduled_work_minutes')
        .eq('employee_id', employee_id).eq('work_date', date)
        .order('segment_no');
      if (error) throw error;
      if (!scheds || scheds.length === 0) return [];
      const periodIds = [...new Set(scheds.map(s => s.period_id).filter(Boolean))];
      if (periodIds.length === 0) return []; // 沒 period_id 的 legacy schedule 視同沒排班
      const { data: periods } = await supabaseAdmin
        .from('schedule_periods').select('id, status').in('id', periodIds);
      // 可打卡 status：published（主管已對員工公告）/ locked（當月開始後鎖定）/
      // approved（向後相容：早期只到 approved 就視為可打卡的 period）
      // [test-contract] tests/attendance-clock.test.js 鎖定此白名單(跟 public/attendance.html 同步)
      const PUNCHABLE_PERIOD_STATUS = new Set(['published', 'locked', 'approved']);
      const valid = new Set((periods || [])
        .filter(p => PUNCHABLE_PERIOD_STATUS.has(p.status)).map(p => p.id));
      return scheds.filter(s => valid.has(s.period_id));
    },

    async findHolidayByDate(date) {
      const { data, error } = await supabaseAdmin
        .from('holidays').select('id, holiday_type')
        .eq('date', date).limit(1).maybeSingle();
      if (error) throw error;
      return data || null;
    },

    async findAttendanceByDateSegment(employee_id, date, segment_no) {
      const { data, error } = await supabaseAdmin
        .from('attendance').select('*')
        .eq('employee_id', employee_id).eq('work_date', date).eq('segment_no', segment_no)
        .maybeSingle();
      if (error) throw error;
      return data || null;
    },

    async findOpenAttendanceForEmployee(employee_id, candidate_dates) {
      const { data, error } = await supabaseAdmin
        .from('attendance').select('*')
        .eq('employee_id', employee_id).in('work_date', candidate_dates)
        .is('clock_out', null).not('clock_in', 'is', null)
        .order('clock_in', { ascending: false }).limit(1);
      if (error) throw error;
      return (data && data[0]) || null;
    },

    async findScheduleById(id) {
      const { data, error } = await supabaseAdmin
        .from('schedules').select('*').eq('id', id).maybeSingle();
      if (error) throw error;
      return data || null;
    },

    async upsertAttendance(row) {
      const { data, error } = await supabaseAdmin
        .from('attendance')
        .upsert([row], { onConflict: 'id' })
        .select().maybeSingle();
      if (error) throw error;
      return data;
    },

    async findActiveOfficeLocations() {
      // GPS Phase A:lib/clock.js 用、撈所有 active 據點給 validateGeofence 比 radius
      const { data, error } = await supabaseAdmin
        .from('office_locations')
        .select('id, lat, lng, radius_m')
        .eq('is_active', true);
      if (error) throw error;
      return data || [];
    },

    async updateAttendance(id, patch) {
      const { data, error } = await supabaseAdmin
        .from('attendance').update(patch).eq('id', id).select().maybeSingle();
      if (error) throw error;
      return data;
    },
  };
}

// ─── leave_overlay helper(階段 B1)──────────────────────────────────────
// 對 attendance rows 加 leave_overlay 欄位 + 視情況補 virtual rows(該日 approved leave
// 但 attendance 還沒寫入、cron 隔天才跑)。詳:lib/leave/overlay.js
async function attachLeaveOverlayAttendance(rows, opts = {}) {
  const { virtualFromSchedules = false, employee_id, date, month } = opts;

  // 收集 employee_ids + date range(從 rows 推、若 rows 空則從 query params 推)
  let empIds = [...new Set((rows || []).map(r => r.employee_id).filter(Boolean))];
  let dates  = (rows || []).map(r => r.work_date).filter(Boolean);
  if (employee_id && !empIds.includes(employee_id)) empIds.push(employee_id);

  // 計算日期區間
  let minDate, maxDate;
  if (date) {
    minDate = maxDate = date;
  } else if (month) {
    const [y, m] = month.split('-');
    minDate = `${y}-${m.padStart(2,'0')}-01`;
    const lastDay = new Date(parseInt(y), parseInt(m), 0);
    maxDate = `${lastDay.getFullYear()}-${String(lastDay.getMonth()+1).padStart(2,'0')}-${String(lastDay.getDate()).padStart(2,'0')}`;
  } else if (dates.length) {
    dates.sort();
    minDate = dates[0];
    maxDate = dates[dates.length - 1];
  } else {
    return rows.map(r => ({ ...r, leave_overlay: null }));
  }
  if (!empIds.length) return rows.map(r => ({ ...r, leave_overlay: null }));

  const dayStart = `${minDate}T00:00:00+08:00`;
  const dayEnd   = `${maxDate}T23:59:59+08:00`;

  // approved leaves
  const { data: leaves } = await supabaseAdmin
    .from('leave_requests')
    .select('id, employee_id, leave_type, start_at, end_at, hours, finalized_hours, status')
    .is('deleted_at', null)
    .in('employee_id', empIds)
    .eq('status', 'approved')
    .lte('start_at', dayEnd)
    .gte('end_at', dayStart);

  const types = [...new Set((leaves || []).map(l => l.leave_type).filter(Boolean))];
  let nameMap = {};
  if (types.length) {
    const { data: lts } = await supabaseAdmin
      .from('leave_types').select('code, name_zh').in('code', types);
    nameMap = Object.fromEntries((lts || []).map(t => [t.code, t.name_zh]));
  }

  // 既有 row 加 leave_overlay
  let enriched = applyLeaveOverlay(rows, leaves || [], nameMap);

  // virtual row(只在單員工 / 月查的場景補、避免 ?all=true 全員大批 schedule fetch)
  if (virtualFromSchedules && (leaves || []).length > 0) {
    const { data: schedules } = await supabaseAdmin
      .from('schedules').select('id, employee_id, work_date, segment_no')
      .in('employee_id', empIds)
      .gte('work_date', minDate).lte('work_date', maxDate);
    const virtuals = buildVirtualLeaveAttendance(rows || [], schedules || [], leaves || [], nameMap);
    if (virtuals.length) enriched = [...enriched, ...virtuals];
  }
  return enriched;
}
