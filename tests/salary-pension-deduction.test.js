import { describe, it, expect } from 'vitest';
import {
  calculatePension,
  calculateEmployeeVoluntary,
  calculateEmployerMandatory,
  TW_PENSION_EMPLOYER_MANDATORY_RATE,
  TW_PENSION_EMPLOYEE_VOLUNTARY_MAX,
} from '../lib/salary/pension-deduction.js';

describe('calculatePension', () => {
  it('沒投保工資 → 雙 0', () => {
    expect(calculatePension({ pensionWage: 0 }))
      .toEqual({ employeeContribution: 0, employerContribution: 0 });
    expect(calculatePension({ pensionWage: null }))
      .toEqual({ employeeContribution: 0, employerContribution: 0 });
    expect(calculatePension({ pensionWage: -100 }))
      .toEqual({ employeeContribution: 0, employerContribution: 0 });
  });

  it('員工不自願、雇主強制 6%', () => {
    // 50000 * 0.06 = 3000
    expect(calculatePension({ pensionWage: 50000 }))
      .toEqual({ employeeContribution: 0, employerContribution: 3000 });
  });

  it('員工自願 6% + 雇主強制 6%', () => {
    expect(calculatePension({ pensionWage: 50000, employeeRate: 0.06 }))
      .toEqual({ employeeContribution: 3000, employerContribution: 3000 });
  });

  it('員工自願 3%', () => {
    // 50000 * 0.03 = 1500
    expect(calculatePension({ pensionWage: 50000, employeeRate: 0.03 }))
      .toEqual({ employeeContribution: 1500, employerContribution: 3000 });
  });

  it('員工率超過 6% → cap 6%', () => {
    expect(calculatePension({ pensionWage: 50000, employeeRate: 0.10 }))
      .toEqual({ employeeContribution: 3000, employerContribution: 3000 });
  });

  it('員工率負數 → cap 0', () => {
    expect(calculatePension({ pensionWage: 50000, employeeRate: -0.01 }))
      .toEqual({ employeeContribution: 0, employerContribution: 3000 });
  });

  it('Math.round 整數', () => {
    // 33333 * 0.06 = 1999.98 → 2000
    expect(calculatePension({ pensionWage: 33333 }))
      .toEqual({ employeeContribution: 0, employerContribution: 2000 });
    // 33333 * 0.03 = 999.99 → 1000
    expect(calculatePension({ pensionWage: 33333, employeeRate: 0.03 }))
      .toEqual({ employeeContribution: 1000, employerContribution: 2000 });
  });

  it('離職員工 employerRate=0', () => {
    expect(calculatePension({
      pensionWage: 50000, employeeRate: 0.06, employerRate: 0,
    })).toEqual({ employeeContribution: 3000, employerContribution: 0 });
  });

  it('null employeeRate / employerRate → 預設處理', () => {
    expect(calculatePension({
      pensionWage: 50000, employeeRate: null, employerRate: null,
    })).toEqual({ employeeContribution: 0, employerContribution: 0 });
  });
});

describe('calculateEmployeeVoluntary', () => {
  it('回傳員工自願金額', () => {
    expect(calculateEmployeeVoluntary({
      pensionWage: 50000, voluntaryRate: 0.06,
    })).toBe(3000);
  });

  it('率 = 0 → 0', () => {
    expect(calculateEmployeeVoluntary({
      pensionWage: 50000, voluntaryRate: 0,
    })).toBe(0);
  });

  it('預設率 = 0', () => {
    expect(calculateEmployeeVoluntary({ pensionWage: 50000 })).toBe(0);
  });

  it('率 4% / 月薪 45800', () => {
    // 45800 * 0.04 = 1832
    expect(calculateEmployeeVoluntary({
      pensionWage: 45800, voluntaryRate: 0.04,
    })).toBe(1832);
  });
});

describe('calculateEmployerMandatory', () => {
  it('回傳雇主金額(預設 6%)', () => {
    expect(calculateEmployerMandatory({ pensionWage: 50000 })).toBe(3000);
  });

  it('離職員工 mandatoryRate=0 → 0', () => {
    expect(calculateEmployerMandatory({
      pensionWage: 50000, mandatoryRate: 0,
    })).toBe(0);
  });

  it('沒 pensionWage → 0', () => {
    expect(calculateEmployerMandatory({ pensionWage: 0 })).toBe(0);
  });
});

describe('常數', () => {
  it('TW_PENSION_EMPLOYER_MANDATORY_RATE = 0.06', () => {
    expect(TW_PENSION_EMPLOYER_MANDATORY_RATE).toBe(0.06);
  });

  it('TW_PENSION_EMPLOYEE_VOLUNTARY_MAX = 0.06', () => {
    expect(TW_PENSION_EMPLOYEE_VOLUNTARY_MAX).toBe(0.06);
  });
});
