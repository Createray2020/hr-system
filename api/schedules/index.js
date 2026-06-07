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
import { canAccessBackoffice, isBackofficeRole, isExecutiveRole, BACKOFFICE_ROLES } from '../../lib/roles.js';
import { canEmployeeEditSchedule, canManagerEditSchedule, checkEmployeeShiftRestricted } from '../../lib/schedule/permissions.js';
import { logScheduleChange } from '../../lib/schedule/change-logger.js';
import { calculateScheduleWorkMinutes } from '../../lib/schedule/work-hours.js';
import { sendPushToRoles, createNotificationsForRoles, sendPushToEmployees, createNotifications } from '../../lib/push.js';
import { addDeptName } from '../../lib/dept-name-mapper.js';
import { applyExcludeSystemAccountsQuery } from '../../lib/salary/system-accounts.js';
import { resolveAuthScopeWithDeptIds, makeDeptEmpIdsRepo, canSeeEmployee } from '../../lib/auth-scope.js';
import { applyLeaveOverlay, markPostHocFromAttendance } from '../../lib/leave/overlay.js';
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

      const { dept, start, end, employee_id, month } = req.query;

      // calendar.html 帶 ?month=YYYY-MM、legacy handler 原本沒讀此 param、又沒帶 start/end →
      // query 不加 work_date filter → 撈全表 → 被 Supabase 預設 1000 筆 limit 砍(按 work_date ASC、
      // 月底資料漏)。此處用 month 推算範圍當 fallback、保留 start/end 顯式呼叫的相容性。
      let effectiveStart = start;
      let effectiveEnd = end;
      if (!effectiveStart && !effectiveEnd && typeof month === 'string') {
        const [yStr, mStr] = month.split('-');
        const y = parseInt(yStr, 10);
        const m = parseInt(mStr, 10);
        if (Number.isInteger(y) && Number.isInteger(m) && m >= 1 && m <= 12) {
          const lastDay = new Date(y, m, 0).getDate();  // m 1-indexed、day=0 推上月最後日 = 當月最後日
          effectiveStart = `${y}-${String(m).padStart(2,'0')}-01`;
          effectiveEnd   = `${y}-${String(m).padStart(2,'0')}-${String(lastDay).padStart(2,'0')}`;
        }
      }

      let q = supabaseAdmin
        .from('schedules')
        .select('*, shift_types(name, color, is_off, is_flexible, start_time, end_time, break_start, break_end, break_minutes)')
        .order('work_date');
      if (effectiveStart) q = q.gte('work_date', effectiveStart);
      if (effectiveEnd)   q = q.lte('work_date', effectiveEnd);

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
      const { data: emps, error: empErr } = await applyExcludeSystemAccountsQuery(
        supabaseAdmin.from('employees').select('id, name, dept_id, avatar, departments(name)').in('id', empIds)
      );
      if (empErr) return res.status(500).json({ error: empErr.message });
      addDeptName(emps);

      const empMap = Object.fromEntries((emps || []).map(e => [e.id, e]));

      const enriched = schedules.map(s => {
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
      });
      // 階段 B1:加 leave_overlay 欄位
      const withOverlay = await attachLeaveOverlay(enriched);
      return res.status(200).json(withOverlay);
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

  // 階段 B1:加 leave_overlay 欄位、approved leave 覆蓋顯示(不動 source data)
  const enriched = await attachLeaveOverlay(data || []);
  return res.status(200).json({ schedules: enriched });
}

// ─── leave_overlay helper(階段 B1)──────────────────────────────────────
// 從 schedules / attendance rows 抓 employee_ids + date range、撈 approved leave_requests、
// 用 lib/leave/overlay.js applyLeaveOverlay 加 leave_overlay 欄位。
// 詳:lib/leave/overlay.js + tests/leave-overlay.test.js
async function attachLeaveOverlay(rows) {
  if (!rows.length) return rows;
  const empIds = [...new Set(rows.map(r => r.employee_id).filter(Boolean))];
  const dates  = rows.map(r => r.work_date).filter(Boolean).sort();
  if (!empIds.length || !dates.length) return rows.map(r => ({ ...r, leave_overlay: null }));
  const minDate = dates[0];
  const maxDate = dates[dates.length - 1];
  const dayStart = `${minDate}T00:00:00+08:00`;
  const dayEnd   = `${maxDate}T23:59:59+08:00`;

  // 撈該員工集合 + 該日期區間內、status='approved' 的 leave_requests
  const { data: leaves } = await supabaseAdmin
    .from('leave_requests')
    .select('id, employee_id, leave_type, start_at, end_at, hours, finalized_hours, status')
    .is('deleted_at', null)
    .in('employee_id', empIds)
    .eq('status', 'approved')
    .lte('start_at', dayEnd)
    .gte('end_at', dayStart);

  // 撈 leave_types name_zh map(只撈出現在 leaves 裡的 type、避免 over-fetch)
  const types = [...new Set((leaves || []).map(l => l.leave_type).filter(Boolean))];
  let nameMap = {};
  if (types.length) {
    const { data: lts } = await supabaseAdmin
      .from('leave_types').select('code, name_zh').in('code', types);
    nameMap = Object.fromEntries((lts || []).map(t => [t.code, t.name_zh]));
  }
  let enriched = applyLeaveOverlay(rows, leaves || [], nameMap);

  // 階段 B1 Task 3:對 schedule rows 加 post_hoc_leave (反推 attendance.clock_in)
  if ((leaves || []).length > 0) {
    const { data: atts } = await supabaseAdmin
      .from('attendance').select('employee_id, work_date, clock_in')
      .in('employee_id', empIds)
      .gte('work_date', minDate).lte('work_date', maxDate)
      .not('clock_in', 'is', null);
    enriched = markPostHocFromAttendance(enriched, atts || []);
  }
  return enriched;
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

  // 2026-06 防禦:work_date 必須落在 period 範圍內,避免把跨月日期塞進別月 period_id
  // (schedule_periods UNIQUE(employee_id, year, month) 保證一員工一月一 period,跨月寫
  // 進別 period_id 是邏輯錯誤)
  if (period.period_start && period.period_end &&
      (String(work_date) < String(period.period_start) || String(work_date) > String(period.period_end))) {
    return res.status(422).json({
      error: 'WORK_DATE_OUT_OF_PERIOD',
      detail: `work_date ${work_date} 不在 period ${period.period_start} ~ ${period.period_end} 範圍內`,
      period_start: period.period_start, period_end: period.period_end,
    });
  }

  // 權限：員工 vs 主管/HR
  const today = new Date().toISOString().slice(0, 10);
  const isSelf = caller.id && caller.id === employee_id;
  // 2026-06-07:isSelf 分流加身分判斷 — 主管 / executive(ceo/chairman/admin)改自己 → 走主管分支
  // (canManagerEditSchedule、未來日可改、published+today/past 擋 MANAGER_LATE_DENIED);
  // 一般員工改自己 → 維持受限路徑(canEmployeeEditSchedule + checkEmployeeShiftRestricted)
  const isManagerActor = caller.is_manager === true || isExecutiveRole(caller.role);
  let allowed = false;
  let isLateChange = false;
  let actorKind = 'employee';

  if (isSelf && !isManagerActor) {
    const r = canEmployeeEditSchedule(period, employee_id, today);
    allowed = r.ok;
    if (!r.ok) return res.status(403).json({ error: r.reason });

    // G1:員工只能標「希望休假」(ST003 + __OFF__) 或留空
    const r2 = checkEmployeeShiftRestricted(req.body);
    if (!r2.ok) return res.status(403).json({ error: r2.reason });
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
