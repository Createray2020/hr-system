import { describe, it, expect } from 'vitest';
import {
  calculateSupplementaryHealthInsurance,
  calculateFromSalaryRecord,
  TW_2026_SUPPLEMENTARY_HEALTH_RATE,
} from '../lib/salary/supplementary-health.js';

const RATE = TW_2026_SUPPLEMENTARY_HEALTH_RATE;

describe('calculateSupplementaryHealthInsurance', () => {
  it('缺 rate → throw', () => {
    expect(() => calculateSupplementaryHealthInsurance({
      monthlyBonus: 100000, insuredSalary: 50000,
    })).toThrow();
  });

  it('沒獎金 → 0', () => {
    expect(calculateSupplementaryHealthInsurance({
      monthlyBonus: 0, insuredSalary: 50000, rate: RATE,
    })).toBe(0);
    expect(calculateSupplementaryHealthInsurance({
      monthlyBonus: null, insuredSalary: 50000, rate: RATE,
    })).toBe(0);
    expect(calculateSupplementaryHealthInsurance({
      monthlyBonus: -100, insuredSalary: 50000, rate: RATE,
    })).toBe(0);
  });

  it('沒投保金額 → 0', () => {
    expect(calculateSupplementaryHealthInsurance({
      monthlyBonus: 100000, insuredSalary: 0, rate: RATE,
    })).toBe(0);
    expect(calculateSupplementaryHealthInsurance({
      monthlyBonus: 100000, insuredSalary: null, rate: RATE,
    })).toBe(0);
  });

  it('累計仍未達 4 倍門檻 → 0', () => {
    // 投保 50000、4 倍 = 200000、累計 0 + 100000 = 100000 < 200000
    expect(calculateSupplementaryHealthInsurance({
      monthlyBonus: 100000,
      ytdAccumulatedBonusBefore: 0,
      insuredSalary: 50000,
      rate: RATE,
    })).toBe(0);
  });

  it('累計剛好等於門檻 → 0', () => {
    // 投保 50000、4 倍 = 200000、累計 100000 + 100000 = 200000、不超過
    expect(calculateSupplementaryHealthInsurance({
      monthlyBonus: 100000,
      ytdAccumulatedBonusBefore: 100000,
      insuredSalary: 50000,
      rate: RATE,
    })).toBe(0);
  });

  it('當月跨越門檻、只扣超過部分', () => {
    // 投保 50000、4 倍 = 200000、累計 150000 + 100000 = 250000、超過 = 50000
    // 50000 * 0.0211 = 1055
    expect(calculateSupplementaryHealthInsurance({
      monthlyBonus: 100000,
      ytdAccumulatedBonusBefore: 150000,
      insuredSalary: 50000,
      rate: RATE,
    })).toBe(1055);
  });

  it('之前已超過門檻 → 整筆當月獎金扣', () => {
    // 投保 50000、4 倍 = 200000、之前 250000 > 門檻、當月 100000 全扣
    // 100000 * 0.0211 = 2110
    expect(calculateSupplementaryHealthInsurance({
      monthlyBonus: 100000,
      ytdAccumulatedBonusBefore: 250000,
      insuredSalary: 50000,
      rate: RATE,
    })).toBe(2110);
  });

  it('課徵金額超過 100 萬 → cap', () => {
    // 投保 50000、4 倍 = 200000、之前已超過、當月 1500000
    // chargeable cap to 1000000、* 0.0211 = 21100
    expect(calculateSupplementaryHealthInsurance({
      monthlyBonus: 1500000,
      ytdAccumulatedBonusBefore: 250000,
      insuredSalary: 50000,
      rate: RATE,
    })).toBe(21100);
  });

  it('自訂 rate=0.0191(舊費率)', () => {
    // 50000 超過 * 0.0191 = 955
    expect(calculateSupplementaryHealthInsurance({
      monthlyBonus: 100000,
      ytdAccumulatedBonusBefore: 150000,
      insuredSalary: 50000,
      rate: 0.0191,
    })).toBe(955);
  });

  it('自訂 thresholdMultiplier=2', () => {
    // 投保 50000、2 倍 = 100000、累計 0 + 150000 = 150000、超過 = 50000
    // 50000 * 0.0211 = 1055
    expect(calculateSupplementaryHealthInsurance({
      monthlyBonus: 150000,
      ytdAccumulatedBonusBefore: 0,
      insuredSalary: 50000,
      rate: RATE,
      thresholdMultiplier: 2,
    })).toBe(1055);
  });

  it('自訂 capPerPayment=500000', () => {
    // chargeable 原本 1500000 cap to 500000、* 0.0211 = 10550
    expect(calculateSupplementaryHealthInsurance({
      monthlyBonus: 1500000,
      ytdAccumulatedBonusBefore: 250000,
      insuredSalary: 50000,
      rate: RATE,
      capPerPayment: 500000,
    })).toBe(10550);
  });

  it('Math.round 整數', () => {
    // 50001 * 0.0211 = 1055.0211 → 1055
    expect(calculateSupplementaryHealthInsurance({
      monthlyBonus: 50001,
      ytdAccumulatedBonusBefore: 200000,
      insuredSalary: 50000,
      rate: RATE,
    })).toBe(1055);
    // 50024 * 0.0211 = 1055.5064 → 1056
    expect(calculateSupplementaryHealthInsurance({
      monthlyBonus: 50024,
      ytdAccumulatedBonusBefore: 200000,
      insuredSalary: 50000,
      rate: RATE,
    })).toBe(1056);
  });
});

describe('calculateFromSalaryRecord', () => {
  it('加總 4 種獎金、跨門檻計算', () => {
    // 投保 50000、4 倍 = 200000
    // 4 獎金 = 50000+30000+20000+0 = 100000
    // 累計 150000 + 100000 = 250000、超過 50000
    // 50000 * 0.0211 = 1055
    expect(calculateFromSalaryRecord({
      bonus_yearend: 50000,
      bonus_festival: 30000,
      bonus_performance: 20000,
      bonus_other: 0,
      ytdAccumulatedBonusBefore: 150000,
      insuredSalary: 50000,
      rate: RATE,
    })).toBe(1055);
  });

  it('全 0 → 0', () => {
    expect(calculateFromSalaryRecord({
      insuredSalary: 50000, rate: RATE,
    })).toBe(0);
  });

  it('部分 null 也 OK', () => {
    expect(calculateFromSalaryRecord({
      bonus_yearend: 100000,
      bonus_festival: null,
      bonus_performance: undefined,
      bonus_other: 0,
      ytdAccumulatedBonusBefore: 150000,
      insuredSalary: 50000,
      rate: RATE,
    })).toBe(1055);
  });
});

describe('TW_2026_SUPPLEMENTARY_HEALTH_RATE', () => {
  it('= 0.0211', () => {
    expect(TW_2026_SUPPLEMENTARY_HEALTH_RATE).toBe(0.0211);
  });
});
