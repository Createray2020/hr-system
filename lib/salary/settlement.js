// lib/salary/settlement.js — 結算項目計算(純函式 + repo 注入式)
//
// 對應設計文件:docs/attendance-system-design-v1.md §10
// 對應實作計畫:docs/attendance-system-implementation-plan-v1.md §11.3
//
// 處理兩類結算(設計差異:annual 重算,comp 讀已算的)
//
//   a. 特休結算(annual_leave_records):rollover / 手動 settle 時只標 status='paid_out',
//      不算金額(留 settlement_amount=0)。本函式月底找「settlement_amount IN (0, NULL)
//      且 settled_at 月份 = 該結算月」的 records,算 remaining_days × daily_wage(1 倍)
//      並 UPDATE 寫回 annual_leave_records.settlement_amount。
//
//   b. 補休失效付款(comp_time_balance):lib/comp-time/expiry-sweep.js 在 cron(每天 01:00)
//      失效當下已算 expiry_payout_amount(用當下時薪 × remaining × rate)並寫入 comp_time_balance。
//      本函式只「讀」該月所有 status='expired_paid' 且 expiry_payout_amount IS NOT NULL
//      的 records,加總到 salary_records.comp_expiry_payout。**不重算 comp_time_balance**
//      (single source of truth — expiry-sweep 在失效當下決定的金額為準)。
//      manual_review 模式 expiry_payout_amount=NULL 的 records 不算入(等 HR 手動填)。
//
// 完整重算模式下:annual 部分 update 寫回對齊;comp 部分只讀,不會破壞 expiry-sweep 寫的值。

/**
 * Repo 介面契約:
 *   findAnnualRecordsForSettlement({ employee_id, year, month }): Array<row>
 *     回 status='paid_out' 且 settlement_amount IN (0, NULL) 且 settled_at 在該年月的記錄
 *   findCompBalancesForSettlement({ employee_id, year, month }): Array<row>
 *     回 status='expired_paid' 且 expiry_processed_at 在該年月的記錄(本函式自行 skip null amount)
 *   updateAnnualRecord(id, patch): updated row
 *   getDailyWageSnapshot({ employee_id, year, month }): number(若 daily_wage 沒由呼叫端提供)
 *
 *   不再需要:updateCompBalance / findEmployeeHourlyRate / getSystemOvertimeSettings
 *           (comp 改為只讀)
 */

export async function calculateSettlementAmount(repo, { employee_id, year, month, daily_wage }) {
  requireRepo(repo, [
    'findAnnualRecordsForSettlement',
    'findCompBalancesForSettlement',
    'updateAnnualRecord',
  ]);
  if (!employee_id) throw new Error('employee_id required');
  if (!Number.isInteger(year))  throw new Error('year required');
  if (!Number.isInteger(month) || month < 1 || month > 12) throw new Error('month invalid');

  // a. annual settlement — 算金額並 UPDATE 寫回
  const annualRecords = await repo.findAnnualRecordsForSettlement({ employee_id, year, month });
  let annual_settlement = 0;
  const annualBreakdown = [];
  if ((annualRecords || []).length > 0) {
    const dw = daily_wage != null
      ? Number(daily_wage)
      : await repo.getDailyWageSnapshot({ employee_id, year, month });
    for (const r of annualRecords) {
      const remainingDays = Math.max(0, Number(r.granted_days) - Number(r.used_days));
      const amount = round2(remainingDays * Number(dw) * 1.0);
      await repo.updateAnnualRecord(r.id, { settlement_amount: amount });
      annual_settlement += amount;
      annualBreakdown.push({
        annual_record_id: r.id,
        period_start: r.period_start, period_end: r.period_end,
        remaining_days: remainingDays,
        daily_wage: Number(dw),
        amount,
      });
    }
    annual_settlement = round2(annual_settlement);
  }

  // b. comp expiry payout — 只讀,不重算(expiry-sweep 已算)
  const compRecords = await repo.findCompBalancesForSettlement({ employee_id, year, month });
  let comp_expiry_payout = 0;
  const compBreakdown = [];
  for (const c of (compRecords || [])) {
    if (c.expiry_payout_amount == null) continue; // manual_review 待 HR 填,本月不算
    const amount = Number(c.expiry_payout_amount) || 0;
    comp_expiry_payout += amount;
    compBreakdown.push({
      comp_balance_id: c.id,
      earned_at: c.earned_at, expires_at: c.expires_at,
      amount,
    });
  }
  comp_expiry_payout = round2(comp_expiry_payout);

  return {
    annual_settlement,
    comp_expiry_payout,
    breakdown: { annual: annualBreakdown, comp: compBreakdown },
  };
}

function requireRepo(repo, methods) {
  if (!repo) throw new Error('repo required');
  for (const m of methods) {
    if (typeof repo[m] !== 'function') throw new Error(`repo.${m} is required`);
  }
}

function round2(n) { return Math.round(Number(n) * 100) / 100; }
