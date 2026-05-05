#!/usr/bin/env node
// scripts/recompute_attendance.mjs — Backfill 修補既有 attendance row 的 status / late / early
//
// 起因:lib/attendance/clock.js::isoToMinutesOfDay 修補前用 regex 抓 ISO HH:MM、
// 不解時區、live punch UTC ISO 全被誤算成 early_leave 480 分。本 script 用
// 修補後 lib/attendance/recompute.js 重算、把錯的 row 修回正確 status。
//
// 用法:
//   # dry-run(只印 diff、不寫 DB):
//   node --env-file=.env.local scripts/recompute_attendance.mjs --dry-run --from 2026-05-04 --to 2026-05-05
//
//   # 真實寫入(沒 --dry-run):
//   node --env-file=.env.local scripts/recompute_attendance.mjs --from 2026-05-04 --to 2026-05-05
//
// 需要環境變數:
//   SUPABASE_URL
//   SUPABASE_SERVICE_KEY  (或 SUPABASE_SERVICE_ROLE_KEY)
//
// 設計:
//   - 單筆 UPDATE(避免 batch transaction risk)
//   - status='leave'/'holiday'/'absent' 不動(recomputeAttendanceStatus 內 PRESERVED 已擋)
//   - dry-run 印 diff table、apply 才真寫
//   - 結尾印 summary:scanned / changed / skipped(無 schedule / 不需改)

import { createClient } from '@supabase/supabase-js';
import { recomputeAttendanceStatus } from '../lib/attendance/recompute.js';

// ─── CLI flags ────────────────────────────────────────────
const args = process.argv.slice(2);
const flags = { dryRun: false, from: null, to: null };
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--dry-run') flags.dryRun = true;
  else if (args[i] === '--from') flags.from = args[++i];
  else if (args[i] === '--to')   flags.to   = args[++i];
}
if (!flags.from || !flags.to) {
  console.error('Usage: node --env-file=.env.local scripts/recompute_attendance.mjs [--dry-run] --from YYYY-MM-DD --to YYYY-MM-DD');
  process.exit(1);
}
if (!/^\d{4}-\d{2}-\d{2}$/.test(flags.from) || !/^\d{4}-\d{2}-\d{2}$/.test(flags.to)) {
  console.error('❌ --from / --to 必須是 YYYY-MM-DD 格式');
  process.exit(1);
}

// ─── env ───────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌ 缺少環境變數 SUPABASE_URL 或 SUPABASE_SERVICE_KEY (或 SUPABASE_SERVICE_ROLE_KEY)');
  console.error('   請在 .env.local 或環境中設定後重跑(--env-file=.env.local)');
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

// ─── main ──────────────────────────────────────────────────
async function main() {
  console.log(`\n📋 ${flags.dryRun ? '[DRY-RUN] ' : ''}撈 attendance ${flags.from} ~ ${flags.to}…`);

  // 撈 attendance + 對應 employees(取 name 印 diff)
  const { data: attendances, error: aErr } = await sb
    .from('attendance')
    .select('id, employee_id, work_date, segment_no, schedule_id, clock_in, clock_out, late_minutes, early_leave_minutes, status, note')
    .gte('work_date', flags.from)
    .lte('work_date', flags.to)
    .order('work_date').order('employee_id').order('segment_no');
  if (aErr) { console.error('❌ 撈 attendance 失敗:', aErr.message); process.exit(1); }
  if (!attendances || !attendances.length) {
    console.log('(無資料)'); return;
  }

  // 一次撈所有需要的 schedules(by id 跟 by employee_id+work_date+segment_no)
  const schIds = [...new Set(attendances.map(a => a.schedule_id).filter(Boolean))];
  const schByIdMap = new Map();
  if (schIds.length) {
    const { data: schs, error: sErr } = await sb
      .from('schedules')
      .select('id, employee_id, work_date, segment_no, start_time, end_time, crosses_midnight, scheduled_work_minutes')
      .in('id', schIds);
    if (sErr) { console.error('❌ 撈 schedules by id 失敗:', sErr.message); process.exit(1); }
    for (const s of (schs || [])) schByIdMap.set(s.id, s);
  }
  // schedule_id 缺的 row,fallback 用 (employee_id, work_date, segment_no)
  const fallbackKeys = attendances.filter(a => !a.schedule_id).map(a => ({
    employee_id: a.employee_id, work_date: a.work_date, segment_no: a.segment_no,
  }));
  const schByTripleMap = new Map();
  if (fallbackKeys.length) {
    const empIds = [...new Set(fallbackKeys.map(k => k.employee_id))];
    const dates = [...new Set(fallbackKeys.map(k => k.work_date))];
    const { data: schs, error: sErr } = await sb
      .from('schedules')
      .select('id, employee_id, work_date, segment_no, start_time, end_time, crosses_midnight, scheduled_work_minutes')
      .in('employee_id', empIds).in('work_date', dates);
    if (sErr) { console.error('⚠ 撈 fallback schedules 失敗(忽略):', sErr.message); }
    for (const s of (schs || [])) {
      schByTripleMap.set(`${s.employee_id}|${s.work_date}|${s.segment_no}`, s);
    }
  }

  // 員工名稱 map
  const empIds2 = [...new Set(attendances.map(a => a.employee_id))];
  const { data: emps } = await sb.from('employees').select('id, name').in('id', empIds2);
  const empNameMap = new Map((emps || []).map(e => [e.id, e.name]));

  // 比對 + 印 diff
  const diffs = [];
  for (const a of attendances) {
    const sch = a.schedule_id
      ? (schByIdMap.get(a.schedule_id) || null)
      : (schByTripleMap.get(`${a.employee_id}|${a.work_date}|${a.segment_no}`) || null);

    const computed = recomputeAttendanceStatus(a, sch);

    const changed = computed.status !== a.status
                 || (computed.late_minutes || 0) !== (a.late_minutes || 0)
                 || (computed.early_leave_minutes || 0) !== (a.early_leave_minutes || 0);
    if (!changed) continue;

    diffs.push({
      id: a.id, name: empNameMap.get(a.employee_id) || a.employee_id,
      date: a.work_date, segment: a.segment_no,
      old_status: a.status, new_status: computed.status,
      old_late:   a.late_minutes || 0,        new_late:  computed.late_minutes,
      old_early:  a.early_leave_minutes || 0, new_early: computed.early_leave_minutes,
      has_schedule: !!sch,
    });
  }

  // 印 table
  console.log(`\n=== 找到 ${attendances.length} 筆 attendance、${diffs.length} 筆需要修補 ===\n`);
  if (diffs.length) {
    console.log(
      'date'.padEnd(11) + 'name'.padEnd(12) + 'seg '.padEnd(5)
      + 'status'.padEnd(28) + 'late'.padEnd(14) + 'early'.padEnd(14) + 'sched'
    );
    console.log('-'.repeat(96));
    for (const d of diffs) {
      console.log(
        String(d.date).padEnd(11)
        + String(d.name).padEnd(12)
        + String(d.segment).padEnd(5)
        + `${d.old_status} → ${d.new_status}`.padEnd(28)
        + `${d.old_late} → ${d.new_late}`.padEnd(14)
        + `${d.old_early} → ${d.new_early}`.padEnd(14)
        + (d.has_schedule ? '✓' : '⚠ no sched')
      );
    }
  }

  if (flags.dryRun) {
    console.log(`\n[DRY-RUN] 不寫 DB。要真的 apply 移除 --dry-run flag 重跑。\n`);
    return;
  }

  // 真實寫入(單筆 UPDATE)
  console.log(`\n🚀 寫入 ${diffs.length} 筆…`);
  let okCount = 0, failCount = 0;
  for (const d of diffs) {
    const { error } = await sb.from('attendance').update({
      status:              d.new_status,
      late_minutes:        d.new_late,
      early_leave_minutes: d.new_early,
    }).eq('id', d.id);
    if (error) { console.error(`  ❌ ${d.id}: ${error.message}`); failCount++; }
    else okCount++;
  }
  console.log(`\n✅ 完成:scanned=${attendances.length}、changed=${diffs.length}、ok=${okCount}、fail=${failCount}\n`);
}

main().catch(e => {
  console.error('❌ 未捕獲錯誤:', e);
  process.exit(1);
});
