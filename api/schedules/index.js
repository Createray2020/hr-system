// api/schedules/index.js
//
// 本檔同時服務兩條路徑：
//   舊路徑（legacy GET only）：calendar.html 用 dept/start/end/month 查
//   新路徑（Batch 3+）：employee-schedule.html / schedule.html 用 period_id/year+month 查
//   兩條路徑透過 query / body 形狀分流；_resource=shift_types 分支獨立。
//   Legacy POST 已於 cleanup 2 移除（無 caller、無 auth 安全洞）。
//
// 共用：同一個 schedules 表、同一個 schema、同一個 supabase client。
// work_date 是兩條路徑共用的核心欄位；新路徑「不」對舊路徑有任何假設。
//
// 對應設計文件：docs/attendance-system-design-v1.md §4.2.2
// 對應實作計畫：docs/attendance-system-implementation-plan-v1.md §5.8

import { supabaseAdmin } from '../../lib/supabase.js';
import { requireAuth, requireRole } from '../../lib/auth.js';
import { canAccessBackoffice, isBackofficeRole, BACKOFFICE_ROLES } from '../../lib/roles.js';
import { canEmployeeEditSchedule, canManagerEditSchedule } from '../../lib/schedule/permissions.js';
import { logScheduleChange } from '../../lib/schedule/change-logger.js';
import { calculateScheduleWorkMinutes } from '../../lib/schedule/work-hours.js';
import { sendPushToRoles, createNotificationsForRoles, sendPushToEmployees, createNotifications } from '../../lib/push.js';
import { addDeptName } from '../../lib/dept-name-mapper.js';
import { resolveAuthScopeWithDeptIds, makeDeptEmpIdsRepo, canSeeEmployee } from '../../lib/auth-scope.js';
import {
  listShiftTypes, createShiftType, updateShiftType, deleteShiftType,
} from '../../lib/shift-types/handler.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── /api/shift-types routed here via vercel.json ──
  // Detected by ?_resource=shift_types query param
  if (req.query._resource === 'shift_types') {
    if (req.method === 'GET') {
      const includeInactive = req.query.include_inactive === 'true' || req.query.include_inactive === '1';
      const r = await listShiftTypes(supabaseAdmin, { includeInactive });
      return res.status(r.status).json(r.body);
    }
    if (req.method === 'POST') {
      const caller = await requireRole(req, res, BACKOFFICE_ROLES, { allowManager: true });
      if (!caller) return;
      const r = await createShiftType(supabaseAdmin, req.body || {});
      return res.status(r.status).json(r.body);
    }
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ── /api/shift-types/:id routed here via vercel.json (PATCH / DELETE) ──
  if (req.query._resource === 'shift_types_item') {
    const caller = await requireRole(req, res, BACKOFFICE_ROLES, { allowManager: true });
    if (!caller) return;
    const itemId = req.query.id;
    if (req.method === 'PATCH') {
      const r = await updateShiftType(supabaseAdmin, itemId, req.body || {});
      return res.status(r.status).json(r.body);
    }
    if (req.method === 'DELETE') {
      const r = await deleteShiftType(supabaseAdmin, itemId);
      return res.status(r.status).json(r.body);
    }
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ── 分流：新路徑 vs 舊路徑 ──
  const isNewGet  = req.method === 'GET'  && (req.query.period_id || req.query.year);
  const isNewPost = req.method === 'POST' && req.body && req.body.period_id;

  if (isNewGet)  return handleNewGet(req, res);
  if (isNewPost) return handleNewPost(req, res);

  // ── Schedules（legacy）──
  if (req.method === 'GET') {
    try {
      const caller = await requireAuth(req, res);
      if (!caller) return;

      const { dept, start, end, employee_id } = req.query;

      let q = supabaseAdmin
        .from('schedules')
        .select('*, shift_types(name, color, is_off, is_flexible, start_time, end_time, break_start, break_end, break_minutes)')
        .order('work_date');
      if (start)       q = q.gte('work_date', start);
      if (end)         q = q.lte('work_date', end);

      // Phase 2:row-level scope filter
      // 既有 canAccessBackoffice 包 is_manager、主管被當 HR 看全公司、漏網。
      // 改 resolveAuthScope:HR 全部、主管 dept-scope、員工本人。
      const scope = await resolveAuthScopeWithDeptIds(caller, 'selfOrDept', makeDeptEmpIdsRepo(supabaseAdmin));
      if (employee_id) {
        if (!canSeeEmployee(scope, employee_id)) {
          return res.status(403).json({ error: 'Forbidden: 無權看此員工班表' });
        }
        q = q.eq('employee_id', employee_id);
      } else if (scope.mode === 'self') {
        q = q.eq('employee_id', scope.selfId);
      } else if (scope.mode === 'dept') {
        q = q.in('employee_id', [scope.selfId, ...(scope.deptEmpIds || [])]);
      }
      // mode='all' + 沒帶 employee_id → 不加 filter

      const { data: schedules, error } = await q;
      if (error) return res.status(500).json({ error: error.message });
      if (!schedules.length) return res.status(200).json([]);

      // Two-step: fetch employees
      const empIds = [...new Set(schedules.map(s => s.employee_id))];
      const { data: emps, error: empErr } = await supabaseAdmin
        .from('employees').select('id, name, dept_id, avatar, departments(name)').in('id', empIds);
      if (empErr) return res.status(500).json({ error: empErr.message });
      addDeptName(emps);

      const empMap = Object.fromEntries((emps || []).map(e => [e.id, e]));

      return res.status(200).json(schedules.map(s => {
        const emp = empMap[s.employee_id] || {};
        return {
          ...s,
          emp_name:    emp.name    || '',
          emp_dept_name: emp.dept_name || '',
          avatar:      emp.avatar  || '',
          shift_name:  s.shift_types?.name        || '',
          shift_color: s.shift_types?.color       || '#5B8DEF',
          is_off:      s.shift_types?.is_off      || false,
          is_flexible: s.shift_types?.is_flexible || false,
          shift_start: s.start_time || s.shift_types?.start_time || '',
          shift_end:   s.end_time   || s.shift_types?.end_time   || '',
          // 給 break-overlap.js 三類分流用(前端內嵌 mirror、後端 lib/schedule/break-overlap.js)
          break_start:   s.shift_types?.break_start   ?? null,
          break_end:     s.shift_types?.break_end     ?? null,
          break_minutes: s.shift_types?.break_minutes ?? null,
        };
      }));
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // body 有 period_id 的 POST 已在前面被 handleNewPost 接走、
  // 走到這裡代表確定無 period_id（legacy POST 已移除）。
  if (req.method === 'POST') {
    return res.status(400).json({
      error: 'POST /api/schedules requires period_id in body (legacy POST removed in cleanup)'
    });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

// ─────────────────────────────────────────────────────────────────
// 新路徑（Batch 3+）：用 schedule_periods + segment_no + work-hours 計算
// ─────────────────────────────────────────────────────────────────

async function handleNewGet(req, res) {
  const caller = await requireAuth(req, res);
  if (!caller) return;

  const { period_id, employee_id, year, month } = req.query;

  let q = supabaseAdmin.from('schedules').select('*').order('work_date').order('segment_no');
  if (period_id) q = q.eq('period_id', period_id);
  if (year)  q = q.gte('work_date', `${parseInt(year)}-01-01`).lte('work_date', `${parseInt(year)}-12-31`);
  if (year && month) {
    const y = parseInt(year), m = parseInt(month);
    const start = `${y}-${String(m).padStart(2,'0')}-01`;
    const last = new Date(Date.UTC(y, m, 0)).toISOString().slice(0,10);
    q = q.gte('work_date', start).lte('work_date', last);
  }

  // Phase 2:row-level scope filter(取代 canAccessBackoffice 包 is_manager 的漏網)
  // 員工本人 / 主管本部門 / HR 全部
  const scope = await resolveAuthScopeWithDeptIds(caller, 'selfOrDept', makeDeptEmpIdsRepo(supabaseAdmin));
  if (employee_id) {
    if (!canSeeEmployee(scope, employee_id)) {
      return res.status(403).json({ error: 'Forbidden: 無權看此員工班表' });
    }
    q = q.eq('employee_id', employee_id);
  } else if (scope.mode === 'self') {
    q = q.eq('employee_id', scope.selfId);
  } else if (scope.mode === 'dept') {
    q = q.in('employee_id', [scope.selfId, ...(scope.deptEmpIds || [])]);
  }
  // mode='all' + 沒帶 employee_id → 不加 filter

  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ schedules: data || [] });
}

async function handleNewPost(req, res) {
  const caller = await requireAuth(req, res);
  if (!caller) return;

  const {
    period_id, employee_id, work_date,
    shift_type_id, start_time, end_time, crosses_midnight,
    break_minutes, segment_no, note, status,
  } = req.body || {};

  if (!period_id || !employee_id || !work_date) {
    return res.status(400).json({ error: 'period_id / employee_id / work_date 必填' });
  }

  const { data: period, error: pErr } = await supabaseAdmin
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

    // Phase C 員工自助限制已移除（v2.5 改造）：
    // 員工填什麼班別都是 wish（靠 period.status='draft' 區分）、不再擋班別。
    // 主管在 schedule.html 公告才是正式班表。
  } else {
    const isHR = isBackofficeRole(caller);
    let inSameDept = false;
    if (caller.is_manager === true && caller.dept_id) {
      const { data: emp } = await supabaseAdmin.from('employees')
        .select('dept_id').eq('id', employee_id).maybeSingle();
      inSameDept = !!emp && emp.dept_id === caller.dept_id;
    }
    const manager = {
      id: caller.id, role: caller.role,
      is_manager: caller.is_manager === true,
      in_same_dept: inSameDept,
    };
    const r = canManagerEditSchedule(period, manager, today, work_date);
    if (!r.ok) return res.status(403).json({ error: r.reason });
    allowed = true;
    actorKind = isHR ? 'hr' : 'manager';
    // 精準判定：locked 期間且改的就是 today 那天才算 late
    isLateChange = !!r.isLateChange && work_date === today;
  }

  if (!allowed) return res.status(403).json({ error: 'forbidden' });

  // 計算 scheduled_work_minutes
  const seg = parseInt(segment_no) || 1;
  const cm = !!(crosses_midnight || (start_time && end_time && end_time < start_time));
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
    created_by: caller.id || null,
    ...(status && ['draft','confirmed','locked'].includes(status) ? { status } : {}),
    updated_at: new Date().toISOString(),
  };

  // 撈舊值給 log
  const { data: before } = await supabaseAdmin.from('schedules').select('*').eq('id', id).maybeSingle();

  const { data, error } = await supabaseAdmin
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
    // 補員工姓名(HR / CEO 看通知時要能辨識是誰)
    let empLabel = employee_id;
    try {
      const { data: emp } = await supabaseAdmin
        .from('employees').select('name').eq('id', employee_id).maybeSingle();
      if (emp?.name) empLabel = `${emp.name}(${employee_id})`;
    } catch (_) {}

    const payload = {
      title: '排班當日異動',
      body: `${empLabel} ${work_date} 排班於工作日當天被調整`,
      url: '/schedule',
      tag: 'late-change',
    };
    Promise.allSettled([
      sendPushToRoles(['hr', 'ceo'], payload),
      createNotificationsForRoles(['hr', 'ceo'], payload),
    ]).catch(() => {});
  }

  // C7-2:主管/HR 覆蓋員工 wish (ST003) → 通知員工
  if (actorKind !== 'employee' && before?.shift_type_id === 'ST003' && data?.shift_type_id !== 'ST003') {
    const wishPayload = {
      type: 'schedule',
      title: '主管已調整你的排班',
      body: `你 ${work_date} 的休假意願已改為班別`,
      url: '/employee-schedule.html',
      tag: `wish-overridden-${id}`,
    };
    Promise.allSettled([
      sendPushToEmployees([employee_id], wishPayload),
      createNotifications([employee_id], wishPayload),
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
      const { data, error } = await supabaseAdmin
        .from('schedule_change_logs').insert([row]).select().single();
      if (error) throw error;
      return data;
    },
  };
}
