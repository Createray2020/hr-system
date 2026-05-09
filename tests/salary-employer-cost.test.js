import { describe, it, expect } from 'vitest';
import { calculateEmployerCost } from '../lib/salary/employer-cost.js';

describe('calculateEmployerCost', () => {
  it('空 input → 全 0 + total 0', () => {
    expect(calculateEmployerCost({})).toEqual({
      employer_cost_labor: 0,
      employer_cost_health: 0,
      employer_cost_pension: 0,
      employer_cost_occupational: 0,
      employer_cost_employment: 0,
      employer_cost_welfare: 0,
      total: 0,
    });
  });

  it('完全沒參數也 OK(default {})', () => {
    expect(calculateEmployerCost().total).toBe(0);
  });

  it('用 direct premium(prod 路徑)', () => {
    const r = calculateEmployerCost({
      laborCompanyPremium: 3460,
      healthCompanyPremium: 1640,
      pensionWage: 45800,
      insuredSalaryLabor: 45800,
      occupationalRate: 0.0021,
      employmentRate: 0.007,
    });
    expect(r.employer_cost_labor).toBe(3460);
    expect(r.employer_cost_health).toBe(1640);
    expect(r.employer_cost_pension).toBe(2748);       // 45800 × 0.06
    expect(r.employer_cost_occupational).toBe(96);    // 45800 × 0.0021 = 96.18 → 96
    expect(r.employer_cost_employment).toBe(321);     // 45800 × 0.007 = 320.6 → 321
    expect(r.employer_cost_welfare).toBe(0);
    expect(r.total).toBe(3460 + 1640 + 2748 + 96 + 321 + 0);
  });

  it('用率 fallback(沒 brackets)', () => {
    const r = calculateEmployerCost({
      insuredSalaryLabor: 45800,
      insuredSalaryHealth: 45800,
      pensionWage: 45800,
      laborRate: 0.0762,
      healthRate: 0.0517,
    });
    expect(r.employer_cost_labor).toBe(Math.round(45800 * 0.0762));   // 3490
    expect(r.employer_cost_health).toBe(Math.round(45800 * 0.0517));  // 2368
    expect(r.employer_cost_pension).toBe(2748);                       // 45800 × 0.06
  });

  it('priority: direct premium > rate', () => {
    // 同時給 laborCompanyPremium 跟 laborRate、優先用 premium
    const r = calculateEmployerCost({
      laborCompanyPremium: 1234,
      insuredSalaryLabor: 45800,
      laborRate: 0.0762,
    });
    expect(r.employer_cost_labor).toBe(1234);
  });

  it('null direct premium → fallback rate', () => {
    const r = calculateEmployerCost({
      laborCompanyPremium: null,
      insuredSalaryLabor: 45800,
      laborRate: 0.0762,
    });
    expect(r.employer_cost_labor).toBe(Math.round(45800 * 0.0762));   // 3490
  });

  it('離職員工 → pension/labor/health 全 0', () => {
    expect(calculateEmployerCost({
      laborCompanyPremium: 0,
      healthCompanyPremium: 0,
      pensionWage: 0,
    })).toEqual({
      employer_cost_labor: 0,
      employer_cost_health: 0,
      employer_cost_pension: 0,
      employer_cost_occupational: 0,
      employer_cost_employment: 0,
      employer_cost_welfare: 0,
      total: 0,
    });
  });

  it('離職員工 pensionMandatoryRate=0', () => {
    expect(calculateEmployerCost({
      pensionWage: 50000,
      pensionMandatoryRate: 0,
    }).employer_cost_pension).toBe(0);
  });

  it('insuredSalaryHealth 跟 Labor 不同(含眷屬調整)', () => {
    const r = calculateEmployerCost({
      insuredSalaryLabor: 33300,
      insuredSalaryHealth: 50000,   // 含眷屬後
      laborRate: 0.0762,
      healthRate: 0.0517,
    });
    expect(r.employer_cost_labor).toBe(Math.round(33300 * 0.0762));   // 2538
    expect(r.employer_cost_health).toBe(Math.round(50000 * 0.0517));  // 2585
  });

  it('福利金率 0.05%(50 人以下事業 = 0、本 lib 仍支援)', () => {
    expect(calculateEmployerCost({
      insuredSalaryLabor: 45800,
      welfareRate: 0.0005,
    }).employer_cost_welfare).toBe(Math.round(45800 * 0.0005));   // 23
  });

  it('total = 6 項加總(精確)', () => {
    const r = calculateEmployerCost({
      laborCompanyPremium: 1000,
      healthCompanyPremium: 500,
      pensionWage: 50000,
      insuredSalaryLabor: 50000,
      occupationalRate: 0.001,
      employmentRate: 0.007,
      welfareRate: 0.001,
    });
    expect(r.total).toBe(
      r.employer_cost_labor +
      r.employer_cost_health +
      r.employer_cost_pension +
      r.employer_cost_occupational +
      r.employer_cost_employment +
      r.employer_cost_welfare
    );
    // 1000 + 500 + 3000 + 50 + 350 + 50 = 4950
    expect(r.total).toBe(4950);
  });

  it('Math.round 整數(避免小數累積)', () => {
    // 33333 × 0.0021 = 69.9993 → 70
    const r = calculateEmployerCost({
      insuredSalaryLabor: 33333,
      occupationalRate: 0.0021,
    });
    expect(r.employer_cost_occupational).toBe(70);
  });

  it('預設 pensionMandatoryRate=0.06', () => {
    expect(calculateEmployerCost({ pensionWage: 50000 }).employer_cost_pension)
      .toBe(3000);
  });
});
