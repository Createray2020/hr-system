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
  // 對齊 migrations/2026_05_30_add_salary_grade_manager_allowance.sql:
  //   base_salary
  //   + COALESCE(attendance_bonus_actual, 0)
  //   + COALESCE(grade_allowance, 0) + COALESCE(manager_allowance, 0)   ← 2026-05-30 加
  //   + COALESCE(allowance, 0) + COALESCE(extra_allowance, 0)
  //   + COALESCE(overtime_pay_auto + overtime_pay_manual, 0)
  //   + COALESCE(comp_expiry_payout, 0) + COALESCE(holiday_work_pay, 0) + COALESCE(settlement_amount, 0)
  return r2(
    n(row.base_salary)
    + n(row.attendance_bonus_actual)
    + n(row.grade_allowance)
    + n(row.manager_allowance)
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
  // 對齊 migrations/2026_05_30_add_salary_grade_manager_allowance.sql net 段:
  return r2(
    n(row.base_salary)
    + n(row.attendance_bonus_actual)
    + n(row.grade_allowance)
    + n(row.manager_allowance)
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

describe('GENERATED column 雙向綁定 — grade_allowance / manager_allowance(2026-05-30)', () => {
  it('row 帶 grade=3000 + manager=2000 → 都進 gross 與 net', () => {
    const row = {
      base_salary: 30000, attendance_bonus_actual: 2000,
      grade_allowance: 3000, manager_allowance: 2000,
      deduct_labor_ins: 500,
    };
    // gross = 30000 + 2000 + 3000 + 2000 = 37000
    expect(computeGrossSalary(row)).toBe(refGrossSalary(row));
    expect(computeGrossSalary(row)).toBe(37000);
    // net = 37000 - 500 = 36500
    expect(computeNetSalary(row)).toBe(refNetSalary(row));
    expect(computeNetSalary(row)).toBe(36500);
  });
  it('grade / manager 為 null/undefined → 視為 0', () => {
    const row = { base_salary: 30000, grade_allowance: null };
    expect(computeGrossSalary(row)).toBe(refGrossSalary(row));
    expect(computeGrossSalary(row)).toBe(30000);
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

    // B26 批次 4:離職月 settlement source(employee_id-based、不限 month)
    findAllPaidOutAnnualForEmployee:    vi.fn(async () => []),
    findAllExpiredPaidCompForEmployee:  vi.fn(async () => []),

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
    // 2 次 = step 4 預建 skeleton + step 15 final upsert(無 existing 走預建分支、防 FK 23503)
    expect(repo.upsertSalaryRecord).toHaveBeenCalledTimes(2);
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
        deduct_labor_ins: 1100,           // 階段 2.7.8 起為 _auto、existing 不再 preserve
        deduct_health_ins: 550,           // 階段 2.7.8 起為 _auto、existing 不再 preserve
        deduct_tax: 1700,                 // _manual 保留(透過 deduct_tax_manual_override)
        deduct_tax_manual_override: true, // 階段 2.6.2: 顯式標 _manual override
        attendance_penalty_total: 9999,   // _auto 應被覆蓋
        comp_expiry_payout: 9999,         // _auto 應被覆蓋
        settlement_amount: 9999,          // _auto 應被覆蓋
        status: 'draft',
        note: '原備註',
      })),
    });
    await calculateMonthlySalary(repo, { employee_id:'E001', year:2026, month:4 });
    const upserted = repo.upsertSalaryRecord.mock.calls.at(-1)[0];
    // _manual 保留
    expect(upserted.overtime_pay_manual).toBe(1500);
    expect(upserted.overtime_pay_note).toBe('HR 補加班費');
    expect(upserted.allowance).toBe(800);
    expect(upserted.extra_allowance).toBe(200);
    expect(upserted.deduct_tax).toBe(1700);
    expect(upserted.note).toBe('原備註');
    // _auto 重算為 0(因為 mock repo 沒回 records / 沒投保 settings)
    expect(upserted.overtime_pay_auto).toBe(0);
    expect(upserted.attendance_penalty_total).toBe(0);
    expect(upserted.comp_expiry_payout).toBe(0);
    expect(upserted.settlement_amount).toBe(0);
    // 階段 2.7.8: deduct_labor_ins / deduct_health_ins 改為 _auto、無投保 settings → 0
    expect(upserted.deduct_labor_ins).toBe(0);
    expect(upserted.deduct_health_ins).toBe(0);
  });

  it('沒既有 record → _manual 預設 0', async () => {
    const repo = makeFullRepo();
    await calculateMonthlySalary(repo, { employee_id:'E001', year:2026, month:4 });
    const upserted = repo.upsertSalaryRecord.mock.calls.at(-1)[0];
    expect(upserted.overtime_pay_manual).toBe(0);
    expect(upserted.allowance).toBe(0);
    expect(upserted.extra_allowance).toBe(0);
  });

  it('emp 沒 grade_allowance / manager_allowance(舊資料)→ 寫 0', async () => {
    const repo = makeFullRepo();
    await calculateMonthlySalary(repo, { employee_id:'E001', year:2026, month:4 });
    const upserted = repo.upsertSalaryRecord.mock.calls.at(-1)[0];
    expect(upserted.grade_allowance).toBe(0);
    expect(upserted.manager_allowance).toBe(0);
  });

  it('一般月:emp.grade=3000、manager=2000 → 全額寫入 salary_records', async () => {
    const repo = makeFullRepo({
      findEmployeeForSalary: vi.fn(async () => ({
        id: 'E001', base_salary: 30000, attendance_bonus: 2000, employment_type: 'full_time',
        grade_allowance: 3000, manager_allowance: 2000,
      })),
    });
    await calculateMonthlySalary(repo, { employee_id:'E001', year:2026, month:5 });
    const upserted = repo.upsertSalaryRecord.mock.calls.at(-1)[0];
    expect(upserted.grade_allowance).toBe(3000);
    expect(upserted.manager_allowance).toBe(2000);
    // 一般月 proRataRatio=1、prorata_base 為 null(沒 final-month flag)
    expect(upserted.prorata_base).toBeNull();
  });

  it('離職月:emp.grade=3000 + ratio=10/30 → 1000(跟 base_salary 同比例)', async () => {
    const repo = makeFullRepo({
      findEmployeeForSalary: vi.fn(async () => ({
        id: 'E001', base_salary: 30000, attendance_bonus: 0, employment_type: 'full_time',
        grade_allowance: 3000, manager_allowance: 6000,
      })),
      findSalaryRecord: vi.fn(async () => ({
        id: 'S_E001_2026_05', status: 'draft',
        is_final_month: true, worked_days: 10, total_days_in_month: 30,
      })),
    });
    await calculateMonthlySalary(repo, { employee_id:'E001', year:2026, month:5 });
    const upserted = repo.upsertSalaryRecord.mock.calls.at(-1)[0];
    // ratio = 10/30 → 3000 × ratio = 1000;6000 × ratio = 2000
    expect(upserted.grade_allowance).toBe(1000);
    expect(upserted.manager_allowance).toBe(2000);
    // prorata_base = base × ratio = 30000 × 10/30 = 10000(同 ratio 證明對齊)
    expect(upserted.prorata_base).toBe(10000);
  });

  it('一般月:重算每次都覆寫 grade/manager(不像 allowance 是 _manual 保留)', async () => {
    const repo = makeFullRepo({
      findEmployeeForSalary: vi.fn(async () => ({
        id: 'E001', base_salary: 30000, attendance_bonus: 0, employment_type: 'full_time',
        grade_allowance: 5000, manager_allowance: 0,
      })),
      findSalaryRecord: vi.fn(async () => ({
        id: 'S_E001_2026_05', status: 'draft',
        grade_allowance: 9999, manager_allowance: 9999, // 舊值,要被覆寫
        allowance: 800,                                   // _manual 保留
      })),
    });
    await calculateMonthlySalary(repo, { employee_id:'E001', year:2026, month:5 });
    const upserted = repo.upsertSalaryRecord.mock.calls.at(-1)[0];
    // 從 emp 同步、不看 existing 9999
    expect(upserted.grade_allowance).toBe(5000);
    expect(upserted.manager_allowance).toBe(0);
    // 對照組:allowance 仍保留 existing
    expect(upserted.allowance).toBe(800);
  });

  it('既有 status=confirmed → 重算後 status 仍 confirmed(不退回 draft)', async () => {
    const repo = makeFullRepo({
      findSalaryRecord: vi.fn(async () => ({ id:'S_E001_2026_04', status:'confirmed' })),
    });
    await calculateMonthlySalary(repo, { employee_id:'E001', year:2026, month:4 });
    expect(repo.upsertSalaryRecord.mock.calls.at(-1)[0].status).toBe('confirmed');
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
    const upserted = repo.upsertSalaryRecord.mock.calls.at(-1)[0];
    expect(upserted.daily_wage_snapshot).toBe(2000);
  });

  it('扣 absence_days × daily_wage 寫入 deduct_absence', async () => {
    const repo = makeFullRepo({
      findEmployeeForSalary: vi.fn(async () => ({ id:'E001', base_salary: 44000, attendance_bonus: 0 })),
      findAbsentDaysByEmployeeMonth: vi.fn(async () => 2),
    });
    await calculateMonthlySalary(repo, { employee_id:'E001', year:2026, month:4 });
    const upserted = repo.upsertSalaryRecord.mock.calls.at(-1)[0];
    expect(upserted.absence_days).toBe(2);
    expect(upserted.deduct_absence).toBe(4000); // 2 × 2000
  });
});

describe('calculateMonthlySalary — 階段 2.5.2 新欄位寫入', () => {
  it('無投保員工 → 全部新 _auto 欄位 = 0', async () => {
    const repo = makeFullRepo();  // findEmployeeInsuranceSettings 預設 null
    await calculateMonthlySalary(repo, { employee_id:'E001', year:2026, month:4 });
    const r = repo.upsertSalaryRecord.mock.calls.at(-1)[0];
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
    const r = repo.upsertSalaryRecord.mock.calls.at(-1)[0];
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
    const r = repo.upsertSalaryRecord.mock.calls.at(-1)[0];
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
    const r = repo.upsertSalaryRecord.mock.calls.at(-1)[0];
    expect(r.deduct_supplementary_health).toBe(0);
  });

  it('payroll_period_id 從 findActivePayrollPeriod 寫入', async () => {
    const repo = makeFullRepo({
      findActivePayrollPeriod: vi.fn(async () => ({ id: 'PP_2026_04', status: 'draft' })),
    });
    await calculateMonthlySalary(repo, { employee_id:'E001', year:2026, month:4 });
    const r = repo.upsertSalaryRecord.mock.calls.at(-1)[0];
    expect(r.payroll_period_id).toBe('PP_2026_04');
  });

  it('沒 active period → payroll_period_id = null', async () => {
    const repo = makeFullRepo();  // 預設 findActivePayrollPeriod 回 null
    await calculateMonthlySalary(repo, { employee_id:'E001', year:2026, month:4 });
    const r = repo.upsertSalaryRecord.mock.calls.at(-1)[0];
    expect(r.payroll_period_id).toBeNull();
  });

  it('callerId 寫入 calculated_by + calculated_at 有值', async () => {
    const repo = makeFullRepo();
    const before = new Date().toISOString();
    await calculateMonthlySalary(repo, {
      employee_id:'E001', year:2026, month:4, callerId:'EMP_HR_001',
    });
    const r = repo.upsertSalaryRecord.mock.calls.at(-1)[0];
    expect(r.calculated_by).toBe('EMP_HR_001');
    expect(r.calculated_at >= before).toBe(true);
  });

  it('無 callerId → calculated_by = null', async () => {
    const repo = makeFullRepo();
    await calculateMonthlySalary(repo, { employee_id:'E001', year:2026, month:4 });
    const r = repo.upsertSalaryRecord.mock.calls.at(-1)[0];
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
    const r = repo.upsertSalaryRecord.mock.calls.at(-1)[0];
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
    const r = repo.upsertSalaryRecord.mock.calls.at(-1)[0];
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
    const r = repo.upsertSalaryRecord.mock.calls.at(-1)[0];
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
    const r = repo.upsertSalaryRecord.mock.calls.at(-1)[0];
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
    const r = repo.upsertSalaryRecord.mock.calls.at(-1)[0];
    // taxable = 50000 + 0 + 0 + ... - 0(voluntary) = 50000、< 88500、tax=0
    expect(r.deduct_tax).toBe(0);
  });

  it('2025/有投保/月薪超過 88500 免稅額 → deduct_tax = (taxable - 88500) × 6%', async () => {
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
    // 2025 年沿用 TW_2025_DEFAULTS:base=88500
    await calculateMonthlySalary(repo, { employee_id:'E001', year:2025, month:4 });
    const r = repo.upsertSalaryRecord.mock.calls.at(-1)[0];
    // taxable = 100000、(100000 - 88500) × 0.06 = 690
    expect(r.deduct_tax).toBe(690);
    expect(r.deduct_tax_manual_override).toBe(false);
  });

  it('2025/扶養 1 人 → 免稅額加倍、deduct_tax 降低', async () => {
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
    await calculateMonthlySalary(repo, { employee_id:'E001', year:2025, month:4 });
    const r = repo.upsertSalaryRecord.mock.calls.at(-1)[0];
    // taxable = 200000、(200000 - 88500 - 88500) × 0.06 = 23000 × 0.06 = 1380
    expect(r.deduct_tax).toBe(1380);
  });

  it('2026/Ray case:無 insurance / gross 90,000 / 起扣 90501 → deduct_tax = 0', async () => {
    const repo = makeFullRepo({
      findEmployeeForSalary: vi.fn(async () => ({
        id:'E_RAY', base_salary: 30000, attendance_bonus: 0,
      })),
      // 無 insurance row → calculator 視為 hasInsurance=false、勞健保 + dependentCount 全 0
      findEmployeeInsuranceSettings: vi.fn(async () => null),
    });
    await calculateMonthlySalary(repo, { employee_id:'E_RAY', year:2026, month:5 });
    const r = repo.upsertSalaryRecord.mock.calls.at(-1)[0];
    // 2026 起 base=90501;taxable_income_snapshot 來自 base_salary 30000 → < 90501 → 0
    expect(r.deduct_tax).toBe(0);
    expect(r.deduct_tax_manual_override).toBe(false);
  });

  it('2026/有投保/taxable 100000 起扣 90501 →(100000-90501)×6% = 570(對照 2025=690)', async () => {
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
    await calculateMonthlySalary(repo, { employee_id:'E001', year:2026, month:5 });
    const r = repo.upsertSalaryRecord.mock.calls.at(-1)[0];
    expect(r.deduct_tax).toBe(570);
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
    const r = repo.upsertSalaryRecord.mock.calls.at(-1)[0];
    // calculator 算出 (200000-88500)×0.06=6690、但 override=true、保留 existing 5000
    expect(r.deduct_tax).toBe(5000);
    expect(r.deduct_tax_manual_override).toBe(true);
  });

  it('manual override 預設 false 寫入新 row', async () => {
    const repo = makeFullRepo();
    await calculateMonthlySalary(repo, { employee_id:'E001', year:2026, month:4 });
    const r = repo.upsertSalaryRecord.mock.calls.at(-1)[0];
    expect(r.deduct_tax_manual_override).toBe(false);
  });
});

describe('calculateMonthlySalary — 階段 2.7.8 員工自付勞健保 _auto', () => {
  // 對應 prod bug: 全 24 員工 deduct_labor_ins / deduct_health_ins 全 0、
  // 實發每月多發 ~27,000(全公司加總)。calculator 員工端漏讀、雇主端 employer_cost_* 是對的。

  it('ins.labor_ins_employee = 653 → row.deduct_labor_ins = 653(EMP_01191201 鄭昭君 case)', async () => {
    const repo = makeFullRepo({
      findEmployeeInsuranceSettings: vi.fn(async () => ({
        has_insurance: true,
        labor_ins_employee:  653,    // direct premium、應直接寫入
        labor_ins_company:   2285,
        labor_ins_bracket:   31800,
        health_ins_employee: 545,
        health_ins_company:  1089,
        health_ins_bracket:  31800,
        pension_wage:        31800,
      })),
    });
    await calculateMonthlySalary(repo, { employee_id:'E001', year:2026, month:5 });
    const r = repo.upsertSalaryRecord.mock.calls.at(-1)[0];
    expect(r.deduct_labor_ins).toBe(653);
    expect(r.deduct_health_ins).toBe(545);
    // 雇主端對齊比較(原本就對、本 case 為 regression guard)
    expect(r.employer_cost_labor).toBe(2285);
    expect(r.employer_cost_health).toBe(1089);
  });

  it('labor_ins_employee = NULL + bracket = 45800 → fallback = 45800 × 2.3% = 1053', async () => {
    const repo = makeFullRepo({
      findEmployeeInsuranceSettings: vi.fn(async () => ({
        has_insurance: true,
        // labor_ins_employee / health_ins_employee 故意 NULL、測 fallback
        labor_ins_bracket:  45800,
        labor_ins_company:  3490,
        health_ins_bracket: 45800,
        health_ins_company: 1410,
      })),
    });
    await calculateMonthlySalary(repo, { employee_id:'E001', year:2026, month:5 });
    const r = repo.upsertSalaryRecord.mock.calls.at(-1)[0];
    // 45800 × 0.023 = 1053.4 → round 1053
    expect(r.deduct_labor_ins).toBe(1053);
    // 45800 × 0.01551 = 710.358 → round 710
    expect(r.deduct_health_ins).toBe(710);
  });

  it('labor_ins_employee = 0(明確設零、離職 / waived)→ 不 fallback、寫 0', async () => {
    const repo = makeFullRepo({
      findEmployeeInsuranceSettings: vi.fn(async () => ({
        has_insurance: true,
        labor_ins_employee:  0,        // 明確 0、不 fallback
        labor_ins_bracket:   45800,    // bracket 有值、若誤 fallback 會變 1053
        health_ins_employee: 0,
        health_ins_bracket:  45800,
      })),
    });
    await calculateMonthlySalary(repo, { employee_id:'E001', year:2026, month:5 });
    const r = repo.upsertSalaryRecord.mock.calls.at(-1)[0];
    expect(r.deduct_labor_ins).toBe(0);
    expect(r.deduct_health_ins).toBe(0);
  });

  it('has_insurance = false → 不論 ins 怎麼設都 0', async () => {
    const repo = makeFullRepo({
      findEmployeeInsuranceSettings: vi.fn(async () => ({
        has_insurance: false,
        labor_ins_employee: 999, health_ins_employee: 999,  // 應全 ignored
        labor_ins_bracket: 45800, health_ins_bracket: 45800,
      })),
    });
    await calculateMonthlySalary(repo, { employee_id:'E001', year:2026, month:5 });
    const r = repo.upsertSalaryRecord.mock.calls.at(-1)[0];
    expect(r.deduct_labor_ins).toBe(0);
    expect(r.deduct_health_ins).toBe(0);
  });
});

describe('calculateMonthlySalary — 階段 2.7.5 FK 順序保護(skeleton 預建)', () => {
  // 模擬 supabase / PG FK 23503 行為:
  //   overtime_requests.applied_to_salary_record_id / attendance_penalty_records.salary_record_id
  //   都 REFERENCES salary_records(id)、若 mark 時 target salary_record 不存在 → throw
  //
  // 抓的是 step 4 之後沒先預建 skeleton 就走 step 6/7 的 bug。
  // 對應 prod 實例:劉嘉昕(EMP_01250501)2026-05 試算第一次失敗、
  // overtime_requests 1 row(id=3, applied_to_salary_record_id=null)→ markOvertimeRequestApplied
  // 撞 fk_overtime_requests_salary(batch_c §3)。
  function makeFkAwareRepo(over = {}) {
    const insertedSalaryIds = new Set();
    const repo = makeFullRepo({
      upsertSalaryRecord: vi.fn(async (row) => {
        insertedSalaryIds.add(row.id);
        return { ...row };
      }),
      markOvertimeRequestApplied: vi.fn(async (id, salary_record_id) => {
        if (!insertedSalaryIds.has(salary_record_id)) {
          throw new Error(
            `insert or update on table "overtime_requests" violates foreign key constraint ` +
            `"fk_overtime_requests_salary" (salary_record_id=${salary_record_id} not found)`
          );
        }
      }),
      markPenaltyRecordApplied: vi.fn(async (id, salary_record_id) => {
        if (!insertedSalaryIds.has(salary_record_id)) {
          throw new Error(
            `insert or update on table "attendance_penalty_records" violates foreign key constraint ` +
            `"fk_penalty_records_salary" (salary_record_id=${salary_record_id} not found)`
          );
        }
      }),
      ...over,
    });
    return { repo, insertedSalaryIds };
  }

  it('fresh batch + 有 approved overtime → 不應因 FK 23503 throw(劉嘉昕 case)', async () => {
    const { repo } = makeFkAwareRepo({
      findApprovedOvertimePayRequests: vi.fn(async () => [
        { id: 3, estimated_pay: 1500, hours: 4, pay_multiplier: 1.34, overtime_date: '2026-05-08' },
      ]),
    });
    await expect(
      calculateMonthlySalary(repo, { employee_id:'E001', year:2026, month:5 })
    ).resolves.toBeTruthy();
    // step 4 預建 skeleton + step 15 final upsert = 2 次
    expect(repo.upsertSalaryRecord).toHaveBeenCalledTimes(2);
    expect(repo.markOvertimeRequestApplied).toHaveBeenCalledWith(3, 'S_E001_2026_05');
  });

  it('fresh batch + 有 pending penalty → 不應因 FK 23503 throw', async () => {
    const { repo } = makeFkAwareRepo({
      findPendingPenaltyRecords: vi.fn(async () => [
        { id: 7, penalty_type: 'deduct_money', penalty_amount: 200, trigger_type: 'late', trigger_minutes: 30 },
      ]),
    });
    await expect(
      calculateMonthlySalary(repo, { employee_id:'E001', year:2026, month:5 })
    ).resolves.toBeTruthy();
    expect(repo.markPenaltyRecordApplied).toHaveBeenCalledWith(7, 'S_E001_2026_05');
  });

  it('既有 record → 不重複預建 skeleton(只走 step 15 final upsert)', async () => {
    const { repo, insertedSalaryIds } = makeFkAwareRepo({
      findSalaryRecord: vi.fn(async () => ({
        id: 'S_E001_2026_05', status: 'draft',
      })),
      findApprovedOvertimePayRequests: vi.fn(async () => [
        { id: 3, estimated_pay: 1500 },
      ]),
    });
    // 既有 record 代表 DB 已有 salary_records row、預先標記避免 mock FK throw
    insertedSalaryIds.add('S_E001_2026_05');
    await calculateMonthlySalary(repo, { employee_id:'E001', year:2026, month:5 });
    // 既有 → 只 final upsert 1 次、reset markers 走 if 分支
    expect(repo.upsertSalaryRecord).toHaveBeenCalledTimes(1);
    expect(repo.resetOvertimeMarkers).toHaveBeenCalledWith('S_E001_2026_05');
  });

  it('skeleton 寫入有 callerId / status=draft / base_salary', async () => {
    const { repo } = makeFkAwareRepo();
    await calculateMonthlySalary(repo, {
      employee_id:'E001', year:2026, month:5, callerId:'EMP_HR_001',
    });
    // 第一次 call = skeleton
    const skel = repo.upsertSalaryRecord.mock.calls.at(-1)[0];
    expect(skel.id).toBe('S_E001_2026_05');
    expect(skel.employee_id).toBe('E001');
    expect(skel.year).toBe(2026);
    expect(skel.month).toBe(5);
    expect(skel.base_salary).toBe(50000);
    expect(skel.status).toBe('draft');
    expect(skel.calculated_by).toBe('EMP_HR_001');
    expect(skel.calculated_at).toBeTruthy();
  });
});

describe('calculateMonthlySalary — 階段 C3 penalty orphan reset', () => {
  // 抓 HR DELETE salary_records 後 PG FK ON DELETE SET NULL 自動清 FK、
  // 但 attendance_penalty_records.status='applied' 沒連動的 edge case。
  // 修法:existing=null 分支額外 call resetOrphanedPenaltyForMonth。

  it('existing=null + repo 有 resetOrphanedPenaltyForMonth → 應被呼叫 + 帶對 args', async () => {
    const repo = makeFullRepo({
      resetOrphanedPenaltyForMonth: vi.fn(async () => undefined),
    });
    await calculateMonthlySalary(repo, { employee_id:'E001', year:2026, month:5 });
    expect(repo.resetOrphanedPenaltyForMonth).toHaveBeenCalledWith({
      employee_id: 'E001', year: 2026, month: 5,
    });
  });

  it('existing 不為 null → 不呼叫 resetOrphanedPenaltyForMonth (走 existing 分支、resetPenaltyRecordsMarkers 已處理)', async () => {
    const repo = makeFullRepo({
      findSalaryRecord: vi.fn(async () => ({ id: 'S_E001_2026_05', status: 'draft' })),
      resetOrphanedPenaltyForMonth: vi.fn(async () => undefined),
    });
    await calculateMonthlySalary(repo, { employee_id:'E001', year:2026, month:5 });
    expect(repo.resetOrphanedPenaltyForMonth).not.toHaveBeenCalled();
    expect(repo.resetPenaltyRecordsMarkers).toHaveBeenCalledWith('S_E001_2026_05');
  });

  it('repo 沒 resetOrphanedPenaltyForMonth method (向下相容、舊 repo) → 不爆', async () => {
    const repo = makeFullRepo();  // 沒提供 resetOrphanedPenaltyForMonth
    await expect(
      calculateMonthlySalary(repo, { employee_id:'E001', year:2026, month:5 })
    ).resolves.toBeTruthy();
  });
});

describe('calculateMonthlySalary — 階段 2.7.9 UPSERT idempotency', () => {
  // 抓「同員工同月連跑兩次都成功 + _manual 欄位保留」的行為。
  // 用 stateful mock:findSalaryRecord 第一次 null、之後回上次 upsert 的 row。
  function makeStatefulRepo(over = {}) {
    let lastUpserted = null;
    const repo = makeFullRepo({
      findSalaryRecord:    vi.fn(async () => lastUpserted),
      upsertSalaryRecord:  vi.fn(async (row) => {
        // 模擬 supabase .upsert(onConflict='id'):existing row merge with new payload
        // (新 payload 欄位 overwrite、未提供的欄位保留 existing)
        lastUpserted = { ...(lastUpserted || {}), ...row };
        return { ...lastUpserted };
      }),
      ...over,
    });
    return { repo, getLast: () => lastUpserted, setLast: (r) => { lastUpserted = r; } };
  }

  it('連跑兩次同員工同月 → 都 resolve、不撞 unique key', async () => {
    const { repo } = makeStatefulRepo();
    await expect(
      calculateMonthlySalary(repo, { employee_id:'E001', year:2026, month:5 })
    ).resolves.toBeTruthy();
    await expect(
      calculateMonthlySalary(repo, { employee_id:'E001', year:2026, month:5 })
    ).resolves.toBeTruthy();
    // 第一次:skeleton + final = 2 次;第二次:reset + final = 1 次;合計 3 次
    expect(repo.upsertSalaryRecord).toHaveBeenCalledTimes(3);
  });

  it('既有 _manual 欄位 (overtime_pay_manual / allowance / extra_allowance) 第二次跑後保留', async () => {
    const { repo, getLast, setLast } = makeStatefulRepo();
    await calculateMonthlySalary(repo, { employee_id:'E001', year:2026, month:5 });
    // 模擬 HR 在第一次跑完後手動改 _manual 欄位 (e.g. salary.html 編輯 modal)
    setLast({
      ...getLast(),
      overtime_pay_manual: 1500,
      overtime_pay_note:   'HR 補加班',
      allowance:           800,
      extra_allowance:     200,
    });
    // 第二次跑、_manual 欄位應保留
    await calculateMonthlySalary(repo, { employee_id:'E001', year:2026, month:5 });
    const r = getLast();
    expect(r.overtime_pay_manual).toBe(1500);
    expect(r.overtime_pay_note).toBe('HR 補加班');
    expect(r.allowance).toBe(800);
    expect(r.extra_allowance).toBe(200);
  });

  it('deduct_tax_manual_override=true → 第二次跑 deduct_tax 值不變', async () => {
    const { repo, getLast, setLast } = makeStatefulRepo({
      // 高薪員工 → calculator 算出來的 deduct_tax 會 > 0、確認 override=true 不被覆蓋
      findEmployeeForSalary: vi.fn(async () => ({
        id:'E001', base_salary: 200000, attendance_bonus: 0,
      })),
      findEmployeeInsuranceSettings: vi.fn(async () => ({
        has_insurance: true,
        labor_ins_bracket: 45800, labor_ins_employee: 1054, labor_ins_company: 3490,
        health_ins_bracket: 45800, health_ins_employee: 711, health_ins_company: 1410,
        pension_wage: 200000,
      })),
    });
    await calculateMonthlySalary(repo, { employee_id:'E001', year:2026, month:5 });
    // 模擬 HR 鎖 deduct_tax = 5000
    setLast({
      ...getLast(),
      deduct_tax: 5000,
      deduct_tax_manual_override: true,
    });
    // 第二次跑、override 應保護 5000 不被覆蓋
    await calculateMonthlySalary(repo, { employee_id:'E001', year:2026, month:5 });
    const r = getLast();
    expect(r.deduct_tax).toBe(5000);
    expect(r.deduct_tax_manual_override).toBe(true);
  });

  it('_auto 欄位第二次跑後重算 (deduct_labor_ins / deduct_health_ins / employer_cost_*)', async () => {
    const { repo, getLast } = makeStatefulRepo({
      findEmployeeInsuranceSettings: vi.fn(async () => ({
        has_insurance: true,
        labor_ins_employee: 653, labor_ins_company: 2285,
        health_ins_employee: 545, health_ins_company: 1089,
        labor_ins_bracket: 31800, health_ins_bracket: 31800,
        pension_wage: 31800,
      })),
    });
    await calculateMonthlySalary(repo, { employee_id:'E001', year:2026, month:5 });
    await calculateMonthlySalary(repo, { employee_id:'E001', year:2026, month:5 });
    const r = getLast();
    // _auto 欄位每次都從 insurance_settings 重算
    expect(r.deduct_labor_ins).toBe(653);
    expect(r.deduct_health_ins).toBe(545);
    expect(r.employer_cost_labor).toBe(2285);
    expect(r.employer_cost_health).toBe(1089);
  });
});

// ─── B26 批次 4:離職月 pro-rata 整鏈路 ────────────────────────
describe('calculateMonthlySalary — B26 批次 4 離職月 pro-rata', () => {
  // 對齊柯郁含案實際數據:base=30000, hourly=125, resign_date=2026-05-13
  //   worked_days=13, total_days_in_month=31, proRataRatio = 13/31 = 0.4193548...
  //   prorata_base = round2(30000 × 13/31) = 12580.65
  //   daily_wage_settlement = 30000 / 30 = 1000
  function makeFinalMonthRepo(over = {}) {
    return makeFullRepo({
      findEmployeeForSalary: vi.fn(async () => ({
        id: 'EMP_01251101', base_salary: 30000, attendance_bonus: 0, employment_type: 'full_time',
      })),
      findEmployeeHourlyRate: vi.fn(async () => 125),
      // existing 含 is_final_month 4 欄位(由 B26 批次 1 schema + 批次 3 cascade #6 填)
      findSalaryRecord: vi.fn(async () => ({
        id: 'S_EMP_01251101_2026_05',
        is_final_month: true,
        worked_days: 13,
        total_days_in_month: 31,
        pro_rata_mode: 'calendar_day',
        status: 'draft',
      })),
      // 投保:勞健保 bracket + direct premium(便於 verify ratio)
      findEmployeeInsuranceSettings: vi.fn(async () => ({
        has_insurance: true,
        labor_ins_bracket: 30000,  labor_ins_employee: 690,  labor_ins_company: 2100,
        health_ins_bracket: 30000, health_ins_employee: 465, health_ins_company: 1050,
        pension_wage: 30000, pension_voluntary_rate: 0,
      })),
      // 批次 2 cascade #4/#5 寫好的 source data(employee_id-based 撈、不限 month)
      findAllPaidOutAnnualForEmployee: vi.fn(async () => [
        { id: 73, settlement_amount: 11000 },  // 11 天 × 1000 = 11000(柯郁含 Record 73)
        // Record 74 (settlement=0) 不會被撈(>0 filter)
      ]),
      findAllExpiredPaidCompForEmployee: vi.fn(async () => [
        { id: 54, expiry_payout_amount: 1340 },
      ]),
      ...over,
    });
  }

  it('B26.5 is_final_month=true 整鏈路:prorata_base + settlement + comp + 各欄位 × ratio', async () => {
    const repo = makeFinalMonthRepo();
    const { record } = await calculateMonthlySalary(repo, {
      employee_id: 'EMP_01251101', year: 2026, month: 5,
    });

    // §38 結算日薪、所有 row 都寫
    expect(record.daily_wage_settlement).toBe(1000);  // 30000 / 30

    // prorata_base:離職月寫值(GENERATED gross/net 用 COALESCE 自動選對)
    // round2(30000 × 13/31) = 12580.65
    expect(record.prorata_base).toBe(12580.65);

    // settlement_amount 撈 cascade #4 寫好的(不重算、employee_id-based 不限 month)
    expect(record.settlement_amount).toBe(11000);

    // comp_expiry_payout 撈 cascade #5 寫好的
    expect(record.comp_expiry_payout).toBe(1340);

    // 各 deduction × proRataRatio (13/31 = 0.4193548...)
    // Math.round(690 × 13/31) = Math.round(289.355) = 289
    expect(record.deduct_labor_ins).toBe(289);
    // Math.round(465 × 13/31) = Math.round(194.999) = 195
    expect(record.deduct_health_ins).toBe(195);

    // employer_cost × ratio
    // Math.round(2100 × 13/31) = Math.round(880.645) = 881
    expect(record.employer_cost_labor).toBe(881);
    // Math.round(1050 × 13/31) = Math.round(440.323) = 440
    expect(record.employer_cost_health).toBe(440);
  });

  it('B26.6 is_final_month=false 回歸:prorata_base=NULL、deduct_* 不 pro-rata', async () => {
    // 不傳 is_final_month → existing 為 null → isFinalMonth=false / proRataRatio=1
    const repo = makeFullRepo({
      findEmployeeForSalary: vi.fn(async () => ({
        id: 'E001', base_salary: 30000, attendance_bonus: 0, employment_type: 'full_time',
      })),
      findEmployeeInsuranceSettings: vi.fn(async () => ({
        has_insurance: true,
        labor_ins_bracket: 30000,  labor_ins_employee: 690,  labor_ins_company: 2100,
        health_ins_bracket: 30000, health_ins_employee: 465, health_ins_company: 1050,
        pension_wage: 30000,
      })),
    });
    const { record } = await calculateMonthlySalary(repo, {
      employee_id: 'E001', year: 2026, month: 5,
    });

    // prorata_base null(non-final-month、GENERATED COALESCE 走 base_salary)
    expect(record.prorata_base).toBeNull();

    // daily_wage_settlement 仍寫(無條件、給未來離職月切換用)
    expect(record.daily_wage_settlement).toBe(1000);

    // deduct_* 跟 employer_cost_* 完全等於整月值(× ratio=1、零回歸)
    expect(record.deduct_labor_ins).toBe(690);
    expect(record.deduct_health_ins).toBe(465);
    expect(record.employer_cost_labor).toBe(2100);
    expect(record.employer_cost_health).toBe(1050);
  });

  it('B26.8 step 11 勞健保 pro-rata:4 個欄位 deduct + employer_cost 都 × ratio', async () => {
    const repo = makeFinalMonthRepo();
    const { record } = await calculateMonthlySalary(repo, {
      employee_id: 'EMP_01251101', year: 2026, month: 5,
    });

    const ratio = 13 / 31;
    // 員工負擔
    expect(record.deduct_labor_ins).toBe(Math.round(690 * ratio));
    expect(record.deduct_health_ins).toBe(Math.round(465 * ratio));
    // 雇主負擔
    expect(record.employer_cost_labor).toBe(Math.round(2100 * ratio));
    expect(record.employer_cost_health).toBe(Math.round(1050 * ratio));
  });
});

// ─── part_time:不計月薪型加給(grade_allowance / manager_allowance / attendance_bonus)──────
describe('calculateMonthlySalary — part_time 不計月薪型加給', () => {
  it('emp 有 grade=1000 / mgr=500 / attendance_bonus=2000 殘留、但 part_time 應全歸 0', async () => {
    // 模擬吳/鄭 case:歷史 employees row 仍掛一等2 的加給結構(prod 沒被洗掉)、
    // calculator part_time 分支必須強制忽略、不滲漏到 gross。
    const repo = makeFullRepo({
      findEmployeeForSalary: vi.fn(async () => ({
        id: 'E_PT', base_salary: 0,             // 兼職 base=0
        attendance_bonus: 2000,                 // 🔴 殘留值、calculator 應忽略
        grade_allowance:  1000,                 // 🔴 同
        manager_allowance: 500,                 // 🔴 同
        employment_type: 'part_time',
      })),
      // part_time 分支需要這 2 個 helper(commit 0b89d5e 加的)
      findEmployeeHourlyRate: vi.fn(async () => 210),
      findTotalWorkHoursByEmployeeMonth: vi.fn(async () => 100),  // 100 hr × 210 = 21,000
      findEmployeeInsuranceSettings: vi.fn(async () => null),     // 無投保
    });
    await calculateMonthlySalary(repo, { employee_id:'E_PT', year:2026, month:5 });
    const row = repo.upsertSalaryRecord.mock.calls.at(-1)[0];

    // base/勞健保 0、加給 3 項一律 0
    expect(row.base_salary).toBe(0);
    expect(row.grade_allowance).toBe(0);
    expect(row.manager_allowance).toBe(0);
    expect(row.attendance_bonus_actual).toBe(0);
    expect(row.attendance_bonus_base).toBe(0);
    // 時薪 × 工時 進 prorata_base(GENERATED gross 走 COALESCE(prorata_base, base_salary))
    expect(row.prorata_base).toBe(21000);
    expect(row.hourly_rate).toBe(210);
    expect(row.work_hours).toBe(100);

    // gross 對齊 GENERATED 公式 COALESCE(prorata_base, base_salary) + 加項
    // 不能用 refGrossSalary(它沒 prorata_base 邏輯、會用 base_salary=0 漏算)
    const gross =
      (row.prorata_base != null ? Number(row.prorata_base) : Number(row.base_salary))
      + Number(row.attendance_bonus_actual || 0)
      + Number(row.grade_allowance || 0)
      + Number(row.manager_allowance || 0)
      + Number(row.allowance || 0)
      + Number(row.extra_allowance || 0)
      + Number(row.overtime_pay_auto || 0)
      + Number(row.overtime_pay_manual || 0)
      + Number(row.comp_expiry_payout || 0)
      + Number(row.holiday_work_pay || 0)
      + Number(row.settlement_amount || 0);
    expect(gross).toBe(21000);  // 只有 prorata_base、其他全 0
  });

  it('part_time + employees 殘留 attendance_bonus=2000 → calculator 跳過 applyAttendanceBonus', async () => {
    const repo = makeFullRepo({
      findEmployeeForSalary: vi.fn(async () => ({
        id: 'E_PT', base_salary: 0, attendance_bonus: 2000,
        employment_type: 'part_time',
      })),
      findEmployeeHourlyRate: vi.fn(async () => 200),
      findTotalWorkHoursByEmployeeMonth: vi.fn(async () => 80),
      findEmployeeInsuranceSettings: vi.fn(async () => null),
    });
    await calculateMonthlySalary(repo, { employee_id:'E_PT', year:2026, month:5 });
    // 不該打到 applyAttendanceBonus 內用的兩個 mock(part_time 分支跳過整個 step 5)
    expect(repo.findApprovedAttendanceBonusLeaves).not.toHaveBeenCalled();
    expect(repo.findPenaltyRecordsByEmployeeMonth).not.toHaveBeenCalled();
  });

  it('full_time 對照(回歸驗證):grade=3000 / mgr=2000 / attendance_bonus=2000 全進 gross', async () => {
    // 對比同 fixture 但 full_time、確認正職行為完全沒被改、加給該入帳就入帳
    const repo = makeFullRepo({
      findEmployeeForSalary: vi.fn(async () => ({
        id: 'E_FT', base_salary: 30000,
        attendance_bonus: 2000, grade_allowance: 3000, manager_allowance: 2000,
        employment_type: 'full_time',
      })),
      findEmployeeInsuranceSettings: vi.fn(async () => null),
    });
    await calculateMonthlySalary(repo, { employee_id:'E_FT', year:2026, month:5 });
    const row = repo.upsertSalaryRecord.mock.calls.at(-1)[0];
    expect(row.base_salary).toBe(30000);
    expect(row.grade_allowance).toBe(3000);    // 正職:殘留值入帳 ✓
    expect(row.manager_allowance).toBe(2000);
    expect(row.attendance_bonus_actual).toBe(2000);
    expect(row.prorata_base).toBeNull();        // 正職非離職月:null、GENERATED COALESCE 走 base
  });
});

// ─── 2026-06-04:離職月自動推導(修補 HR 直接標離職 silent-fail)──
describe('calculateMonthlySalary — 離職月自動推導(existing 旗標未設時)', () => {
  it('resigned 員工 + resign_date=5/10 + existing 無 is_final_month → 自動推導 isFinalMonth=true、10/31 prorata', async () => {
    const repo = makeFullRepo({
      findEmployeeForSalary: vi.fn(async () => ({
        id: 'E_LATE',
        base_salary: 31000,
        attendance_bonus: 0,
        grade_allowance: 3000,
        manager_allowance: 1000,
        employment_type: 'full_time',
        status: 'resigned',
        resign_date: '2026-05-10',
        resigned_at: '2026-05-10T00:00:00+08:00',
      })),
      findSalaryRecord: vi.fn(async () => null),  // existing 沒 is_final_month
      findEmployeeInsuranceSettings: vi.fn(async () => ({
        has_insurance: true,
        labor_ins_bracket: 31000,  labor_ins_employee: 690,  labor_ins_company: 2100,
        health_ins_bracket: 31000, health_ins_employee: 465, health_ins_company: 1050,
        pension_wage: 31000,
      })),
    });
    const { record } = await calculateMonthlySalary(repo, {
      employee_id: 'E_LATE', year: 2026, month: 5,
    });

    // 推導出的旗標寫回 DB(下游 cascade 會讀)
    expect(record.is_final_month).toBe(true);
    expect(record.worked_days).toBe(10);
    expect(record.total_days_in_month).toBe(31);
    expect(record.pro_rata_mode).toBe('calendar_day');

    // ratio = 10/31 套用到 prorata_base + 經常性加給 + 勞健保 + 雇主成本
    expect(record.prorata_base).toBe(10000);         // round2(31000 × 10/31) = 10000
    expect(record.grade_allowance).toBe(967.74);     // round2(3000 × 10/31)
    expect(record.manager_allowance).toBe(322.58);   // round2(1000 × 10/31)
    expect(record.deduct_labor_ins).toBe(Math.round(690 * 10 / 31));   // 223
    expect(record.deduct_health_ins).toBe(Math.round(465 * 10 / 31));  // 150
    expect(record.employer_cost_labor).toBe(Math.round(2100 * 10 / 31)); // 677
  });

  it('回歸:active 員工(status=active、resigned_at=null)→ proRataRatio=1、prorata_base=null', async () => {
    const repo = makeFullRepo({
      findEmployeeForSalary: vi.fn(async () => ({
        id: 'E_ACT', base_salary: 31000,
        grade_allowance: 3000, manager_allowance: 1000,
        employment_type: 'full_time',
        status: 'active',
        resigned_at: null, resign_date: null,
      })),
      findEmployeeInsuranceSettings: vi.fn(async () => ({
        has_insurance: true,
        labor_ins_bracket: 31000,  labor_ins_employee: 690,  labor_ins_company: 2100,
        health_ins_bracket: 31000, health_ins_employee: 465, health_ins_company: 1050,
        pension_wage: 31000,
      })),
    });
    const { record } = await calculateMonthlySalary(repo, {
      employee_id: 'E_ACT', year: 2026, month: 5,
    });

    expect(record.is_final_month).toBe(false);
    expect(record.prorata_base).toBeNull();
    expect(record.worked_days).toBeNull();
    expect(record.total_days_in_month).toBeNull();
    expect(record.pro_rata_mode).toBeNull();
    // ratio=1 → 全額不縮水
    expect(record.grade_allowance).toBe(3000);
    expect(record.manager_allowance).toBe(1000);
    expect(record.deduct_labor_ins).toBe(690);
    expect(record.deduct_health_ins).toBe(465);
  });

  it('既有值優先:existing.is_final_month=true + worked_days=11(HR 手動)→ 不被推導覆寫', async () => {
    const repo = makeFullRepo({
      findEmployeeForSalary: vi.fn(async () => ({
        id: 'E_HR', base_salary: 31000,
        grade_allowance: 3000,
        employment_type: 'full_time',
        status: 'resigned',
        resign_date: '2026-05-25',  // HR 改 cascade 後員工又延一週、實際離 5/25 但 HR 想保留 5/11 結算
      })),
      // existing 已有 HR 手動填的 worked_days=11(刻意跟 resign_date 不一致)
      findSalaryRecord: vi.fn(async () => ({
        id: 'S_E_HR_2026_05',
        is_final_month: true,
        worked_days: 11,
        total_days_in_month: 31,
        pro_rata_mode: 'calendar_day',
        status: 'draft',
      })),
      findEmployeeInsuranceSettings: vi.fn(async () => null),
    });
    const { record } = await calculateMonthlySalary(repo, {
      employee_id: 'E_HR', year: 2026, month: 5,
    });

    // 用 11 不是 25(existing 優先)
    expect(record.is_final_month).toBe(true);
    expect(record.worked_days).toBe(11);
    expect(record.total_days_in_month).toBe(31);
    expect(record.prorata_base).toBe(11000);     // round2(31000 × 11/31)
    expect(record.grade_allowance).toBe(1064.52); // round2(3000 × 11/31)
  });

  it('resign_date 不同月(4/28)+ 算 5 月 → resolveFinalMonthDays 回 null、不誤判離職月', async () => {
    const repo = makeFullRepo({
      findEmployeeForSalary: vi.fn(async () => ({
        id: 'E_PRE', base_salary: 31000,
        grade_allowance: 3000,
        employment_type: 'full_time',
        status: 'resigned',
        resign_date: '2026-04-28',  // 4 月已離、不該影響 5 月
        resigned_at: '2026-04-28T00:00:00+08:00',
      })),
      findSalaryRecord: vi.fn(async () => null),
      findEmployeeInsuranceSettings: vi.fn(async () => null),
    });
    const { record } = await calculateMonthlySalary(repo, {
      employee_id: 'E_PRE', year: 2026, month: 5,
    });

    // 不是該月離職 → 走非離職月分支
    expect(record.is_final_month).toBe(false);
    expect(record.prorata_base).toBeNull();
    // 加給全額(該員工已離但若被列為 5 月薪資對象、那是 listEmployeesForPayroll 的責任)
    expect(record.grade_allowance).toBe(3000);
  });

  it('part_time resigned 5/10 → proRataRatio 維持 1(part_time 不被新邏輯影響)', async () => {
    const repo = makeFullRepo({
      findEmployeeForSalary: vi.fn(async () => ({
        id: 'E_PT_RES', base_salary: 0,
        grade_allowance: 1000, manager_allowance: 500, attendance_bonus: 2000,
        employment_type: 'part_time',
        status: 'resigned',
        resign_date: '2026-05-10',
      })),
      findEmployeeHourlyRate: vi.fn(async () => 200),
      findTotalWorkHoursByEmployeeMonth: vi.fn(async () => 80),
      findSalaryRecord: vi.fn(async () => null),
      findEmployeeInsuranceSettings: vi.fn(async () => null),
    });
    const { record } = await calculateMonthlySalary(repo, {
      employee_id: 'E_PT_RES', year: 2026, month: 5,
    });

    // part_time:不分離職與否,allowance / AB 一律 0、ratio 強制 1
    expect(record.grade_allowance).toBe(0);
    expect(record.manager_allowance).toBe(0);
    expect(record.attendance_bonus_actual).toBe(0);
    // is_final_month 仍會被推導出為 true、worked_days/total 也寫回(下游 cascade 仍要讀)
    expect(record.is_final_month).toBe(true);
    expect(record.worked_days).toBe(10);
    // prorata_base 走 part_time pt_basePay = 200 × 80 = 16000(不是 base × ratio)
    expect(record.prorata_base).toBe(16000);
  });
});

