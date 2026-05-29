#!/usr/bin/env node
// scripts/rerun_payroll_202605.mjs
// 一次性 2026-05 全月薪資重算(讓 calculator 把 grade/manager allowance 補上)
//
// 用法:
//   # dry-run(預設,不寫入):
//   node --env-file=.env.local scripts/rerun_payroll_202605.mjs --actor=<employee_id>
//
//   # 實際重算:
//   node --env-file=.env.local scripts/rerun_payroll_202605.mjs --apply --actor=<employee_id>
//
// 設計:
//   - 重用 api/salary/index.js handleNewBatch(L284-360)的同款邏輯:
//       listEmployeesForPayroll → for-each calculateMonthlySalary → reconcilePeriodStats
//   - 結果等同 POST /api/salary { action:'batch_v2', year:2026, month:5 }
//   - dry-run 只讀 + 印預覽(現況 + 預期補上的 grade/manager + 預期新 gross)
//   - --apply 才呼 calculateMonthlySalary loop + reconcile,跑完再讀印 before→after
//
// ⚠️ 倉儲 3 人(EMP_01240301/01220301/01251108)重算會同時:
//      absence_days 歸 0(attendance 已清)、全勤因 sick affects_attendance_bonus 仍會扣、
//      病假折半不會做。請假精算是另案手動疊、不在本 script。

import { makeSalaryRepo } from '../api/salary/_repo.js';
import { calculateMonthlySalary } from '../lib/salary/calculator.js';
import { reconcilePeriodStats } from '../lib/salary/period-stats.js';
import { excludeSystemAccounts } from '../lib/salary/system-accounts.js';

// ─── CLI ────────────────────────────────────────────
const args = process.argv.slice(2);
const flags = { apply: false, actor: null };
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--apply') flags.apply = true;
  else if (args[i].startsWith('--actor=')) flags.actor = args[i].slice('--actor='.length);
  else if (args[i] === '--actor' && args[i + 1]) flags.actor = args[++i];
}
if (!flags.actor) {
  console.error('Usage: node --env-file=.env.local scripts/rerun_payroll_202605.mjs [--apply] --actor=<employee_id>');
  process.exit(1);
}
const MODE = flags.apply ? 'APPLY' : 'DRY-RUN';
const ACTOR = flags.actor;
const YEAR = 2026, MONTH = 5;
const PERIOD_NOTE = new Set(['EMP_01240301', 'EMP_01220301', 'EMP_01251108']); // 倉儲後勤,另案疊算

// ─── env ────────────────────────────────────────────
if (!process.env.SUPABASE_URL ||
    !(process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY)) {
  console.error('❌ 缺 SUPABASE_URL / SUPABASE_SERVICE_KEY(或 SUPABASE_SERVICE_ROLE_KEY)');
  process.exit(1);
}

const repo = makeSalaryRepo();

// ─── helpers ────────────────────────────────────────
const fmt = (n) => n == null ? '—' : (typeof n === 'number' ? n.toFixed(2) : String(n));
const pad = (s, w) => String(s).padEnd(w);
const recordId = (empId) => `S_${empId}_${YEAR}_${String(MONTH).padStart(2, '0')}`;

async function loadSnapshot(empId) {
  return await repo.findSalaryRecord(recordId(empId));
}
async function loadEmp(empId) {
  return await repo.findEmployeeForSalary(empId);
}

// ─── main ───────────────────────────────────────────
async function main() {
  console.log(`\n=== [${MODE}] 2026-05 全月薪資重算 actor=${ACTOR} ===\n`);

  const rawTargets = await repo.listEmployeesForPayroll(YEAR, MONTH);
  const targets = excludeSystemAccounts(rawTargets);
  console.log(`目標員工:${targets.length} 人(原 ${rawTargets.length},去 ${rawTargets.length - targets.length} 系統帳號)\n`);

  // ─── DRY-RUN:預覽 ─────────────────────────────────
  if (MODE === 'DRY-RUN') {
    console.log(
      pad('emp_id', 14), pad('name', 12), pad('type', 10),
      pad('cur_gross', 11), pad('emp.grade', 10), pad('emp.mgr', 8),
      pad('Δ', 8), pad('expected', 11), 'note',
    );
    console.log('─'.repeat(120));
    let affected = 0, totalGrade = 0, totalMgr = 0;
    let totalCurGross = 0, totalExpGross = 0;
    for (const t of targets) {
      const [sr, emp] = await Promise.all([loadSnapshot(t.id), loadEmp(t.id)]);
      const grade   = Number(emp?.grade_allowance)   || 0;
      const mgr     = Number(emp?.manager_allowance) || 0;
      const curGross = Number(sr?.gross_salary) || 0;
      const delta = grade + mgr;
      const expectedNewGross = curGross + delta;
      if (delta > 0) { affected++; totalGrade += grade; totalMgr += mgr; }
      totalCurGross += curGross;
      totalExpGross += expectedNewGross;
      const noteParts = [];
      if (PERIOD_NOTE.has(t.id)) noteParts.push('⚠ 倉儲:absence/全勤/病假折半 另案疊算');
      if (!sr) noteParts.push('(無既有 salary_records)');
      console.log(
        pad(t.id, 14), pad(emp?.name || '?', 12), pad(emp?.employment_type || '?', 10),
        pad(fmt(curGross), 11), pad(grade, 10), pad(mgr, 8),
        pad(delta, 8), pad(fmt(expectedNewGross), 11), noteParts.join(' '),
      );
    }
    console.log('─'.repeat(120));
    console.log(`\n--- 統計 ---`);
    console.log(`受影響員工(grade+manager > 0):${affected} 人 / 共 ${targets.length} 人`);
    console.log(`Σ(grade_allowance) = ${totalGrade}`);
    console.log(`Σ(manager_allowance) = ${totalMgr}`);
    console.log(`Σ(grade+manager) = ${totalGrade + totalMgr}`);
    console.log(`現況 Σ gross = ${fmt(totalCurGross)}`);
    console.log(`預期 Σ gross = ${fmt(totalExpGross)} (Δ ${fmt(totalExpGross - totalCurGross)})`);
    console.log(`\n注意:預期值只算 grade+manager 的直接 delta。`);
    console.log(`     倉儲 3 人實際還會因 absence_days 歸 0、全勤扣 sick 等而變,差額另案疊算。`);
    console.log(`\n(沒寫入。確認後加 --apply 才會 calculateMonthlySalary loop + reconcilePeriodStats)`);
    return;
  }

  // ─── APPLY ────────────────────────────────────────
  // 1. before snapshot
  console.log('--- 1. 抓 before snapshot ---');
  const beforeMap = {};
  for (const t of targets) {
    const sr = await loadSnapshot(t.id);
    beforeMap[t.id] = sr ? {
      gross_salary:      Number(sr.gross_salary)      || 0,
      net_salary:        Number(sr.net_salary)        || 0,
      grade_allowance:   Number(sr.grade_allowance)   || 0,
      manager_allowance: Number(sr.manager_allowance) || 0,
      deduct_absence:    Number(sr.deduct_absence)    || 0,
      attendance_bonus_actual: Number(sr.attendance_bonus_actual) || 0,
    } : null;
  }

  // 2. 重算 loop(對齊 handleNewBatch L312-324)
  console.log(`\n--- 2. 重算 loop(${targets.length} 人) ---`);
  let success = 0, failed = 0;
  const failures = [];
  for (const emp of targets) {
    try {
      await calculateMonthlySalary(repo, {
        employee_id: emp.id, year: YEAR, month: MONTH, callerId: ACTOR,
      });
      success++;
      process.stdout.write('.');
    } catch (e) {
      failed++;
      failures.push({ id: emp.id, error: e.message });
      process.stdout.write('x');
    }
  }
  console.log(`\n  success=${success}, failed=${failed}`);
  if (failures.length) {
    console.log('  失敗:');
    for (const f of failures) console.log(`    ${f.id}: ${f.error}`);
  }

  // 3. reconcile payroll_period(對齊 handleNewBatch L329-345)
  console.log('\n--- 3. reconcile payroll_period ---');
  let periodWarning = null;
  try {
    const period = await repo.findActivePayrollPeriod(YEAR, MONTH);
    if (period) {
      const stats = await reconcilePeriodStats(repo, period.id);
      const periodPatch = {
        employee_count:      stats.employee_count,
        gross_total:         stats.gross_total,
        net_total:           stats.net_total,
        employer_cost_total: stats.employer_cost_total,
        calculated_at:       new Date().toISOString(),
      };
      // status 自動推進規則:對齊 handleNewBatch L342-344
      // 已 pending_review、推進後仍是 pending_review(無實質變化)
      if (failed === 0 && ['draft', 'calculating', 'pending_review'].includes(period.status)) {
        periodPatch.status = 'pending_review';
      }
      await repo.updatePayrollPeriod(period.id, periodPatch);
      console.log(`  ${period.id} status=${period.status} reconciled:`);
      console.log(`    employee_count=${stats.employee_count}`);
      console.log(`    gross_total=${stats.gross_total}`);
      console.log(`    net_total=${stats.net_total}`);
      console.log(`    employer_cost_total=${stats.employer_cost_total}`);
    } else {
      periodWarning = `payroll_periods 沒有 ${YEAR}-${MONTH} 的 period、cache 未更新`;
    }
  } catch (e) {
    periodWarning = `period cache reconcile 失敗: ${e.message}`;
  }
  if (periodWarning) console.log(`  ⚠ ${periodWarning}`);

  // 4. before → after
  console.log('\n--- 4. before → after ---');
  console.log(
    pad('emp_id', 14), pad('name', 12),
    pad('gross_b', 10), pad('gross_a', 10), pad('Δgross', 10),
    pad('net_b', 10), pad('net_a', 10), pad('Δnet', 10), 'note',
  );
  console.log('─'.repeat(120));
  let gB = 0, gA = 0, nB = 0, nA = 0;
  for (const t of targets) {
    const after = await loadSnapshot(t.id);
    const emp = await loadEmp(t.id);
    const b = beforeMap[t.id] || { gross_salary: 0, net_salary: 0 };
    if (!after) {
      console.log(pad(t.id, 14), pad(emp?.name || '?', 12), '✗ 無 record');
      continue;
    }
    const aG = Number(after.gross_salary) || 0;
    const aN = Number(after.net_salary)   || 0;
    gB += b.gross_salary; gA += aG; nB += b.net_salary; nA += aN;
    const note = PERIOD_NOTE.has(t.id) ? '⚠ 倉儲' : '';
    console.log(
      pad(t.id, 14), pad(emp?.name || '?', 12),
      pad(fmt(b.gross_salary), 10), pad(fmt(aG), 10), pad(fmt(aG - b.gross_salary), 10),
      pad(fmt(b.net_salary), 10), pad(fmt(aN), 10), pad(fmt(aN - b.net_salary), 10), note,
    );
  }
  console.log('─'.repeat(120));
  console.log(`Σ gross: ${fmt(gB)} → ${fmt(gA)}  (Δ ${fmt(gA - gB)})`);
  console.log(`Σ net:   ${fmt(nB)} → ${fmt(nA)}  (Δ ${fmt(nA - nB)})`);
}

main().then(() => process.exit(0)).catch(e => {
  console.error('fatal:', e);
  process.exit(1);
});
