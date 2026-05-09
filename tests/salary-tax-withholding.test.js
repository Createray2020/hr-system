import { describe, it, expect } from 'vitest';
import {
  calculateTaxByFormula,
  calculateTaxByTable,
  calculateWithholding,
  TW_2024_WITHHOLDING_DEFAULTS,
} from '../lib/salary/tax-withholding.js';

const W = TW_2024_WITHHOLDING_DEFAULTS;

describe('calculateTaxByFormula', () => {
  it('缺法規參數 → throw', () => {
    expect(() => calculateTaxByFormula({ monthlyPayment: 100000 })).toThrow();
    expect(() => calculateTaxByFormula({
      monthlyPayment: 100000,
      taxFreeAllowanceBase: 88500,
    })).toThrow();
  });

  it('月薪 0 / 負數 / null → 0', () => {
    expect(calculateTaxByFormula({ monthlyPayment: 0, ...W })).toBe(0);
    expect(calculateTaxByFormula({ monthlyPayment: -1000, ...W })).toBe(0);
    expect(calculateTaxByFormula({ monthlyPayment: null, ...W })).toBe(0);
  });

  it('月薪 ≤ 本人免稅額 → 0', () => {
    expect(calculateTaxByFormula({ monthlyPayment: 50000, ...W })).toBe(0);
    expect(calculateTaxByFormula({ monthlyPayment: 88500, ...W })).toBe(0);
  });

  it('月薪 100000 / 0 扶養 / 88500/6% → 690', () => {
    // (100000 - 88500) * 0.06 = 690
    expect(calculateTaxByFormula({ monthlyPayment: 100000, ...W })).toBe(690);
  });

  it('月薪 200000 / 1 扶養 → 1380', () => {
    // (200000 - 177000) * 0.06 = 1380
    expect(calculateTaxByFormula({ monthlyPayment: 200000, dependentCount: 1, ...W })).toBe(1380);
  });

  it('扶養人數讓總免稅額 ≥ 月薪 → 0', () => {
    // 100000 - 88500 - 2*88500 = -65500 → 0
    expect(calculateTaxByFormula({ monthlyPayment: 100000, dependentCount: 2, ...W })).toBe(0);
  });

  it('自定 rate=5% / 公式法可調率', () => {
    // (100000 - 88500) * 0.05 = 575
    expect(calculateTaxByFormula({
      monthlyPayment: 100000,
      taxFreeAllowanceBase: 88500,
      taxFreeAllowancePerDep: 88500,
      rate: 0.05,
    })).toBe(575);
  });

  it('自定 base=142500(70 歲本人或扶養親屬加倍免稅額)', () => {
    // (200000 - 142500) * 0.06 = 3450
    expect(calculateTaxByFormula({
      monthlyPayment: 200000,
      taxFreeAllowanceBase: 142500,
      taxFreeAllowancePerDep: 88500,
      rate: 0.06,
    })).toBe(3450);
  });

  it('Math.round 處理小數', () => {
    // 100009 - 88500 = 11509 * 0.06 = 690.54 → round 691
    expect(calculateTaxByFormula({ monthlyPayment: 100009, ...W })).toBe(691);
    // 100008 - 88500 = 11508 * 0.06 = 690.48 → round 690
    expect(calculateTaxByFormula({ monthlyPayment: 100008, ...W })).toBe(690);
  });
});

describe('calculateTaxByTable', () => {
  const SAMPLE_BRACKETS = [
    { min:     0, max: 84500, dependent_0:    0, dependent_1:    0, dependent_2:    0 },
    { min: 84501, max: 87500, dependent_0:   80, dependent_1:    0, dependent_2:    0 },
    { min: 87501, max: 90500, dependent_0:  170, dependent_1:    0, dependent_2:    0 },
    { min: 90501, max: 93500, dependent_0:  260, dependent_1:    0, dependent_2:    0 },
    { min:200001, max:300000, dependent_0: 8500, dependent_1: 4500, dependent_2: 1000 },
  ];

  it('落在某級 / 0 扶養', () => {
    expect(calculateTaxByTable({
      monthlyPayment: 90000, dependentCount: 0, brackets: SAMPLE_BRACKETS,
    })).toBe(170);
  });

  it('落在高級 / 1 扶養', () => {
    expect(calculateTaxByTable({
      monthlyPayment: 250000, dependentCount: 1, brackets: SAMPLE_BRACKETS,
    })).toBe(4500);
  });

  it('沒給 brackets → -1', () => {
    expect(calculateTaxByTable({ monthlyPayment: 90000 })).toBe(-1);
  });

  it('空 brackets → -1', () => {
    expect(calculateTaxByTable({ monthlyPayment: 90000, brackets: [] })).toBe(-1);
  });

  it('超出級距範圍 → -1', () => {
    expect(calculateTaxByTable({
      monthlyPayment: 9999999, dependentCount: 0, brackets: SAMPLE_BRACKETS,
    })).toBe(-1);
  });

  it('扶養人數超過表(查 dependent_5 不存在)→ -1', () => {
    expect(calculateTaxByTable({
      monthlyPayment: 250000, dependentCount: 99, brackets: SAMPLE_BRACKETS,
    })).toBe(-1);
  });

  it('0 / 負數薪資 → 0(不查表)', () => {
    expect(calculateTaxByTable({ monthlyPayment: 0, brackets: SAMPLE_BRACKETS })).toBe(0);
    expect(calculateTaxByTable({ monthlyPayment: -100, brackets: SAMPLE_BRACKETS })).toBe(0);
  });

  it('邊界:剛好 min 命中該級', () => {
    expect(calculateTaxByTable({
      monthlyPayment: 87501, dependentCount: 0, brackets: SAMPLE_BRACKETS,
    })).toBe(170);
  });

  it('邊界:剛好 max 命中該級', () => {
    expect(calculateTaxByTable({
      monthlyPayment: 87500, dependentCount: 0, brackets: SAMPLE_BRACKETS,
    })).toBe(80);
  });
});

describe('calculateWithholding', () => {
  const SAMPLE_BRACKETS = [
    { min: 50000, max: 100000, dependent_0: 500 },
  ];

  it('method=formula → 公式法', () => {
    expect(calculateWithholding({
      monthlyPayment: 100000, method: 'formula', formulaParams: W,
    })).toBe(690);
  });

  it('method=table + brackets 命中 → 表法', () => {
    expect(calculateWithholding({
      monthlyPayment: 80000, method: 'table', brackets: SAMPLE_BRACKETS, formulaParams: W,
    })).toBe(500);
  });

  it('method=table + brackets 查不到 → fallback 公式法', () => {
    expect(calculateWithholding({
      monthlyPayment: 200000, method: 'table', brackets: SAMPLE_BRACKETS, formulaParams: W,
    })).toBe(Math.round((200000 - 88500) * 0.06));  // 6690
  });

  it('method=table + 沒 brackets → fallback 公式法', () => {
    expect(calculateWithholding({
      monthlyPayment: 100000, method: 'table', formulaParams: W,
    })).toBe(690);
  });

  it('預設 method=formula', () => {
    expect(calculateWithholding({
      monthlyPayment: 100000, formulaParams: W,
    })).toBe(690);
  });
});

describe('TW_2024_WITHHOLDING_DEFAULTS', () => {
  it('凍結、不可改', () => {
    expect(Object.isFrozen(W)).toBe(true);
  });

  it('包含 3 個 key', () => {
    expect(W).toHaveProperty('taxFreeAllowanceBase', 88500);
    expect(W).toHaveProperty('taxFreeAllowancePerDep', 88500);
    expect(W).toHaveProperty('rate', 0.06);
  });
});
