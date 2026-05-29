#!/usr/bin/env node
// scripts/backfill_attendance_202605_warehouse.mjs
// 一次性 HR 後台批次補考勤 — 5 月倉儲後勤部 11 筆誤判修正
//
// 用法:
//   # dry-run(預設、不寫入):
//   node --env-file=.env.local scripts/backfill_attendance_202605_warehouse.mjs --actor=<employee_id>
//
//   # 實際寫入:
//   node --env-file=.env.local scripts/backfill_attendance_202605_warehouse.mjs --apply --actor=<employee_id>
//
// 環境變數:
//   SUPABASE_URL
//   SUPABASE_SERVICE_KEY 或 SUPABASE_SERVICE_ROLE_KEY
//
// Manifest(hardcode):
//   A. 補病假整天、不扣額度 — 6 筆
//   B. 補特休整天、扣特休 — 1 筆
//   C. 補休部分日 2.5h、扣補休 — 1 筆
//   D. 兼職誤排,刪 schedule + 刪 attendance — 3 筆
//
// Idempotent:
//   A/B/C 防重複靠 (emp,date) 是否已有 deleted_at IS NULL 且 status IN
//     ('approved','archived') 的 leave_request 覆蓋
//   D schedule/attendance row 已不存在則 skip+warn
//
// 設計:
//   - 預設 dry-run、--apply 才實際寫入
//   - 逐筆 try/catch、單筆失敗不中斷其他
//   - 扣餘額一律走 lib/leave/balance.js(樂觀鎖 + 寫 leave_balance_logs)
//   - schedule 刪除 + schedule_change_logs(change_type='manager_adjust',
//     既有 CHECK 值不新增)
//   - 所有寫入走 supabaseAdmin

import { createClient } from '@supabase/supabase-js';

// ─── CLI ──────────────────────────────────────────────────
const args = process.argv.slice(2);
const flags = { apply: false, actor: null };
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--apply') flags.apply = true;
  else if (args[i].startsWith('--actor=')) flags.actor = args[i].slice('--actor='.length);
  else if (args[i] === '--actor' && args[i + 1]) flags.actor = args[++i];
}
if (!flags.actor) {
  console.error('Usage: node --env-file=.env.local scripts/backfill_attendance_202605_warehouse.mjs [--apply] --actor=<employee_id>');
  process.exit(1);
}

const MODE = flags.apply ? 'APPLY' : 'DRY-RUN';
const ACTOR = flags.actor;
const AUDIT_DATE = '2026-05-29'; // audit note prefix 日期(批次執行日)

// ─── env ──────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌ 缺 SUPABASE_URL 或 SUPABASE_SERVICE_KEY(或 SUPABASE_SERVICE_ROLE_KEY)');
  console.error('   請用 --env-file=.env.local 跑');
  process.exit(1);
}
const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// ─── Manifest ─────────────────────────────────────────────
const PLAN_A_SICK = [
  { emp: 'EMP_01220301', date: '2026-05-27' },
  { emp: 'EMP_01240301', date: '2026-05-27' },
  { emp: 'EMP_01220301', date: '2026-05-22' },
  { emp: 'EMP_01220301', date: '2026-05-19' },
  { emp: 'EMP_01240301', date: '2026-05-11' },
  { emp: 'EMP_01220301', date: '2026-05-11' },
];
const PLAN_B_ANNUAL = [
  { emp: 'EMP_01240301', date: '2026-05-05' },
];
const PLAN_C_COMP = [
  { emp: 'EMP_01251108', date: '2026-05-15', hours: 2.5 },
];
const PLAN_D_DELETE = [
  { emp: 'EMP_02231001', date: '2026-05-05',
    schedule_id: 'SEMP0223100120260505_1', attendance_id: 'A_EMP_02231001_20260505_1' },
  { emp: 'EMP_02231001', date: '2026-05-13',
    schedule_id: 'SEMP0223100120260513_1', attendance_id: 'A_EMP_02231001_20260513_1' },
  { emp: 'EMP_02231001', date: '2026-05-14',
    schedule_id: 'SEMP0223100120260514_1', attendance_id: 'A_EMP_02231001_20260514_1' },
];

const summary = {
  a_created: 0, a_skipped: 0,
  b_created: 0, b_skipped: 0,
  c_created: 0, c_skipped: 0,
  d_sch_deleted: 0, d_sch_skipped: 0,
  d_att_deleted: 0, d_att_skipped: 0,
  annual_days_deducted: 0,
  comp_hours_deducted: 0,
};

const log = (...a) => console.log(...a);
const nowIso = () => new Date().toISOString();

// ─── helpers ──────────────────────────────────────────────
async function findExistingApprovedLeaveCovering(emp, date) {
  const dayStart = `${date}T00:00:00+08:00`;
  const dayEnd   = `${date}T23:59:59+08:00`;
  const { data, error } = await sb
    .from('leave_requests')
    .select('id, leave_type, status, start_at, end_at')
    .eq('employee_id', emp)
    .is('deleted_at', null)
    .in('status', ['approved', 'archived'])
    .lte('start_at', dayEnd)
    .gte('end_at',   dayStart);
  if (error) throw new Error(`查既有請假 (${emp},${date}): ${error.message}`);
  return data || [];
}

async function findAttendance(emp, date) {
  const { data, error } = await sb
    .from('attendance')
    .select('id, schedule_id, status, note, work_hours, early_leave_minutes')
    .eq('employee_id', emp).eq('work_date', date).maybeSingle();
  if (error) throw new Error(`查 attendance (${emp},${date}): ${error.message}`);
  return data;
}

async function findScheduleById(id) {
  const { data, error } = await sb
    .from('schedules')
    .select('id, employee_id, work_date, segment_no, start_time, end_time, scheduled_work_minutes, crosses_midnight, shift_type_id, period_id, status')
    .eq('id', id).maybeSingle();
  if (error) throw new Error(`查 schedule ${id}: ${error.message}`);
  return data;
}

async function findAnnualRecord(emp, date) {
  const { data, error } = await sb
    .from('annual_leave_records')
    .select('id, period_start, period_end, granted_days, used_days, status')
    .eq('employee_id', emp).eq('status', 'active')
    .lte('period_start', date).gte('period_end', date)
    .limit(1).maybeSingle();
  if (error) throw new Error(`查 annual_leave_records (${emp},${date}): ${error.message}`);
  return data;
}

async function findActiveCompBalances(emp) {
  const { data, error } = await sb
    .from('comp_time_balance')
    .select('id, earned_hours, used_hours, expires_at, earned_at, status')
    .eq('employee_id', emp).eq('status', 'active')
    .order('expires_at', { ascending: true })
    .order('earned_at',  { ascending: true });
  if (error) throw new Error(`查 comp_time_balance ${emp}: ${error.message}`);
  return data || [];
}

function genLeaveId(emp) {
  return `L${Date.now()}_${emp}`;
}

function combineDateTime(date, hhmm) {
  const hm = String(hhmm).slice(0, 5);
  return `${date}T${hm}:00+08:00`;
}

function endTimeMinusHours(date, endHHMM, hours) {
  const [eh, em] = String(endHHMM).slice(0, 5).split(':').map(Number);
  const endMin = eh * 60 + em;
  const startMin = endMin - Math.round(hours * 60);
  const sh = Math.floor(startMin / 60);
  const sm = startMin % 60;
  return combineDateTime(date, `${String(sh).padStart(2, '0')}:${String(sm).padStart(2, '0')}`);
}

function buildFullyApprovedLeaveRow({ emp, date, leaveType, hours, days, startAt, endAt, reason, auditNote }) {
  const now = nowIso();
  return {
    id: genLeaveId(emp),
    employee_id: emp,
    leave_type: leaveType,
    start_at: startAt, end_at: endAt,
    hours, finalized_hours: hours,
    // legacy 欄位
    start_date: date, end_date: date,
    days,
    // 終態:archived + 完整審核鏈
    status: 'archived',
    reason,
    applied_at: now,
    handled_at: now, handled_by: ACTOR,
    mgr_reviewed_by: ACTOR, mgr_reviewed_at: now, mgr_decision: 'approved',
    ceo_reviewed_by: ACTOR, ceo_reviewed_at: now, ceo_decision: 'approved',
    archived_by: ACTOR, archived_at: now,
    // 後補(必然遲交)
    late_application: true,
    late_reason: 'HR 後台批次補考勤(5月打卡異常表)',
    proof_status: 'not_required',
    admin_audit_note: auditNote,
  };
}

// ─── A / B / C 共用前置 ───────────────────────────────────
async function preflightLeave(emp, date) {
  const existing = await findExistingApprovedLeaveCovering(emp, date);
  if (existing.length) {
    return { skip: true, reason: `已有 approved/archived leave (${existing.map(e => `${e.leave_type}:${e.id}`).join(', ')})` };
  }
  const att = await findAttendance(emp, date);
  if (!att) return { skip: true, reason: 'attendance row 不存在' };
  if (!att.schedule_id) return { skip: true, reason: 'attendance.schedule_id 為空' };
  const sch = await findScheduleById(att.schedule_id);
  if (!sch) return { skip: true, reason: `schedule ${att.schedule_id} 不存在` };
  if (!sch.start_time || !sch.end_time || !sch.scheduled_work_minutes) {
    return { skip: true, reason: `schedule ${sch.id} 欄位不完整 (start=${sch.start_time}/end=${sch.end_time}/min=${sch.scheduled_work_minutes})` };
  }
  return { skip: false, att, sch };
}

// ─── A: 補病假 ────────────────────────────────────────────
async function planExecuteSick(item) {
  const { emp, date } = item;
  const tag = `[A sick] ${emp} ${date}`;
  const pre = await preflightLeave(emp, date);
  if (pre.skip) {
    log(`${tag} SKIP ${pre.reason}`);
    summary.a_skipped++; return;
  }
  const { att, sch } = pre;
  const startAt = combineDateTime(date, sch.start_time);
  const endAt   = combineDateTime(date, sch.end_time);
  const hours = Number(sch.scheduled_work_minutes) / 60;
  const days  = hours / 8;
  const auditNote = `[HR批次補考勤 ${AUDIT_DATE}] 來源:5月打卡異常表備註 原absent→補核准病假 actor:${ACTOR}`;
  const row = buildFullyApprovedLeaveRow({
    emp, date, leaveType: 'sick', hours, days, startAt, endAt,
    reason: '病假', auditNote,
  });

  const auditLine = `[HR補考勤 ${AUDIT_DATE}] absent→leave(sick) 依5月打卡異常表`;
  const newNote = att.note ? `${auditLine}\n${att.note}` : auditLine;

  log(`${tag} [WILL INSERT leave] id=${row.id} type=sick hours=${hours} days=${days.toFixed(3)} ${startAt}~${endAt} status=archived`);
  log(`           admin_audit_note="${auditNote}"`);
  log(`${tag} [WILL UPDATE attendance] ${att.id} status ${att.status}→leave; note prepend "${auditLine}"`);

  if (MODE === 'APPLY') {
    const { error: insErr } = await sb.from('leave_requests').insert([row]);
    if (insErr) { log(`${tag} ✗ INSERT leave failed: ${insErr.message}`); return; }
    const { error: updErr } = await sb.from('attendance')
      .update({ status: 'leave', note: newNote }).eq('id', att.id);
    if (updErr) { log(`${tag} ✗ UPDATE attendance failed: ${updErr.message}`); return; }
    log(`${tag} ✓ done`);
  }
  summary.a_created++;
}

// ─── B: 補特休 ────────────────────────────────────────────
async function planExecuteAnnual(item) {
  const { emp, date } = item;
  const tag = `[B annual] ${emp} ${date}`;
  const pre = await preflightLeave(emp, date);
  if (pre.skip) {
    log(`${tag} SKIP ${pre.reason}`);
    summary.b_skipped++; return;
  }
  const { att, sch } = pre;
  const annual = await findAnnualRecord(emp, date);
  if (!annual) {
    log(`${tag} SKIP 找不到 active annual_leave_record 涵蓋 ${date}`);
    summary.b_skipped++; return;
  }
  const startAt = combineDateTime(date, sch.start_time);
  const endAt   = combineDateTime(date, sch.end_time);
  const hours = Number(sch.scheduled_work_minutes) / 60;
  const days  = hours / 8;
  const auditNote = `[HR批次補考勤 ${AUDIT_DATE}] 來源:紙本補登 原absent→補核准特休 actor:${ACTOR}`;
  const row = buildFullyApprovedLeaveRow({
    emp, date, leaveType: 'annual', hours, days, startAt, endAt,
    reason: '特休（紙本補登）', auditNote,
  });

  const usedBefore = Number(annual.used_days);
  const grantedBefore = Number(annual.granted_days);
  const remainingBefore = grantedBefore - usedBefore;
  const usedAfter = usedBefore + days;
  const remainingAfter = grantedBefore - usedAfter;

  const auditLine = `[HR補考勤 ${AUDIT_DATE}] absent→leave(annual) 依5月打卡異常表`;
  const newNote = att.note ? `${auditLine}\n${att.note}` : auditLine;

  log(`${tag} [WILL INSERT leave] id=${row.id} type=annual hours=${hours} days=${days.toFixed(3)} ${startAt}~${endAt} status=archived`);
  log(`           admin_audit_note="${auditNote}"`);
  log(`${tag} [WILL DEDUCT annual] record ${annual.id} (${annual.period_start}~${annual.period_end}) granted=${grantedBefore}`);
  log(`           used ${usedBefore.toFixed(2)}→${usedAfter.toFixed(2)} / remaining ${remainingBefore.toFixed(2)}→${remainingAfter.toFixed(2)}`);
  log(`${tag} [WILL UPDATE attendance] ${att.id} status ${att.status}→leave; note prepend "${auditLine}"`);

  if (MODE === 'APPLY') {
    const { error: insErr } = await sb.from('leave_requests').insert([row]);
    if (insErr) { log(`${tag} ✗ INSERT leave failed: ${insErr.message}`); return; }
    const { deductAnnualLeave } = await import('../lib/leave/balance.js');
    const { makeLeaveRepo } = await import('../api/leaves/_repo.js');
    const repo = makeLeaveRepo();
    const r = await deductAnnualLeave(repo, {
      employee_id: emp, days,
      leave_request_id: row.id,
      changed_by: ACTOR,
      leave_date: date,
      reason: `HR 後台批次補考勤 ${AUDIT_DATE}:補核准特休 ${date}`,
    });
    if (!r.ok) { log(`${tag} ✗ deductAnnualLeave failed: ${r.reason}`); return; }
    const { error: updErr } = await sb.from('attendance')
      .update({ status: 'leave', note: newNote }).eq('id', att.id);
    if (updErr) { log(`${tag} ✗ UPDATE attendance failed: ${updErr.message}`); return; }
    log(`${tag} ✓ done`);
  }
  summary.b_created++;
  summary.annual_days_deducted += days;
}

// ─── C: 補休部分日 ────────────────────────────────────────
async function planExecuteComp(item) {
  const { emp, date, hours } = item;
  const tag = `[C comp] ${emp} ${date} ${hours}h`;
  const pre = await preflightLeave(emp, date);
  if (pre.skip) {
    log(`${tag} SKIP ${pre.reason}`);
    summary.c_skipped++; return;
  }
  const { att, sch } = pre;
  const balances = await findActiveCompBalances(emp);
  const totalRemaining = balances.reduce((s, b) => s + (Number(b.earned_hours) - Number(b.used_hours)), 0);
  if (totalRemaining + 1e-6 < hours) {
    log(`${tag} SKIP 補休餘額不足 (total_remaining=${totalRemaining.toFixed(2)} < ${hours})`);
    summary.c_skipped++; return;
  }
  const startAt = endTimeMinusHours(date, sch.end_time, hours);
  const endAt   = combineDateTime(date, sch.end_time);
  const days = hours / 8;
  const auditNote = `[HR批次補考勤 ${AUDIT_DATE}] 原early_leave 214分,依Ray指示補休${hours}h actor:${ACTOR}`;
  const row = buildFullyApprovedLeaveRow({
    emp, date, leaveType: 'comp', hours, days, startAt, endAt,
    reason: `補休 ${hours}h`, auditNote,
  });

  const auditLine = `[HR補考勤 ${AUDIT_DATE}] early_leave→normal 補休${hours}h著落`;
  const newNote = att.note ? `${auditLine}\n${att.note}` : auditLine;

  log(`${tag} [WILL INSERT leave] id=${row.id} type=comp hours=${hours} days=${days.toFixed(3)} ${startAt}~${endAt} status=archived`);
  log(`           admin_audit_note="${auditNote}"`);
  log(`${tag} [WILL DEDUCT comp] FIFO from active balances:`);
  let remaining = hours;
  for (const b of balances) {
    if (remaining <= 1e-6) break;
    const avail = Number(b.earned_hours) - Number(b.used_hours);
    if (avail <= 1e-6) continue;
    const take = Math.min(avail, remaining);
    log(`           comp_id=${b.id} earned=${b.earned_hours} used ${b.used_hours}→${(Number(b.used_hours) + take).toFixed(2)} take ${take}h expires=${b.expires_at}`);
    remaining -= take;
  }
  log(`           total remaining ${totalRemaining.toFixed(2)}→${(totalRemaining - hours).toFixed(2)}`);
  log(`${tag} [WILL UPDATE attendance] ${att.id} status ${att.status}→normal; early_leave_minutes ${att.early_leave_minutes}→0; work_hours ${att.work_hours} 維持; note prepend "${auditLine}"`);

  if (MODE === 'APPLY') {
    const { error: insErr } = await sb.from('leave_requests').insert([row]);
    if (insErr) { log(`${tag} ✗ INSERT leave failed: ${insErr.message}`); return; }
    const { deductCompTime } = await import('../lib/leave/balance.js');
    const { makeLeaveRepo } = await import('../api/leaves/_repo.js');
    const repo = makeLeaveRepo();
    const r = await deductCompTime(repo, {
      employee_id: emp, hours,
      leave_request_id: row.id,
      changed_by: ACTOR,
      reason: `HR 後台批次補考勤 ${AUDIT_DATE}:補休 ${date} ${hours}h`,
    });
    if (!r.ok) { log(`${tag} ✗ deductCompTime failed: ${r.reason}`); return; }
    const { error: updErr } = await sb.from('attendance').update({
      status: 'normal', early_leave_minutes: 0, note: newNote,
    }).eq('id', att.id);
    if (updErr) { log(`${tag} ✗ UPDATE attendance failed: ${updErr.message}`); return; }
    log(`${tag} ✓ done`);
  }
  summary.c_created++;
  summary.comp_hours_deducted += hours;
}

// ─── D: 刪 attendance(子)→ 寫 log(dedup)→ 刪 schedule(父) ────
// 上一輪原順序「先 schedule 後 attendance」撞 FK attendance_schedule_id_fkey,
// schedule 刪失敗但 attendance 已刪、且 change_log 已寫(因為寫 log 在刪
// schedule 之前)。本輪改順序 + 對 change_log 做 reason dedup。
const D_REASON = 'HR後台補考勤：兼職誤排，刪除排班豁免曠職（5月打卡異常表）';

async function planExecuteDelete(item) {
  const { emp, date, schedule_id, attendance_id } = item;
  const tag = `[D delete] ${emp} ${date}`;

  // 先一次性把兩邊狀態都讀出來
  let sch;
  try { sch = await findScheduleById(schedule_id); }
  catch (e) { log(`${tag} ✗ 查 schedule failed: ${e.message}`); return; }

  const { data: att, error: attErr } = await sb.from('attendance')
    .select('id, status').eq('id', attendance_id).maybeSingle();
  if (attErr) {
    log(`${tag} ✗ 查 attendance failed: ${attErr.message}`); return;
  }

  // (a) 兩邊都不在 → 已全部完成
  if (!sch && !att) {
    log(`${tag} SKIP schedule + attendance 都已不存在(已完成)`);
    summary.d_sch_skipped++;
    summary.d_att_skipped++;
    return;
  }

  // (b) 先刪 attendance(子)
  if (att) {
    log(`${tag} [WILL DELETE attendance] ${attendance_id} (status=${att.status})`);
    if (MODE === 'APPLY') {
      const { error: delErr } = await sb.from('attendance').delete().eq('id', attendance_id);
      if (delErr) {
        log(`${tag} ✗ DELETE attendance failed: ${delErr.message}`);
        // 不 return:仍嘗試後續(若 attendance 刪不掉,schedule 也會 FK 擋)
      } else {
        log(`${tag} ✓ attendance deleted`);
        summary.d_att_deleted++;
      }
    } else {
      summary.d_att_deleted++;
    }
  } else {
    log(`${tag} SKIP attendance ${attendance_id} 已不存在(上輪已刪)`);
    summary.d_att_skipped++;
  }

  // schedule 已不在 → 無父可刪、收尾
  if (!sch) {
    log(`${tag} SKIP schedule ${schedule_id} 已不存在`);
    summary.d_sch_skipped++;
    return;
  }

  // (c) 寫 schedule_change_logs,先 dedup(避免上輪失敗那筆已寫過)
  const { data: existingLogs, error: logQErr } = await sb
    .from('schedule_change_logs')
    .select('id, changed_at, reason')
    .eq('schedule_id', schedule_id)
    .eq('change_type', 'manager_adjust');
  if (logQErr) {
    log(`${tag} ✗ 查 schedule_change_logs failed: ${logQErr.message}`); return;
  }
  const dupLog = (existingLogs || []).find(l => l.reason === D_REASON);
  if (dupLog) {
    log(`${tag} SKIP 寫 log:已存在(id=${dupLog.id}, changed_at=${dupLog.changed_at}) 同 reason 的 manager_adjust 紀錄,不重複寫`);
  } else {
    log(`${tag} [WILL INSERT schedule_change_logs] change_type=manager_adjust, changed_by=${ACTOR}, reason='${D_REASON}'`);
    if (MODE === 'APPLY') {
      const { error: logErr } = await sb.from('schedule_change_logs').insert([{
        schedule_id, employee_id: emp,
        change_type: 'manager_adjust',
        changed_by: ACTOR,
        before_data: sch, after_data: null,
        reason: D_REASON,
      }]);
      if (logErr) {
        log(`${tag} ✗ INSERT schedule_change_logs failed: ${logErr.message}`); return;
      }
    }
  }

  // (d) 刪 schedule(父),此時 attendance 已不引用、FK 通過
  log(`${tag} [WILL DELETE schedule] ${schedule_id} (work_date=${sch.work_date}, segment=${sch.segment_no}, shift_type=${sch.shift_type_id}, status=${sch.status})`);
  if (MODE === 'APPLY') {
    const { error: delErr } = await sb.from('schedules').delete().eq('id', schedule_id);
    if (delErr) {
      log(`${tag} ✗ DELETE schedule failed: ${delErr.message}`);
    } else {
      log(`${tag} ✓ schedule deleted`);
      summary.d_sch_deleted++;
    }
  } else {
    summary.d_sch_deleted++;
  }
}

// ─── main ─────────────────────────────────────────────────
async function runItem(fn, item) {
  try { await fn(item); }
  catch (e) { console.error(`✗ exception:`, e.message); }
}

async function main() {
  log(`\n=== [${MODE}] HR 批次補考勤 — 5 月倉儲後勤部 actor=${ACTOR} ===`);
  log(`audit prefix date: ${AUDIT_DATE}\n`);

  log(`--- A 補病假 (${PLAN_A_SICK.length} 筆) ---`);
  for (const it of PLAN_A_SICK) await runItem(planExecuteSick, it);

  log(`\n--- B 補特休 (${PLAN_B_ANNUAL.length} 筆) ---`);
  for (const it of PLAN_B_ANNUAL) await runItem(planExecuteAnnual, it);

  log(`\n--- C 補休部分日 (${PLAN_C_COMP.length} 筆) ---`);
  for (const it of PLAN_C_COMP) await runItem(planExecuteComp, it);

  log(`\n--- D 刪 schedule + attendance (${PLAN_D_DELETE.length} 筆) ---`);
  for (const it of PLAN_D_DELETE) await runItem(planExecuteDelete, it);

  const verb = MODE === 'APPLY' ? 'created' : 'will create';
  const dverb = MODE === 'APPLY' ? 'deleted' : 'will delete';
  log(`\n=== Summary (${MODE}) ===`);
  log(`A 病假: ${verb}=${summary.a_created}, skipped=${summary.a_skipped}`);
  log(`B 特休: ${verb}=${summary.b_created}, skipped=${summary.b_skipped}, 特休扣 ${summary.annual_days_deducted.toFixed(2)} 天`);
  log(`C 補休: ${verb}=${summary.c_created}, skipped=${summary.c_skipped}, 補休扣 ${summary.comp_hours_deducted.toFixed(2)} 小時`);
  log(`D 刪 schedule: ${dverb}=${summary.d_sch_deleted}, skipped=${summary.d_sch_skipped}`);
  log(`D 刪 attendance: ${dverb}=${summary.d_att_deleted}, skipped=${summary.d_att_skipped}`);
  if (MODE === 'DRY-RUN') {
    log(`\n(沒有寫入任何資料。確認後加 --apply 才會實際執行)`);
  }
}

main().then(() => process.exit(0)).catch(e => {
  console.error('fatal:', e);
  process.exit(1);
});
