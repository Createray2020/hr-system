// lib/leave/annual-rollover.js — cron:特休週年滾動(純函式 + repo 注入式)
//
// 對應設計文件：docs/attendance-system-design-v1.md §4.3.3
// 對應實作計畫：docs/attendance-system-implementation-plan-v1.md §7.3
//
// cron schedule:每天 03:00(透過 api/cron-annual-leave-rollover.js)
//
// 流程(per employee 在週年日):
//   1. 結算上週期 annual_leave_records:status='paid_out',settlement_amount 暫填 0
//      (TODO Batch 9:由 lib/salary/settlement.js 算實際金額)
//   2. 寫 leave_balance_logs(change_type='settle',hours_delta=-remaining_days*8)
//   3. 建立新週期 annual_leave_records(legal_days from calculateLegalDays)
//   4. 寫 leave_balance_logs(change_type='grant',hours_delta=+legal_days*8)

import { calculateLegalDays, calculatePeriodBoundary } from './annual.js';

const HOURS_PER_DAY = 8;

/**
 * Repo 介面契約:
 *   findEmployeesWithAnniversaryToday(today): Array<{ id, annual_leave_seniority_start }>
 *     找今天是 annual_leave_seniority_start 月日週年日的活躍員工
 *   findActiveAnnualRecord(employee_id): row | null
 *   updateAnnualRecord(id, patch): updated row
 *   insertAnnualRecord(row): inserted row
 *   insertBalanceLog(row)
 */

export async function runAnnualRollover(repo, today) {
  requireRepo(repo, [
    'findEmployeesWithAnniversaryToday',
    'findActiveAnnualRecord',
    'updateAnnualRecord',
    'insertAnnualRecord',
    'insertBalanceLog',
  ]);
  if (!today) throw new Error('today required');

  const employees = await repo.findEmployeesWithAnniversaryToday(today);
  let rollover_count = 0;
  let payout_total   = 0;

  for (const emp of (employees || [])) {
    const senStart = emp.annual_leave_seniority_start;
    if (!senStart) continue;

    // 1. 結算上週期(若有)
    const old = await repo.findActiveAnnualRecord(emp.id);
    if (old) {
      const remainingDays = Math.max(0, Number(old.granted_days) - Number(old.used_days));
      // settlement_amount=0 為 placeholder:rollover 當下不算金額,
      // 由 Batch 9 的 lib/salary/calculator.js 月底跑時透過 lib/salary/settlement.js
      // 找「status='paid_out' 且 settlement_amount IN (0, NULL)」的 records,
      // 算 remaining_days × daily_wage 並 update 寫回。已接通。
      const settlementAmount = 0;
      await repo.updateAnnualRecord(old.id, {
        status: 'paid_out',
        settlement_amount: settlementAmount,
        settled_at: today + 'T00:00:00+08:00',
        settled_by: emp.id, // SYSTEM 沒 employees row,用本人 id 佔位
      });
      payout_total += settlementAmount;

      if (remainingDays > 0) {
        await repo.insertBalanceLog({
          employee_id: emp.id,
          balance_type: 'annual',
          annual_record_id: old.id,
          comp_record_id: null,
          leave_request_id: null,
          change_type: 'settle',
          hours_delta: -remainingDays * HOURS_PER_DAY,
          changed_by: emp.id,
          reason: `annual rollover ${today}: settle remaining ${remainingDays} days (TODO Batch 9 amount)`,
        });
      }
    }

    // 2. 建立新週期
    const { period_start, period_end, seniority_years } = calculatePeriodBoundary(senStart, today);
    const legalDays = calculateLegalDays(seniority_years);

    const newRow = {
      employee_id: emp.id,
      period_start, period_end,
      seniority_years,
      legal_days:   legalDays,
      granted_days: legalDays, // 預設 = legal,HR 之後可手動 +
      used_days:    0,
      status: 'active',
    };
    const created = await repo.insertAnnualRecord(newRow);

    if (legalDays > 0 && created?.id) {
      await repo.insertBalanceLog({
        employee_id: emp.id,
        balance_type: 'annual',
        annual_record_id: created.id,
        comp_record_id: null,
        leave_request_id: null,
        change_type: 'grant',
        hours_delta: +legalDays * HOURS_PER_DAY,
        changed_by: emp.id,
        reason: `annual rollover ${today}: grant ${legalDays} days for seniority ${seniority_years}y`,
      });
    }

    rollover_count += 1;
  }

  return { rollover_count, payout_total, today };
}

function requireRepo(repo, methods) {
  if (!repo) throw new Error('repo required');
  for (const m of methods) {
    if (typeof repo[m] !== 'function') throw new Error(`repo.${m} is required`);
  }
}
