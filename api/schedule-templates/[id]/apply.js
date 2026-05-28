// api/schedule-templates/[id]/apply.js
// POST /api/schedule-templates/:id/apply { period_id, employee_id? }
// C8-2/3：員工 / 主管把 template 套用到一個 period

import { supabaseAdmin } from '../../../lib/supabase.js';
import { requireAuth } from '../../../lib/auth.js';
import { isBackofficeRole } from '../../../lib/roles.js';
import { canEmployeeEditSchedule, canManagerEditSchedule } from '../../../lib/schedule/permissions.js';
import { calculateScheduleWorkMinutes } from '../../../lib/schedule/work-hours.js';
import { sendPushToEmployees, createNotifications } from '../../../lib/push.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const caller = await requireAuth(req, res);
  if (!caller) return;

  const templateId = req.query.id;
  if (!templateId) return res.status(400).json({ error: 'NO_TEMPLATE_ID' });

  const { period_id, employee_id: bodyEmpId } = req.body || {};
  if (!period_id) return res.status(400).json({ error: 'NO_PERIOD_ID' });

  // 1. 撈 template + 驗權限（owner only、Q2=I）
  const { data: template, error: tErr } = await supabaseAdmin
    .from('schedule_templates').select('*').eq('id', templateId).maybeSingle();
  if (tErr) return res.status(500).json({ error: tErr.message });
  if (!template) return res.status(404).json({ error: 'TEMPLATE_NOT_FOUND' });

  const isHR = isBackofficeRole(caller);
  if (template.owner_id !== caller.id && !isHR) {
    return res.status(403).json({ error: 'NOT_OWNER' });
  }

  // 驗 pattern
  if (template.pattern?.type !== 'weekly' || !template.pattern?.shifts) {
    return res.status(400).json({ error: 'PATTERN_INVALID' });
  }

  // 2. 撈 period
  const { data: period, error: pErr } = await supabaseAdmin
    .from('schedule_periods').select('*').eq('id', period_id).maybeSingle();
  if (pErr) return res.status(500).json({ error: pErr.message });
  if (!period) return res.status(404).json({ error: 'PERIOD_NOT_FOUND' });

  const targetEmpId = bodyEmpId || period.employee_id;
  const isSelf = targetEmpId === caller.id && period.employee_id === caller.id;
  const today = new Date().toISOString().slice(0, 10);

  // 3. 權限檢查（員工 / 主管 / HR）
  let actorKind;
  if (isSelf) {
    const r = canEmployeeEditSchedule(period, caller.id, today);
    if (!r.ok) return res.status(403).json({ error: r.reason });
    actorKind = 'employee';
  } else {
    // 主管 / HR：用 canManagerEditSchedule（先驗 period 級權限、過去日另外過濾）
    let inSameDept = false;
    if (caller.is_manager === true && caller.dept_id) {
      const { data: emp } = await supabaseAdmin
        .from('employees').select('dept_id').eq('id', period.employee_id).maybeSingle();
      inSameDept = !!emp && emp.dept_id === caller.dept_id;
    }
    const manager = {
      id: caller.id, role: caller.role,
      is_manager: caller.is_manager === true,
      in_same_dept: inSameDept,
    };
    // 不傳 workDate：先驗 period 級權限（NOT_MANAGER_OR_HR）
    const r = canManagerEditSchedule(period, manager, today);
    if (!r.ok) return res.status(403).json({ error: r.reason });
    actorKind = isHR ? 'hr' : 'manager';
  }

  // 4. 撈 shift_types（cache）
  const { data: shiftTypesArr } = await supabaseAdmin
    .from('shift_types').select('*');
  const shiftMap = Object.fromEntries((shiftTypesArr || []).map(s => [s.id, s]));

  // 4b. 撈本 period 已有的員工 __OFF__ 日 → 套範本要跳過、不覆蓋員工心意
  const { data: existingOff } = await supabaseAdmin
    .from('schedules')
    .select('work_date')
    .eq('period_id', period_id)
    .eq('shift_type_id', 'ST003')
    .eq('note', '__OFF__');
  const offDates = new Set((existingOff || []).map(s => s.work_date));

  // 5. 計算 period 範圍每天 dayOfWeek、組裝 rows
  const { period_start, period_end } = period;
  if (!period_start || !period_end) {
    return res.status(400).json({ error: 'PERIOD_RANGE_INVALID' });
  }

  // 公告後過濾過去 work_date（C5 規則、HR 不限）
  const isPublished =
    period.status === 'approved' || period.status === 'locked' || period.status === 'published';
  const skipPastDays = !isHR && isPublished;

  const rows = [];
  let appliedCount = 0;
  let skippedPast = 0;
  let offCount = 0;
  let skippedExistingOff = 0;

  const start = new Date(period_start);
  const end = new Date(period_end);
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const dateStr = d.toISOString().slice(0, 10);
    const dow = d.getDay();
    const value = template.pattern.shifts[String(dow)];

    // C5：過去日期跳過
    if (skipPastDays && dateStr <= today) {
      skippedPast++;
      continue;
    }

    // 員工已標 __OFF__ 的日 → 跳過、不覆蓋員工心意
    if (offDates.has(dateStr)) {
      skippedExistingOff++;
      continue;
    }

    let shiftTypeId = value;
    let note = '';

    // 'OFF' → ST003 + note='__OFF__'（對齊員工 wish-or-none）
    if (value === 'OFF') {
      shiftTypeId = 'ST003';
      note = '__OFF__';
      offCount++;
    }

    const shift = shiftMap[shiftTypeId];
    if (!shift) {
      // 跳過無效 shift_type、不阻擋整批
      continue;
    }

    const startTime = shift.start_time;
    const endTime = shift.end_time;
    // shift_types 無 crosses_midnight 欄位、由 end<start 自動判定
    const crossesMidnight = !!(startTime && endTime && endTime < startTime);
    const minutes = calculateScheduleWorkMinutes(
      startTime, endTime, shift.break_minutes || 0, crossesMidnight,
    );

    const id = `S${targetEmpId}${dateStr.replace(/-/g, '')}_1`;
    rows.push({
      id,
      period_id,
      employee_id: targetEmpId,
      work_date: dateStr,
      shift_type_id: shiftTypeId,
      start_time: startTime,
      end_time: endTime,
      crosses_midnight: crossesMidnight,
      scheduled_work_minutes: minutes,
      segment_no: 1,
      note,
      created_by: caller.id,
      updated_by: caller.id,
      updated_at: new Date().toISOString(),
    });
    appliedCount++;
  }

  if (rows.length === 0) {
    return res.status(200).json({
      applied: 0, skipped_past: skippedPast, off_count: offCount,
      skipped_existing_off: skippedExistingOff, total: 0,
      message: '無有效日期可套用',
    });
  }

  // 6. 批次 upsert（onConflict 覆蓋）
  const { error: upsertErr } = await supabaseAdmin
    .from('schedules')
    .upsert(rows, { onConflict: 'employee_id,work_date,segment_no' });
  if (upsertErr) return res.status(500).json({ error: upsertErr.message });

  // 7. 通知（主管 / HR apply → 通知員工 1 個合併通知）
  if (actorKind !== 'employee') {
    try {
      const payload = {
        type: 'schedule',
        title: '主管已套用班表',
        body: `你的 ${period_start} ~ ${period_end} 排班已套用模板「${template.name}」`,
        url: '/employee-schedule.html',
        tag: `template-applied-${period_id}`,
      };
      Promise.allSettled([
        sendPushToEmployees([targetEmpId], payload),
        createNotifications([targetEmpId], payload),
      ]).catch(() => {});
    } catch (notifyErr) {
      console.error('[apply-template] notify failed:', notifyErr);
    }
  }

  return res.status(200).json({
    applied: appliedCount,
    skipped_past: skippedPast,
    off_count: offCount,
    skipped_existing_off: skippedExistingOff,
    total: appliedCount + skippedPast + skippedExistingOff,
    template_name: template.name,
  });
}
