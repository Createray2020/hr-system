// tests/salary-calculator.test.js
//
// 含三類測試:
//   1. GENERATED column 雙向綁定(batch_c L106 / L121 vs lib/salary/calculator.js
//      的 computeGrossSalary / computeNetSalary)— 三種輸入組合
//   2. 完整重算模式驗證(reset child markers、_manual 保留、_auto 重算)
//   3. 主流程整合(各 sub-lib 都被呼叫到)

import { describe, it, expect, vi } from 'vitest';
import {
  calculateMonthlySalary, computeGrossSalary, computeNetSalary,
} from '../lib/salary/calculator.js';

// ─── batch_c L106-132 GENERATED column 公式 reference(直接照抄)──────────
// ⚠ 任何一邊改了沒同步,以下兩個 case 會 fail。

function refGrossSalary(row) {
  // batch_c L106-116:
  //   base_salary
  //   + COALESCE(attendance_bonus_actual, 0) + COALESCE(allowance, 0) + COALESCE(extra_allowance, 0)
  //   + COALESCE(overtime_pay_auto + overtime_pay_manual, 0)
  //   + COALESCE(comp_expiry_payout, 0) + COALESCE(holiday_work_pay, 0) + COALESCE(settlement_amount, 0)
  return r2(
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

function refNetSalary(row) {
  // batch_c L117-132(展開全式,不用 gross_salary 變數,完全照抄 SQL):
  return r2(
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

function n(v) { return v == null ? 0 : Number(v); }
function r2(x) { return Math.round(Number(x) * 100) / 100; }

// 三種輸入組合
const ROW_PURE_BASE = {
  base_salary: 50000,
  attendance_bonus_actual: 2000, allowance: 0, extra_allowance: 0,
  overtime_pay_auto: 0, overtime_pay_manual: 0,
  comp_expiry_payout: 0, holiday_work_pay: 0, settlement_amount: 0,
  deduct_absence: 0, deduct_labor_ins: 1000, deduct_health_ins: 500, deduct_tax: 1500,
  attendance_penalty_total: 0,
};

const ROW_WITH_OVERTIME = {
  base_salary: 60000,
  attendance_bonus_actual: 2000, allowance: 1000, extra_allowance: 500,
  overtime_pay_auto: 5000, overtime_pay_manual: 1500,
  comp_expiry_payout: 0, holiday_work_pay: 3200, settlement_amount: 0,
  deduct_absence: 0, deduct_labor_ins: 1200, deduct_health_ins: 600, deduct_tax: 2000,
  attendance_penalty_total: 0,
};

const ROW_WITH_SETTLEMENT_AND_PENALTY = {
  base_salary: 55000,
  attendance_bonus_actual: 1400, allowance: 0, extra_allowance: 0,
  overtime_pay_auto: 0, overtime_pay_manual: 0,
  comp_expiry_payout: 2144, holiday_work_pay: 0, settlement_amount: 10000,
  deduct_absence: 4000, deduct_labor_ins: 1100, deduct_health_ins: 550, deduct_tax: 1700,
  attendance_penalty_total: 250,
};

describe('GENERATED column 雙向綁定 — gross_salary 公式對齊 batch_c L106', () => {
  it('純底薪情境', () => {
    expect(computeGrossSalary(ROW_PURE_BASE)).toBe(refGrossSalary(ROW_PURE_BASE));
    expect(computeGrossSalary(ROW_PURE_BASE)).toBe(50000 + 2000); // 52000
  });
  it('含加班 + holiday work pay', () => {
    expect(computeGrossSalary(ROW_WITH_OVERTIME)).toBe(refGrossSalary(ROW_WITH_OVERTIME));
    // 60000 + 2000 + 1000 + 500 + (5000+1500) + 0 + 3200 + 0 = 73200
    expect(computeGrossSalary(ROW_WITH_OVERTIME)).toBe(73200);
  });
  it('含補休結算 + 罰款 + 曠職扣日薪', () => {
    expect(computeGrossSalary(ROW_WITH_SETTLEMENT_AND_PENALTY))
      .toBe(refGrossSalary(ROW_WITH_SETTLEMENT_AND_PENALTY));
    // 55000 + 1400 + 0 + 0 + 0 + 2144 + 0 + 10000 = 68544
    expect(computeGrossSalary(ROW_WITH_SETTLEMENT_AND_PENALTY)).toBe(68544);
  });
});

describe('GENERATED column 雙向綁定 — net_salary 公式對齊 batch_c L121', () => {
  it('純底薪情境', () => {
    expect(computeNetSalary(ROW_PURE_BASE)).toBe(refNetSalary(ROW_PURE_BASE));
    expect(computeNetSalary(ROW_PURE_BASE)).toBe(52000 - 1000 - 500 - 1500); // 49000
  });
  it('含加班', () => {
    expect(computeNetSalary(ROW_WITH_OVERTIME)).toBe(refNetSalary(ROW_WITH_OVERTIME));
    // 73200 - 0 - 1200 - 600 - 2000 - 0 = 69400
    expect(computeNetSalary(ROW_WITH_OVERTIME)).toBe(69400);
  });
  it('含補休結算 + 罰款 + 曠職扣日薪', () => {
    expect(computeNetSalary(ROW_WITH_SETTLEMENT_AND_PENALTY))
      .toBe(refNetSalary(ROW_WITH_SETTLEMENT_AND_PENALTY));
    // 68544 - 4000 - 1100 - 550 - 1700 - 250 = 60944
    expect(computeNetSalary(ROW_WITH_SETTLEMENT_AND_PENALTY)).toBe(60944);
  });
});

describe('GENERATED column 雙向綁定 — null / undefined 行為(COALESCE)', () => {
  it('所有欄位為 null/undefined 應視為 0(對齊 SQL COALESCE)', () => {
    const empty = {};
    expect(computeGrossSalary(empty)).toBe(0);
    expect(refGrossSalary(empty)).toBe(0);
    expect(computeNetSalary(empty)).toBe(0);
    expect(refNetSalary(empty)).toBe(0);
  });
  it('部分欄位 null,其他正常', () => {
    const row = { base_salary: 50000, attendance_bonus_actual: null, allowance: 1000 };
    expect(computeGrossSalary(row)).toBe(refGrossSalary(row));
    expect(computeGrossSalary(row)).toBe(51000);
  });
});

// ─── 主流程整合 ──────────────────────────────────────────

function makeFullRepo(over = {}) {
  return {
    findEmployeeForSalary: vi.fn(async () => ({
      id: 'E001', base_salary: 50000, attendance_bonus: 2000, employment_type: 'full_time',
    })),
    findHolidaysByMonth:        vi.fn(async () => []),
    findHolidayWorkAttendance:  vi.fn(async () => []),
    findEmployeeHourlyRate:     vi.fn(async () => 200),
    findSalaryRecord:           vi.fn(async () => null),
    upsertSalaryRecord:         vi.fn(async (row) => ({ ...row })),
    resetOvertimeMarkers:       vi.fn(async () => undefined),
    resetPenaltyRecordsMarkers: vi.fn(async () => undefined),
    getSystemOvertimeSettings:  vi.fn(async () => ({
      monthly_work_hours_base: 240,
      weekday_overtime_first_2h_rate: 1.34,
    })),
    findAbsentDaysByEmployeeMonth: vi.fn(async () => 0),

    // attendance-bonus.js / lib/attendance/bonus.js 需要的
    // (findHolidaysByMonth 已在上面 mock，bonus.js C 項用同一個)
    findPenaltyRecordsByEmployeeMonth: vi.fn(async () => []),
    findApprovedAttendanceBonusLeaves: vi.fn(async () => []),

    // overtime-aggregator
    findApprovedOvertimePayRequests: vi.fn(async () => []),
    markOvertimeRequestApplied: vi.fn(async () => undefined),

    // penalty-applier
    findPendingPenaltyRecords: vi.fn(async () => []),
    markPenaltyRecordApplied: vi.fn(async () => undefined),

    // settlement
    findAnnualRecordsForSettlement: vi.fn(async () => []),
    findCompBalancesForSettlement:  vi.fn(async () => []),
    updateAnnualRecord: vi.fn(async () => undefined),
    updateCompBalance:  vi.fn(async () => undefined),

    // ─── 階段 2.5.2 新增 mock ────────────────────────────
    findEmployeeInsuranceSettings: vi.fn(async () => null),  // 預設無投保
    findActivePayrollPeriod:       vi.fn(async () => null),  // 預設無 active period
    findYtdAccumulatedBonusBefore: vi.fn(async () => 0),

    ...over,
  };
}

describe('calculateMonthlySalary — 主流程順序', () => {
  it('11 步順序 + 各 sub-lib 都被呼叫到', async () => {
    const repo = makeFullRepo();
    const result = await calculateMonthlySalary(repo, { employee_id:'E001', year:2026, month:4 });
    expect(result.record).toBeTruthy();
    expect(result.record.id).toBe('S_E001_2026_04');
    expect(result.record.year).toBe(2026);
    expect(result.record.month).toBe(4);
    expect(result.record.status).toBe('draft');

    // 各 sub-lib 觸發
    expect(repo.findEmployeeForSalary).toHaveBeenCalledWith('E001');
    expect(repo.findApprovedOvertimePayRequests).toHaveBeenCalled();
    expect(repo.findPendingPenaltyRecords).toHaveBeenCalled();
    expect(repo.findAnnualRecordsForSettlement).toHaveBeenCalled();
    expect(repo.findCompBalancesForSettlement).toHaveBeenCalled();
    expect(repo.upsertSalaryRecord).toHaveBeenCalledTimes(1);
  });

  it('既有 record → 觸發 reset child markers', async () => {
    const repo = makeFullRepo({
      findSalaryRecord: vi.fn(async () => ({
        id: 'S_E001_2026_04', overtime_pay_manual: 1000, allowance: 500, status: 'draft',
      })),
    });
    await calculateMonthlySalary(repo, { employee_id:'E001', year:2026, month:4 });
    expect(repo.resetOvertimeMarkers).toHaveBeenCalledWith('S_E001_2026_04');
    expect(repo.resetPenaltyRecordsMarkers).toHaveBeenCalledWith('S_E001_2026_04');
  });

  it('沒既有 record → 不觸發 reset(首次計算)', async () => {
    const repo = makeFullRepo();
    await calculateMonthlySalary(repo, { employee_id:'E001', year:2026, month:4 });
    expect(repo.resetOvertimeMarkers).not.toHaveBeenCalled();
    expect(repo.resetPenaltyRecordsMarkers).not.toHaveBeenCalled();
  });

  it('完整重算:_manual 欄位保留;_auto 欄位重算', async () => {
    const repo = makeFullRepo({
      findSalaryRecord: vi.fn(async () => ({
        id: 'S_E001_2026_04',
        overtime_pay_manual: 1500,        // _manual 保留
        overtime_pay_note: 'HR 補加班費',  // _manual
        overtime_pay_auto: 9999,          // _auto 應被覆蓋
        allowance: 800,                   // _manual 保留
        extra_allowance: 200,             // _manual 保留
        deduct_labor_ins: 1100,           // _manual 保留
        deduct_health_ins: 550,           // _manual 保留
        deduct_tax: 1700,                 // _manual 保留
        deduct_tax_manual_override: true, // 階段 2.6.2: 顯式標 _manual override
        attendance_penalty_total: 9999,   // _auto 應被覆蓋
        comp_expiry_payout: 9999,         // _auto 應被覆蓋
        settlement_amount: 9999,          // _auto 應被覆蓋
        status: 'draft',
        note: '原備註',
      })),
    });
    await calculateMonthlySalary(repo, { employee_id:'E001', year:2026, month:4 });
    const upserted = repo.upsertSalaryRecord.mock.calls[0][0];
    // _manual 保留
    expect(upserted.overtime_pay_manual).toBe(1500);
    expect(upserted.overtime_pay_note).toBe('HR 補加班費');
    expect(upserted.allowance).toBe(800);
    expect(upserted.extra_allowance).toBe(200);
    expect(upserted.deduct_labor_ins).toBe(1100);
    expect(upserted.deduct_health_ins).toBe(550);
    expect(upserted.deduct_tax).toBe(1700);
    expect(upserted.note).toBe('原備註');
    // _auto 重算為 0(因為 mock repo 沒回 records)
    expect(upserted.overtime_pay_auto).toBe(0);
    expect(upserted.attendance_penalty_total).toBe(0);
    expect(upserted.comp_expiry_payout).toBe(0);
    expect(upserted.settlement_amount).toBe(0);
  });

  it('沒既有 record → _manual 預設 0', async () => {
    const repo = makeFullRepo();
    await calculateMonthlySalary(repo, { employee_id:'E001', year:2026, month:4 });
    const upserted = repo.upsertSalaryRecord.mock.calls[0][0];
    expect(upserted.overtime_pay_manual).toBe(0);
    expect(upserted.allowance).toBe(0);
    expect(upserted.extra_allowance).toBe(0);
  });

  it('既有 status=confirmed → 重算後 status 仍 confirmed(不退回 draft)', async () => {
    const repo = makeFullRepo({
      findSalaryRecord: vi.fn(async () => ({ id:'S_E001_2026_04', status:'confirmed' })),
    });
    await calculateMonthlySalary(repo, { employee_id:'E001', year:2026, month:4 });
    expect(repo.upsertSalaryRecord.mock.calls[0][0].status).toBe('confirmed');
  });

  it('員工不存在 → throw', async () => {
    const repo = makeFullRepo({
      findEmployeeForSalary: vi.fn(async () => null),
    });
    await expect(calculateMonthlySalary(repo, { employee_id:'NOPE', year:2026, month:4 }))
      .rejects.toThrow(/not found/);
  });

  it('參數驗證', async () => {
    const repo = makeFullRepo();
    await expect(calculateMonthlySalary(repo, { year:2026, month:4 })).rejects.toThrow(/employee_id/);
    await expect(calculateMonthlySalary(repo, { employee_id:'E001', month:4 })).rejects.toThrow(/year/);
    await expect(calculateMonthlySalary(repo, { employee_id:'E001', year:2026, month:13 })).rejects.toThrow(/month/);
    await expect(calculateMonthlySalary({}, { employee_id:'E001', year:2026, month:4 })).rejects.toThrow();
  });
});

describe('calculateMonthlySalary — daily_wage_snapshot 計算', () => {
  it('2026-04 22 工作日 / base 44000 → daily 2000', async () => {
    const repo = makeFullRepo({
      findEmployeeForSalary: vi.fn(async () => ({ id:'E001', base_salary: 44000, attendance_bonus: 0 })),
    });
    await calculateMonthlySalary(repo, { employee_id:'E001', year:2026, month:4 });
    const upserted = repo.upsertSalaryRecord.mock.calls[0][0];
    expect(upserted.daily_wage_snapshot).toBe(2000);
  });

  it('扣 absence_days × daily_wage 寫入 deduct_absence', async () => {
    const repo = makeFullRepo({
      findEmployeeForSalary: vi.fn(async () => ({ id:'E001', base_salary: 44000, attendance_bonus: 0 })),
      findAbsentDaysByEmployeeMonth: vi.fn(async () => 2),
    });
    await calculateMonthlySalary(repo, { employee_id:'E001', year:2026, month:4 });
    const upserted = repo.upsertSalaryRecord.mock.calls[0][0];
    expect(upserted.absence_days).toBe(2);
    expect(upserted.deduct_absence).toBe(4000); // 2 × 2000
  });
});

describe('calculateMonthlySalary — 階段 2.5.2 新欄位寫入', () => {
  it('無投保員工 → 全部新 _auto 欄位 = 0', async () => {
    const repo = makeFullRepo();  // findEmployeeInsuranceSettings 預設 null
    await calculateMonthlySalary(repo, { employee_id:'E001', year:2026, month:4 });
    const r = repo.upsertSalaryRecord.mock.calls[0][0];
    expect(r.deduct_pension_voluntary).toBe(0);
    expect(r.deduct_supplementary_health).toBe(0);
    expect(r.employer_cost_labor).toBe(0);
    expect(r.employer_cost_health).toBe(0);
    expect(r.employer_cost_pension).toBe(0);
    expect(r.insured_salary_labor_snapshot).toBe(0);
    expect(r.insured_salary_health_snapshot).toBe(0);
    expect(r.pension_wage_snapshot).toBe(0);
  });

  it('有投保 + 自願 6% → deduct_pension_voluntary 跟 employer_cost_pension 算對', async () => {
    const repo = makeFullRepo({
      findEmployeeInsuranceSettings: vi.fn(async () => ({
        has_insurance: true,
        pension_wage: 45800,
        pension_voluntary_rate: 6,  // 百分比 = 6%
        labor_ins_bracket: 45800, labor_ins_company: 3490,
        health_ins_bracket: 45800, health_ins_company: 1410,
        health_ins_dependents: 0,
      })),
    });
    await calculateMonthlySalary(repo, { employee_id:'E001', year:2026, month:4 });
    const r = repo.upsertSalaryRecord.mock.calls[0][0];
    expect(r.deduct_pension_voluntary).toBe(2748);  // 45800 × 0.06
    expect(r.employer_cost_pension).toBe(2748);     // 雇主強制 6%
    expect(r.employer_cost_labor).toBe(3490);       // direct premium
    expect(r.employer_cost_health).toBe(1410);
    expect(r.pension_wage_snapshot).toBe(45800);
    expect(r.insured_salary_labor_snapshot).toBe(45800);
    expect(r.insured_salary_health_snapshot).toBe(45800);
  });

  it('跨補充保費門檻 → deduct_supplementary_health 算對', async () => {
    // 投保 50000、4 倍 = 200000
    // 既有當月獎金合計 100000、ytd 累計之前 150000、累計後 250000、超過 50000
    // 50000 × 0.0211 = 1055
    const repo = makeFullRepo({
      findSalaryRecord: vi.fn(async () => ({
        id: 'S_E001_2026_04',
        bonus_yearend: 50000,
        bonus_festival: 30000,
        bonus_performance: 20000,
        bonus_other: 0,
      })),
      findEmployeeInsuranceSettings: vi.fn(async () => ({
        has_insurance: true,
        pension_wage: 50000,
        labor_ins_bracket: 50000, labor_ins_company: 0,
        health_ins_bracket: 50000, health_ins_company: 0,
      })),
      findYtdAccumulatedBonusBefore: vi.fn(async () => 150000),
    });
    await calculateMonthlySalary(repo, { employee_id:'E001', year:2026, month:4 });
    const r = repo.upsertSalaryRecord.mock.calls[0][0];
    expect(r.deduct_supplementary_health).toBe(1055);
  });

  it('有投保但無獎金 → deduct_supplementary_health = 0(不查 lib)', async () => {
    const repo = makeFullRepo({
      findEmployeeInsuranceSettings: vi.fn(async () => ({
        has_insurance: true,
        pension_wage: 50000,
        labor_ins_bracket: 50000, health_ins_bracket: 50000,
      })),
    });
    await calculateMonthlySalary(repo, { employee_id:'E001', year:2026, month:4 });
    const r = repo.upsertSalaryRecord.mock.calls[0][0];
    expect(r.deduct_supplementary_health).toBe(0);
  });

  it('payroll_period_id 從 findActivePayrollPeriod 寫入', async () => {
    const repo = makeFullRepo({
      findActivePayrollPeriod: vi.fn(async () => ({ id: 'PP_2026_04', status: 'draft' })),
    });
    await calculateMonthlySalary(repo, { employee_id:'E001', year:2026, month:4 });
    const r = repo.upsertSalaryRecord.mock.calls[0][0];
    expect(r.payroll_period_id).toBe('PP_2026_04');
  });

  it('沒 active period → payroll_period_id = null', async () => {
    const repo = makeFullRepo();  // 預設 findActivePayrollPeriod 回 null
    await calculateMonthlySalary(repo, { employee_id:'E001', year:2026, month:4 });
    const r = repo.upsertSalaryRecord.mock.calls[0][0];
    expect(r.payroll_period_id).toBeNull();
  });

  it('callerId 寫入 calculated_by + calculated_at 有值', async () => {
    const repo = makeFullRepo();
    const before = new Date().toISOString();
    await calculateMonthlySalary(repo, {
      employee_id:'E001', year:2026, month:4, callerId:'EMP_HR_001',
    });
    const r = repo.upsertSalaryRecord.mock.calls[0][0];
    expect(r.calculated_by).toBe('EMP_HR_001');
    expect(r.calculated_at >= before).toBe(true);
  });

  it('無 callerId → calculated_by = null', async () => {
    const repo = makeFullRepo();
    await calculateMonthlySalary(repo, { employee_id:'E001', year:2026, month:4 });
    const r = repo.upsertSalaryRecord.mock.calls[0][0];
    expect(r.calculated_by).toBeNull();
  });

  it('_manual 新欄位保留 existing(獎金 + welfare_fund 等)', async () => {
    const repo = makeFullRepo({
      findSalaryRecord: vi.fn(async () => ({
        id: 'S_E001_2026_04',
        bonus_yearend: 50000,
        bonus_festival: 5000,
        bonus_other_note: 'HR 補登入職獎金',
        deduct_welfare_fund: 100,
        deduct_union_fee: 200,
        deduct_court_garnishment: 1000,
        deduct_loan_repayment: 2000,
        deduct_other: 500,
        deduct_other_note: '住宿費代扣',
      })),
    });
    await calculateMonthlySalary(repo, { employee_id:'E001', year:2026, month:4 });
    const r = repo.upsertSalaryRecord.mock.calls[0][0];
    expect(r.bonus_yearend).toBe(50000);
    expect(r.bonus_festival).toBe(5000);
    expect(r.bonus_other_note).toBe('HR 補登入職獎金');
    expect(r.deduct_welfare_fund).toBe(100);
    expect(r.deduct_union_fee).toBe(200);
    expect(r.deduct_court_garnishment).toBe(1000);
    expect(r.deduct_loan_repayment).toBe(2000);
    expect(r.deduct_other).toBe(500);
    expect(r.deduct_other_note).toBe('住宿費代扣');
  });

  it('snapshot 4 欄寫入正確', async () => {
    const repo = makeFullRepo({
      findEmployeeInsuranceSettings: vi.fn(async () => ({
        has_insurance: true,
        pension_wage: 45800,
        pension_voluntary_rate: 3,
        labor_ins_bracket: 45800, labor_ins_company: 0,
        health_ins_bracket: 50000, health_ins_company: 0,
      })),
      findEmployeeForSalary: vi.fn(async () => ({
        id:'E001', base_salary: 45800, attendance_bonus: 0,
      })),
    });
    await calculateMonthlySalary(repo, { employee_id:'E001', year:2026, month:4 });
    const r = repo.upsertSalaryRecord.mock.calls[0][0];
    expect(r.pension_wage_snapshot).toBe(45800);
    expect(r.insured_salary_labor_snapshot).toBe(45800);
    expect(r.insured_salary_health_snapshot).toBe(50000);
    // taxable_income_snapshot = gross_pre_tax - voluntary
    // gross_pre_tax = base + 加項(本 case 全 0 / 非 0 部分: ab + ot + holiday + settlement + bonus = 0)
    //               = 45800 + 0 + 0 + 0 + 0 + 0 + 0 + 0 = 45800
    // voluntary = 45800 × 0.03 = 1374
    // taxable = 45800 - 1374 = 44426
    expect(r.deduct_pension_voluntary).toBe(1374);
    expect(r.taxable_income_snapshot).toBe(44426);
  });

  it('pension_wage = 0 時 fallback 到 labor_ins_bracket(2.7 fallback)', async () => {
    const repo = makeFullRepo({
      findEmployeeInsuranceSettings: vi.fn(async () => ({
        has_insurance: true,
        pension_wage: 0,                      // 既有 row 沒設、模擬 prod 既有狀況
        pension_voluntary_rate: 6,            // 6%
        labor_ins_bracket: 36300,             // fallback target
        labor_ins_company: 0,
        health_ins_bracket: 36300, health_ins_company: 0,
        health_ins_dependents: 0,
      })),
    });
    await calculateMonthlySalary(repo, { employee_id:'E001', year:2026, month:4 });
    const r = repo.upsertSalaryRecord.mock.calls[0][0];
    // 應該用 labor_ins_bracket=36300 算、不是 0
    expect(r.pension_wage_snapshot).toBe(36300);
    expect(r.employer_cost_pension).toBe(2178);  // 36300 × 0.06
    expect(r.deduct_pension_voluntary).toBe(2178); // 36300 × 0.06(自願 6%)
  });
});

describe('calculateMonthlySalary — 階段 2.6.2 deduct_tax _auto / _manual override', () => {
  it('無投保員工 → deduct_tax = 0(taxable=0、不超免稅額)', async () => {
    const repo = makeFullRepo();
    await calculateMonthlySalary(repo, { employee_id:'E001', year:2026, month:4 });
    const r = repo.upsertSalaryRecord.mock.calls[0][0];
    expect(r.deduct_tax).toBe(0);
    expect(r.deduct_tax_manual_override).toBe(false);
  });

  it('有投保 + 月薪低於免稅額 88500 → deduct_tax = 0', async () => {
    const repo = makeFullRepo({
      findEmployeeForSalary: vi.fn(async () => ({
        id:'E001', base_salary: 50000, attendance_bonus: 0,
      })),
      findEmployeeInsuranceSettings: vi.fn(async () => ({
        has_insurance: true,
        pension_wage: 50000, pension_voluntary_rate: 0,
        labor_ins_bracket: 50000, labor_ins_company: 0,
        health_ins_bracket: 50000, health_ins_company: 0,
        health_ins_dependents: 0,
      })),
    });
    await calculateMonthlySalary(repo, { employee_id:'E001', year:2026, month:4 });
    const r = repo.upsertSalaryRecord.mock.calls[0][0];
    // taxable = 50000 + 0 + 0 + ... - 0(voluntary) = 50000、< 88500、tax=0
    expect(r.deduct_tax).toBe(0);
  });

  it('有投保 + 月薪超過免稅額 → deduct_tax = (taxable - 88500) × 6%', async () => {
    const repo = makeFullRepo({
      findEmployeeForSalary: vi.fn(async () => ({
        id:'E001', base_salary: 100000, attendance_bonus: 0,
      })),
      findEmployeeInsuranceSettings: vi.fn(async () => ({
        has_insurance: true,
        pension_wage: 100000, pension_voluntary_rate: 0,
        labor_ins_bracket: 50000, labor_ins_company: 0,
        health_ins_bracket: 50000, health_ins_company: 0,
        health_ins_dependents: 0,
      })),
    });
    await calculateMonthlySalary(repo, { employee_id:'E001', year:2026, month:4 });
    const r = repo.upsertSalaryRecord.mock.calls[0][0];
    // taxable = 100000、(100000 - 88500) × 0.06 = 690
    expect(r.deduct_tax).toBe(690);
    expect(r.deduct_tax_manual_override).toBe(false);
  });

  it('扶養 1 人 → 免稅額加倍、deduct_tax 降低', async () => {
    const repo = makeFullRepo({
      findEmployeeForSalary: vi.fn(async () => ({
        id:'E001', base_salary: 200000, attendance_bonus: 0,
      })),
      findEmployeeInsuranceSettings: vi.fn(async () => ({
        has_insurance: true,
        pension_wage: 200000, pension_voluntary_rate: 0,
        labor_ins_bracket: 45800, labor_ins_company: 0,
        health_ins_bracket: 45800, health_ins_company: 0,
        health_ins_dependents: 1,
      })),
    });
    await calculateMonthlySalary(repo, { employee_id:'E001', year:2026, month:4 });
    const r = repo.upsertSalaryRecord.mock.calls[0][0];
    // taxable = 200000、(200000 - 88500 - 88500) × 0.06 = 23000 × 0.06 = 1380
    expect(r.deduct_tax).toBe(1380);
  });

  it('manual override = true → 保留 existing.deduct_tax、不被 calculator 覆蓋', async () => {
    const repo = makeFullRepo({
      findEmployeeForSalary: vi.fn(async () => ({
        id:'E001', base_salary: 200000, attendance_bonus: 0,
      })),
      findEmployeeInsuranceSettings: vi.fn(async () => ({
        has_insurance: true,
        pension_wage: 200000, pension_voluntary_rate: 0,
        labor_ins_bracket: 45800, labor_ins_company: 0,
        health_ins_bracket: 45800, health_ins_company: 0,
        health_ins_dependents: 0,
      })),
      findSalaryRecord: vi.fn(async () => ({
        id: 'S_E001_2026_04',
        deduct_tax: 5000,                       // HR 鎖定的值
        deduct_tax_manual_override: true,       // 顯式 lock
        status: 'draft',
      })),
    });
    await calculateMonthlySalary(repo, { employee_id:'E001', year:2026, month:4 });
    const r = repo.upsertSalaryRecord.mock.calls[0][0];
    // calculator 算出 (200000-88500)×0.06=6690、但 override=true、保留 existing 5000
    expect(r.deduct_tax).toBe(5000);
    expect(r.deduct_tax_manual_override).toBe(true);
  });

  it('manual override 預設 false 寫入新 row', async () => {
    const repo = makeFullRepo();
    await calculateMonthlySalary(repo, { employee_id:'E001', year:2026, month:4 });
    const r = repo.upsertSalaryRecord.mock.calls[0][0];
    expect(r.deduct_tax_manual_override).toBe(false);
  });
});
