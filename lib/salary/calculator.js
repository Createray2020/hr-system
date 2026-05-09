// lib/salary/calculator.js — 月度薪資計算主流程(純函式 + repo 注入式)
//
// 對應設計文件:docs/attendance-system-design-v1.md §10
// 對應實作計畫:docs/attendance-system-implementation-plan-v1.md §11.2
//
// ══════════════════════════════════════════════════════════════
// 模式選擇:【完整重算】(規範 §11 的設計選擇)
// ══════════════════════════════════════════════════════════════
// 理由:HR 在同一個月可能多次觸發「重算」(發現排班錯了、加班補申請、HR 補建懲處 等)。
//   完整重算保證每次跑出來的結果只跟「當下 source records 的狀態」有關,
//   不依賴 salary_records 的歷史值,避免增量累加遇到「中途清空 salary_records 後再跑會出問題」的 bug。
//   HR 的手動覆寫(_manual 欄位)在 UPSERT 時被保留(只重置 _auto 欄位)。
//
// 此模式對所有 _auto 欄位一致:
//   overtime_pay_auto / attendance_penalty_total / attendance_bonus_actual /
//   comp_expiry_payout / settlement_amount / holiday_work_pay
// ══════════════════════════════════════════════════════════════
//
// 主流程順序(11 步):
//   1. 撈員工資料 → base_salary / attendance_bonus
//   2. 算 daily_wage_snapshot = base_salary / 該月工作日數(凍結,不更新既有值)
//   3. 算 absence_days(從 attendance status='absent' 的 distinct 天數)
//   4. **完整重算 reset**:把該 record 已 mark 的 child records markers 清掉
//      - overtime_requests.applied_to_salary_record_id = NULL
//      - attendance_penalty_records.salary_record_id = NULL + status='pending'
//        (annual_leave_records / comp_time_balance 用 settlement_amount=0 為「待結算」標記,
//         不用清 salary_record_id 因為它們本來就沒這個 FK)
//   5. attendance-bonus.js → base / deduction_rate / actual
//   6. overtime-aggregator.js → overtime_pay_auto + 重新 mark applied
//   7. penalty-applier.js → attendance_penalty_total + 重新 mark applied
//   8. 算 holiday_work_pay = sum(attendance.is_holiday_work=true 的 work_hours × hourly × multiplier)
//   9. settlement.js → annual_settlement(寫入 settlement_amount) + comp_expiry_payout
//   10. UPSERT salary_records:_auto 欄位用新算出的值,_manual 欄位用既有值保留
//   11. 回傳完整 row + breakdown
//
// 重要:GENERATED column gross_salary / net_salary 由 DB 自動算,本檔不寫入。
//      但 lib 提供 computeGrossSalary / computeNetSalary 純函式作為「公式快照」,
//      vitest 雙向綁定 batch_c L106 / L121 的 GENERATED 公式。

import { applyAttendanceBonus } from './attendance-bonus.js';
import { aggregateOvertimePay } from './overtime-aggregator.js';
import { applyAttendancePenalties } from './penalty-applier.js';
import { calculateSettlementAmount } from './settlement.js';
import { calculateEmployeeVoluntary }    from './pension-deduction.js';
import {
  calculateFromSalaryRecord as calculateSupplementaryHealth,
  TW_2026_SUPPLEMENTARY_HEALTH_RATE,
} from './supplementary-health.js';
import { calculateEmployerCost }         from './employer-cost.js';
import { countWorkdaysInMonth } from '../attendance/rate.js';

/**
 * Repo 介面契約(calculator 主流程):
 *   findEmployeeForSalary(id): { id, base_salary, attendance_bonus, employment_type, ... }
 *   findHolidaysByMonth(year, month): Array<{ date, holiday_type, pay_multiplier }>
 *   findAbsentDaysByEmployeeMonth(...): number     (lib/attendance/bonus 也用)
 *   findHolidayWorkAttendance({ employee_id, year, month }):
 *     Array<{ work_hours, holiday_id, work_date }>
 *   findHolidayMultiplier(holiday_id): number
 *   findEmployeeHourlyRate(employee_id): number
 *   findSalaryRecord(id): row | null
 *   resetOvertimeMarkers(salary_record_id): void  (UPDATE overtime_requests SET applied_to_salary_record_id=NULL)
 *   resetPenaltyRecordsMarkers(salary_record_id): void  (UPDATE penalty_records SET salary_record_id=NULL, status='pending')
 *   upsertSalaryRecord(row): row
 *   getSystemOvertimeSettings(): { monthly_work_hours_base, ... }
 *   (其他 repo method 由各 sub-lib 各自需要)
 */

export async function calculateMonthlySalary(repo, { employee_id, year, month, callerId = null }) {
  requireRepo(repo, [
    'findEmployeeForSalary', 'findHolidaysByMonth',
    'findHolidayWorkAttendance', 'findEmployeeHourlyRate',
    'findSalaryRecord', 'upsertSalaryRecord',
    'resetOvertimeMarkers', 'resetPenaltyRecordsMarkers',
    'getSystemOvertimeSettings',
    'findEmployeeInsuranceSettings',
    'findActivePayrollPeriod',
    'findYtdAccumulatedBonusBefore',
  ]);
  if (!employee_id) throw new Error('employee_id required');
  if (!Number.isInteger(year))  throw new Error('year required');
  if (!Number.isInteger(month) || month < 1 || month > 12) throw new Error('month invalid');

  // Step 1: 撈員工資料
  const emp = await repo.findEmployeeForSalary(employee_id);
  if (!emp) throw new Error(`employee not found: ${employee_id}`);
  const base_salary = Number(emp.base_salary) || 0;

  // Step 1.1: 撈 insurance_settings(投保 / 月提繳工資 / 自願率 / 眷屬數)
  const ins = await repo.findEmployeeInsuranceSettings(employee_id);
  const hasInsurance = !!(ins && ins.has_insurance !== false);

  // Step 2: 算 daily_wage_snapshot
  const holidays = await repo.findHolidaysByMonth(year, month);
  const nationalHolidayDates = new Set(
    (holidays || []).filter(h => h.holiday_type === 'national').map(h => String(h.date).slice(0, 10)),
  );
  const workdays = countWorkdaysInMonth(year, month, nationalHolidayDates);
  const daily_wage_snapshot = workdays > 0 ? round2(base_salary / workdays) : 0;

  // Step 3: 算 absence_days
  const absentDaysFn = repo.findAbsentDaysByEmployeeMonth || repo.findAbsentDaysCount;
  if (typeof absentDaysFn !== 'function') {
    throw new Error('repo.findAbsentDaysByEmployeeMonth required');
  }
  const absence_days = Number(await absentDaysFn.call(repo, { employee_id, year, month })) || 0;
  const deduct_absence = round2(daily_wage_snapshot * absence_days);

  // Step 4: 完整重算 reset(若 record 已存在)
  const recordId = `S_${employee_id}_${year}_${String(month).padStart(2, '0')}`;
  const existing = await repo.findSalaryRecord(recordId);
  if (existing) {
    await repo.resetOvertimeMarkers(recordId);
    await repo.resetPenaltyRecordsMarkers(recordId);
  }

  // Step 5: attendance-bonus
  const ab = await applyAttendanceBonus(repo, emp, { employee_id, year, month });

  // Step 6: overtime-aggregator
  const ot = await aggregateOvertimePay(repo, {
    employee_id, year, month, salary_record_id: recordId,
  });

  // Step 7: penalty-applier
  const pen = await applyAttendancePenalties(repo, {
    employee_id, year, month, salary_record_id: recordId,
  });

  // Step 8: holiday_work_pay
  const holidayMultMap = new Map();
  for (const h of (holidays || [])) {
    holidayMultMap.set(String(h.date).slice(0, 10), Number(h.pay_multiplier) || 2.0);
  }
  const settings = await repo.getSystemOvertimeSettings() || {};
  const hourly = Number(await repo.findEmployeeHourlyRate(employee_id)) || 0;
  const holidayWorkRows = await repo.findHolidayWorkAttendance({ employee_id, year, month });
  let holiday_work_pay = 0;
  const holidayBreakdown = [];
  for (const row of (holidayWorkRows || [])) {
    const date = String(row.work_date).slice(0, 10);
    const mult = holidayMultMap.get(date) || 2.0;
    const hrs = Number(row.work_hours) || 0;
    const amt = round2(hrs * hourly * mult);
    holiday_work_pay += amt;
    holidayBreakdown.push({ work_date: date, hours: hrs, multiplier: mult, amount: amt });
  }
  holiday_work_pay = round2(holiday_work_pay);

  // Step 9: settlement
  const sett = await calculateSettlementAmount(repo, {
    employee_id, year, month, daily_wage: daily_wage_snapshot,
  });

  // Step 10: 員工自願勞退提繳(_auto、寫入 deduct_pension_voluntary)
  // pension_voluntary_rate 是百分比(0-6)、lib 用小數
  const pensionWage    = hasInsurance ? Number(ins?.pension_wage)            || 0 : 0;
  const voluntaryRate  = hasInsurance ? Number(ins?.pension_voluntary_rate)  || 0 : 0;
  const deduct_pension_voluntary = calculateEmployeeVoluntary({
    pensionWage,
    voluntaryRate: voluntaryRate / 100,
  });

  // Step 11: 二代健保補充保費(_auto、寫入 deduct_supplementary_health)
  // 從 existing 拿 4 個 _manual 獎金、撈 ytd 累計、用 health 投保金額算
  const monthBonus_yearend     = existing?.bonus_yearend     != null ? Number(existing.bonus_yearend)     : 0;
  const monthBonus_festival    = existing?.bonus_festival    != null ? Number(existing.bonus_festival)    : 0;
  const monthBonus_performance = existing?.bonus_performance != null ? Number(existing.bonus_performance) : 0;
  const monthBonus_other       = existing?.bonus_other       != null ? Number(existing.bonus_other)       : 0;
  const monthlyBonusSum =
    monthBonus_yearend + monthBonus_festival + monthBonus_performance + monthBonus_other;

  const ytdAccumulatedBonusBefore = await repo.findYtdAccumulatedBonusBefore({
    employee_id, year, monthLte: month,
  });

  const insuredSalaryHealth = hasInsurance ? Number(ins?.health_ins_bracket) || 0 : 0;
  const insuredSalaryLabor  = hasInsurance ? Number(ins?.labor_ins_bracket)  || 0 : 0;

  const deduct_supplementary_health = (hasInsurance && monthlyBonusSum > 0)
    ? calculateSupplementaryHealth({
        bonus_yearend:     monthBonus_yearend,
        bonus_festival:    monthBonus_festival,
        bonus_performance: monthBonus_performance,
        bonus_other:       monthBonus_other,
        ytdAccumulatedBonusBefore,
        insuredSalary: insuredSalaryHealth,
        rate: TW_2026_SUPPLEMENTARY_HEALTH_RATE,
      })
    : 0;

  // Step 12: 雇主成本 6 項(_auto、寫入 employer_cost_*)
  const empCost = hasInsurance
    ? calculateEmployerCost({
        insuredSalaryLabor,
        insuredSalaryHealth,
        pensionWage,
        // direct premium 從 insurance_settings 取(prod 預先算好的 company_premium 最準)
        laborCompanyPremium:  Number(ins?.labor_ins_company)  || 0,
        healthCompanyPremium: Number(ins?.health_ins_company) || 0,
        // 法定 6%、離職員工的話 ins.has_insurance 已 false 走整個 0 分支
        pensionMandatoryRate: 0.06,
        // 行業 / 公司設定率 — 暫無 settings 表、預設 0、後續 commit 從 settings 讀
        occupationalRate: 0,
        employmentRate:   0,
        welfareRate:      0,
      })
    : { employer_cost_labor:0, employer_cost_health:0, employer_cost_pension:0,
        employer_cost_occupational:0, employer_cost_employment:0, employer_cost_welfare:0, total:0 };

  // Step 13: 課稅薪資 snapshot(gross_pre_tax 減去免稅項)
  // gross_pre_tax = base + 加項(用本步算出的、含 _manual 既有值的近似)
  // 注意: gross_salary 是 GENERATED、calculator 不能讀 row.gross_salary、要自己算近似
  const allowanceManual      = existing?.allowance       != null ? Number(existing.allowance)       : 0;
  const extraAllowanceManual = existing?.extra_allowance != null ? Number(existing.extra_allowance) : 0;
  const overtimePayManual    = existing?.overtime_pay_manual != null ? Number(existing.overtime_pay_manual) : 0;
  const grossPreTax =
    base_salary
    + Number(ab.actual || 0)
    + allowanceManual
    + extraAllowanceManual
    + Number(ot.total) + overtimePayManual
    + Number(sett.comp_expiry_payout)
    + Number(holiday_work_pay)
    + Number(sett.annual_settlement)
    + monthlyBonusSum;
  const taxable_income_snapshot = Math.max(0, round2(grossPreTax - deduct_pension_voluntary));

  // Step 14: 撈 active payroll_periods(若沒對應期間、period_id = null)
  const activePeriod = await repo.findActivePayrollPeriod(year, month);
  const payroll_period_id = activePeriod?.id || null;

  // Step 15: UPSERT salary_records(_auto 重算、_manual 保留)
  const row = {
    id: recordId,
    employee_id,
    year,
    month,
    base_salary,
    daily_wage_snapshot,
    absence_days,
    deduct_absence,

    // _auto 欄位:每次完整重算
    attendance_bonus_base: ab.base,
    attendance_bonus_deduction_rate: ab.deduction_rate,
    attendance_bonus_actual: ab.actual,

    overtime_pay_auto: ot.total,
    attendance_penalty_total: pen.total,
    holiday_work_pay,
    comp_expiry_payout: sett.comp_expiry_payout,
    settlement_amount: sett.annual_settlement,

    // _auto 新欄位(階段 2.5.2 接 lib)
    deduct_pension_voluntary,
    deduct_supplementary_health,

    // snapshot _auto
    taxable_income_snapshot,
    insured_salary_labor_snapshot:  insuredSalaryLabor,
    insured_salary_health_snapshot: insuredSalaryHealth,
    pension_wage_snapshot:          pensionWage,

    // 雇主成本 _auto
    employer_cost_labor:        empCost.employer_cost_labor,
    employer_cost_health:       empCost.employer_cost_health,
    employer_cost_pension:      empCost.employer_cost_pension,
    employer_cost_occupational: empCost.employer_cost_occupational,
    employer_cost_employment:   empCost.employer_cost_employment,
    employer_cost_welfare:      empCost.employer_cost_welfare,

    // _manual 欄位:保留既有(沒既有值用 0/null)
    overtime_pay_manual:  existing?.overtime_pay_manual  != null ? Number(existing.overtime_pay_manual) : 0,
    overtime_pay_note:    existing?.overtime_pay_note ?? null,
    settlement_note:      existing?.settlement_note   ?? null,
    allowance:            existing?.allowance         != null ? Number(existing.allowance) : 0,
    extra_allowance:      existing?.extra_allowance   != null ? Number(existing.extra_allowance) : 0,
    deduct_labor_ins:     existing?.deduct_labor_ins  != null ? Number(existing.deduct_labor_ins) : 0,
    deduct_health_ins:    existing?.deduct_health_ins != null ? Number(existing.deduct_health_ins) : 0,
    deduct_tax:           existing?.deduct_tax        != null ? Number(existing.deduct_tax) : 0,
    note:                 existing?.note ?? '',

    // _manual 新欄位(階段 1.1 加的、保留既有)
    bonus_yearend:           monthBonus_yearend,
    bonus_festival:          monthBonus_festival,
    bonus_performance:       monthBonus_performance,
    bonus_other:             monthBonus_other,
    bonus_other_note:        existing?.bonus_other_note ?? null,
    deduct_welfare_fund:     existing?.deduct_welfare_fund     != null ? Number(existing.deduct_welfare_fund) : 0,
    deduct_union_fee:        existing?.deduct_union_fee        != null ? Number(existing.deduct_union_fee) : 0,
    deduct_court_garnishment:existing?.deduct_court_garnishment!= null ? Number(existing.deduct_court_garnishment) : 0,
    deduct_loan_repayment:   existing?.deduct_loan_repayment   != null ? Number(existing.deduct_loan_repayment) : 0,
    deduct_other:            existing?.deduct_other            != null ? Number(existing.deduct_other) : 0,
    deduct_other_note:       existing?.deduct_other_note ?? null,

    // 工作流關聯 + audit
    payroll_period_id,
    calculated_at: new Date().toISOString(),
    calculated_by: callerId,

    // status:既有 row 保留;沒就 draft
    status: existing?.status || 'draft',
  };

  const upserted = await repo.upsertSalaryRecord(row);

  return {
    record: upserted,
    breakdown: {
      attendance_bonus: ab.breakdown,
      overtime: ot.breakdown,
      penalty: pen.breakdown,
      holiday_work: holidayBreakdown,
      settlement: sett.breakdown,
      pension_voluntary: { pensionWage, voluntaryRate, amount: deduct_pension_voluntary },
      supplementary_health: { monthlyBonus: monthlyBonusSum, ytdBefore: ytdAccumulatedBonusBefore, amount: deduct_supplementary_health },
      employer_cost: empCost,
      daily_wage_snapshot,
      workdays,
    },
  };
}

// ─── GENERATED column 公式快照(雙向綁定 batch_c L106/L121)─────────────
//
// ⚠ 這兩個函式必須跟 supabase_attendance_v2_batch_c.sql L106 / L121 的 GENERATED column 公式
//    完全一致。任一邊改了沒同步,tests/salary-calculator.test.js 的雙向綁定 case 會 fail。
//    本函式只接受「row 的快照」(已轉為 number 的 plain object),不再呼叫 repo。

/**
 * gross_salary 公式(批 c L106-116):
 *   base_salary + attendance_bonus_actual + allowance + extra_allowance
 *   + (overtime_pay_auto + overtime_pay_manual)
 *   + comp_expiry_payout + holiday_work_pay + settlement_amount
 */
export function computeGrossSalary(row) {
  return round2(
      n(row.base_salary)
    + n(row.attendance_bonus_actual)
    + n(row.allowance)
    + n(row.extra_allowance)
    + (n(row.overtime_pay_auto) + n(row.overtime_pay_manual))
    + n(row.comp_expiry_payout)
    + n(row.holiday_work_pay)
    + n(row.settlement_amount)
    + n(row.bonus_yearend)
    + n(row.bonus_festival)
    + n(row.bonus_performance)
    + n(row.bonus_other)
  );
}

/**
 * net_salary 公式(批 c L117-132):
 *   gross_salary
 *   - deduct_absence - deduct_labor_ins - deduct_health_ins - deduct_tax
 *   - attendance_penalty_total
 *
 * 注意:batch_c L117-132 的 net_salary 公式裡不是直接用 gross_salary 變數,
 *      而是把 gross 部份再展開一遍。為避免 overflow / NULL 處理差異,本快照採用「gross - deductions」
 *      的等價形式(數值結果一致)。
 */
export function computeNetSalary(row) {
  return round2(
      computeGrossSalary(row)
    - n(row.deduct_absence)
    - n(row.deduct_labor_ins)
    - n(row.deduct_health_ins)
    - n(row.deduct_tax)
    - n(row.attendance_penalty_total)
    - n(row.deduct_pension_voluntary)
    - n(row.deduct_supplementary_health)
    - n(row.deduct_welfare_fund)
    - n(row.deduct_union_fee)
    - n(row.deduct_court_garnishment)
    - n(row.deduct_loan_repayment)
    - n(row.deduct_other)
  );
}

// ─── helpers ─────────────────────────────────────────────────

function requireRepo(repo, methods) {
  if (!repo) throw new Error('repo required');
  for (const m of methods) {
    if (typeof repo[m] !== 'function') throw new Error(`repo.${m} is required`);
  }
}

function round2(n) { return Math.round(Number(n) * 100) / 100; }
function n(v) { return v == null ? 0 : Number(v); }
