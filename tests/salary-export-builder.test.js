// tests/salary-export-builder.test.js
//
// 抓 public/js/salary-export/builder.js 的純函式行為:
//   - MONTHLY_EXPORT_COLUMNS 結構(身分 / 應發 / 應發合計 / 扣除 / 實發 / 雇主負擔 / 狀態)
//   - 表頭欄數 === MONTHLY_EXPORT_COLUMNS 長度
//   - 數值欄是 number、不是字串(讓 Excel 可加總)
//   - 合計列 = 各 sum 欄加總
//   - 應發/扣除欄與 salary-breakdown buildSalaryBreakdown 同源(SSOT 比對)
//   - 空 records → 只有表頭一列
//   - filename 含年-月
//
// 對齊 tests/salary-summary-builder.test.js + tests/salary-breakdown.test.js 慣例。

import { describe, it, expect, beforeAll } from 'vitest';

let MONTHLY_EXPORT_COLUMNS, buildMonthlyPayrollAOA, SB;

beforeAll(async () => {
  await import('../public/js/salary-breakdown.js');
  SB = globalThis.SalaryBreakdown;
  const mod = await import('../public/js/salary-export/builder.js');
  MONTHLY_EXPORT_COLUMNS = mod.MONTHLY_EXPORT_COLUMNS;
  buildMonthlyPayrollAOA = mod.buildMonthlyPayrollAOA;
});

// ─── Fixtures ───────────────────────────────────────────────
function makeRecord(overrides = {}) {
  return {
    id: 'S_EMP_01_2026_05',
    employee_id: 'EMP_01',
    emp_name: '張三',
    dept_name: 'IT',
    year: 2026, month: 5,
    status: 'paid',
    // 應發
    base_salary: 30000, prorata_base: null,
    attendance_bonus_actual: 2000,
    grade_allowance: 3000, manager_allowance: 0,
    allowance: 0, extra_allowance: 1000, night_allowance: 0,
    overtime_pay_auto: 500, overtime_pay_manual: 0,
    holiday_work_pay: 0, comp_expiry_payout: 0, settlement_amount: 0,
    bonus_yearend: 0, bonus_festival: 0, bonus_performance: 0, bonus_other: 0,
    expense_reimbursement_total: 0,
    // 扣除
    deduct_absence: 0,
    deduct_labor_ins: 600, deduct_health_ins: 400,
    deduct_supplementary_health: 0, deduct_pension_voluntary: 0,
    deduct_tax: 0,
    attendance_penalty_total: 0,
    deduct_welfare_fund: 0, deduct_union_fee: 0, deduct_court_garnishment: 0,
    deduct_loan_repayment: 0, deduct_other: 0,
    // 雇主負擔
    employer_cost_labor: 1400, employer_cost_health: 1200,
    employer_cost_pension: 2100, employer_cost_occupational: 100,
    employer_cost_employment: 200, employer_cost_welfare: 50,
    // GENERATED (test 假裝 DB 已算好)
    gross_salary: 30000 + 2000 + 3000 + 1000 + 500,    // 36500
    net_salary:   36500 - 600 - 400,                     // 35500
    ...overrides,
  };
}

const r1 = makeRecord({ employee_id: 'EMP_02', emp_name: '李四', dept_name: 'HR' });
const r2 = makeRecord({
  employee_id: 'EMP_01',
  base_salary: 50000,
  attendance_bonus_actual: 2000,
  grade_allowance: 0, manager_allowance: 0,
  extra_allowance: 0,
  overtime_pay_auto: 0,
  deduct_labor_ins: 1100, deduct_health_ins: 700, deduct_tax: 800,
  gross_salary: 52000,
  net_salary: 49400,
  employer_cost_labor: 2200, employer_cost_health: 1800,
  employer_cost_pension: 3000, employer_cost_occupational: 150,
  employer_cost_employment: 300, employer_cost_welfare: 80,
});

// ─── MONTHLY_EXPORT_COLUMNS 結構 ─────────────────────────────
describe('MONTHLY_EXPORT_COLUMNS', () => {
  it('frozen + 長度 = 身分(3) + 應發 + 應發合計(1) + 扣除 + 實發(1) + 雇主(6) + 狀態(1)', () => {
    expect(Object.isFrozen(MONTHLY_EXPORT_COLUMNS)).toBe(true);
    const expected = 3 + SB.GROSS_FIELDS.length + 1 + SB.DEDUCT_FIELDS.length + 1 + 6 + 1;
    expect(MONTHLY_EXPORT_COLUMNS).toHaveLength(expected);
  });

  it('前 3 欄是身分欄(員工編號 / 姓名 / 部門)', () => {
    expect(MONTHLY_EXPORT_COLUMNS[0]).toMatchObject({ key: 'employee_id', label: '員工編號', type: 'identity' });
    expect(MONTHLY_EXPORT_COLUMNS[1]).toMatchObject({ key: 'emp_name',    label: '姓名',     type: 'identity' });
    expect(MONTHLY_EXPORT_COLUMNS[2]).toMatchObject({ key: 'dept_name',   label: '部門',     type: 'identity' });
  });

  it('應發欄 label 全對齊 salary-breakdown GROSS_FIELDS', () => {
    const grossCols = MONTHLY_EXPORT_COLUMNS.slice(3, 3 + SB.GROSS_FIELDS.length);
    expect(grossCols.map(c => c.label)).toEqual(SB.GROSS_FIELDS.map(f => f.label));
  });

  it('應發合計欄 + 實發欄存在', () => {
    const totalCol = MONTHLY_EXPORT_COLUMNS.find(c => c.key === 'gross_salary');
    const netCol   = MONTHLY_EXPORT_COLUMNS.find(c => c.key === 'net_salary');
    expect(totalCol).toMatchObject({ label: '應發合計', sum: true });
    expect(netCol).toMatchObject({ label: '實發', sum: true });
  });

  it('扣除欄 label 全對齊 salary-breakdown DEDUCT_FIELDS', () => {
    const deductCols = MONTHLY_EXPORT_COLUMNS.filter(c => c.key.startsWith('deduct:'));
    expect(deductCols.map(c => c.label)).toEqual(SB.DEDUCT_FIELDS.map(f => f.label));
  });

  it('雇主負擔 6 欄', () => {
    const empCols = MONTHLY_EXPORT_COLUMNS.filter(c => c.key.startsWith('employer_cost_'));
    expect(empCols).toHaveLength(6);
    expect(empCols[0].label).toMatch(/雇主負擔/);
  });

  it('最後一欄是狀態(identity、非 sum)', () => {
    const last = MONTHLY_EXPORT_COLUMNS[MONTHLY_EXPORT_COLUMNS.length - 1];
    expect(last.key).toBe('status');
    expect(last.type).toBe('identity');
  });

  it('amount 型欄皆 sum=true、identity 型皆無 sum', () => {
    for (const c of MONTHLY_EXPORT_COLUMNS) {
      if (c.type === 'amount')   expect(c.sum).toBe(true);
      if (c.type === 'identity') expect(c.sum).not.toBe(true);
    }
  });
});

// ─── buildMonthlyPayrollAOA ─────────────────────────────────
describe('buildMonthlyPayrollAOA — 結構', () => {
  it('表頭欄數 === MONTHLY_EXPORT_COLUMNS 長度', () => {
    const { aoa } = buildMonthlyPayrollAOA([r2, r1], { year: 2026, month: 5 });
    expect(aoa[0]).toHaveLength(MONTHLY_EXPORT_COLUMNS.length);
    expect(aoa[0]).toEqual(MONTHLY_EXPORT_COLUMNS.map(c => c.label));
  });

  it('2 筆 record → 表頭 + 2 員工 + 合計 = 4 列', () => {
    const { aoa, rows } = buildMonthlyPayrollAOA([r2, r1], { year: 2026, month: 5 });
    expect(rows).toHaveLength(2);
    expect(aoa).toHaveLength(4);
  });

  it('依 employee_id 升序(EMP_01 在 EMP_02 前)', () => {
    const { aoa } = buildMonthlyPayrollAOA([r1, r2], { year: 2026, month: 5 });
    expect(aoa[1][0]).toBe('EMP_01');
    expect(aoa[2][0]).toBe('EMP_02');
  });

  it('filename 含 年-月', () => {
    const { filename } = buildMonthlyPayrollAOA([r2], { year: 2026, month: 5 });
    expect(filename).toBe('薪資清冊_2026-05.xlsx');
  });

  it('空 records → 只有表頭一列', () => {
    const { aoa, rows } = buildMonthlyPayrollAOA([], { year: 2026, month: 5 });
    expect(rows).toHaveLength(0);
    expect(aoa).toHaveLength(1);
    expect(aoa[0]).toEqual(MONTHLY_EXPORT_COLUMNS.map(c => c.label));
  });

  it('null records → 只有表頭一列、不 throw', () => {
    expect(() => buildMonthlyPayrollAOA(null, { year: 2026, month: 5 })).not.toThrow();
    const { aoa } = buildMonthlyPayrollAOA(null, { year: 2026, month: 5 });
    expect(aoa).toHaveLength(1);
  });
});

// ─── 數值精準度 + Excel 可加總(number 型) ──────────────────
describe('buildMonthlyPayrollAOA — 數值', () => {
  it('身分欄是字串、金額欄是 number(讓 Excel 可加總)', () => {
    const { aoa } = buildMonthlyPayrollAOA([r2], { year: 2026, month: 5 });
    const row = aoa[1];
    expect(typeof row[0]).toBe('string');   // employee_id
    expect(typeof row[1]).toBe('string');   // emp_name
    expect(typeof row[2]).toBe('string');   // dept_name
    // 第 4 欄起、扣除 net 都該是 number
    for (let i = 3; i < row.length - 1; i++) {
      expect(typeof row[i]).toBe('number');
    }
  });

  it('某數值欄精準對值(EMP_01:base 50000、勞保自付 1100、gross 52000、net 49400)', () => {
    const { aoa } = buildMonthlyPayrollAOA([r2], { year: 2026, month: 5 });
    const row = aoa[1];
    const findCol = (key) => MONTHLY_EXPORT_COLUMNS.findIndex(c => c.key === key);
    expect(row[findCol('gross:__base__')]).toBe(50000);
    expect(row[findCol('deduct:deduct_labor_ins')]).toBe(1100);
    expect(row[findCol('gross_salary')]).toBe(52000);
    expect(row[findCol('net_salary')]).toBe(49400);
  });

  it('prorata_base 非 null → 本薪欄取 prorata_base、不取 base_salary', () => {
    const prorataR = makeRecord({ employee_id: 'EMP_03', emp_name: '王五', base_salary: 30000, prorata_base: 15000 });
    const { aoa } = buildMonthlyPayrollAOA([prorataR], { year: 2026, month: 5 });
    const findCol = (key) => MONTHLY_EXPORT_COLUMNS.findIndex(c => c.key === key);
    expect(aoa[1][findCol('gross:__base__')]).toBe(15000);
  });

  it('合計列:第 1 欄「合計 (N 人)」、sum 欄加總、其他空字串', () => {
    const { aoa } = buildMonthlyPayrollAOA([r2, r1], { year: 2026, month: 5 });
    const total = aoa[3];
    expect(total[0]).toBe('合計 (2 人)');
    expect(total[1]).toBe('');   // 姓名
    expect(total[2]).toBe('');   // 部門

    const findCol = (key) => MONTHLY_EXPORT_COLUMNS.findIndex(c => c.key === key);
    expect(total[findCol('gross_salary')]).toBe(52000 + 36500);
    expect(total[findCol('net_salary')]).toBe(49400 + 35500);
    expect(total[findCol('deduct:deduct_labor_ins')]).toBe(1100 + 600);
    expect(total[findCol('employer_cost_labor')]).toBe(2200 + 1400);

    // 狀態欄(identity)→ 空字串
    expect(total[total.length - 1]).toBe('');
  });
});

// ─── SSOT 對齊 salary-breakdown ─────────────────────────────
describe('buildMonthlyPayrollAOA — 與 salary-breakdown SSOT 一致', () => {
  it('應發欄取值 sum == buildSalaryBreakdown(record).grossSubtotal', () => {
    const { aoa } = buildMonthlyPayrollAOA([r2], { year: 2026, month: 5 });
    const row = aoa[1];
    let exportGrossSum = 0;
    for (let i = 0; i < MONTHLY_EXPORT_COLUMNS.length; i++) {
      const c = MONTHLY_EXPORT_COLUMNS[i];
      if (c.key.startsWith('gross:')) exportGrossSum += Number(row[i]) || 0;
    }
    const sb = SB.buildSalaryBreakdown(r2);
    expect(exportGrossSum).toBeCloseTo(sb.grossSubtotal, 2);
  });

  it('扣除欄取值 sum == buildSalaryBreakdown(record).deductSubtotal', () => {
    const { aoa } = buildMonthlyPayrollAOA([r2], { year: 2026, month: 5 });
    const row = aoa[1];
    let exportDeductSum = 0;
    for (let i = 0; i < MONTHLY_EXPORT_COLUMNS.length; i++) {
      const c = MONTHLY_EXPORT_COLUMNS[i];
      if (c.key.startsWith('deduct:')) exportDeductSum += Number(row[i]) || 0;
    }
    const sb = SB.buildSalaryBreakdown(r2);
    expect(exportDeductSum).toBeCloseTo(sb.deductSubtotal, 2);
  });
});
