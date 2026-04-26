import { describe, it, expect } from 'vitest';
import { calculateLegalDays, calculatePeriodBoundary } from '../lib/leave/annual.js';

describe('calculateLegalDays — 勞基法 §38', () => {
  it('< 0.5 年 → 0', () => {
    expect(calculateLegalDays(0)).toBe(0);
    expect(calculateLegalDays(0.49)).toBe(0);
  });
  it('0.5 ~ 1 年 → 3', () => {
    expect(calculateLegalDays(0.5)).toBe(3);
    expect(calculateLegalDays(0.99)).toBe(3);
  });
  it('1 ~ 2 年 → 7', () => {
    expect(calculateLegalDays(1)).toBe(7);
    expect(calculateLegalDays(1.99)).toBe(7);
  });
  it('2 ~ 3 年 → 10', () => {
    expect(calculateLegalDays(2)).toBe(10);
  });
  it('3 ~ 5 年 → 14', () => {
    expect(calculateLegalDays(3)).toBe(14);
    expect(calculateLegalDays(4.99)).toBe(14);
  });
  it('5 ~ 10 年 → 15', () => {
    expect(calculateLegalDays(5)).toBe(15);
    expect(calculateLegalDays(9.99)).toBe(15);
  });
  it('10 年 → 16', () => { expect(calculateLegalDays(10)).toBe(16); });
  it('11 年 → 17', () => { expect(calculateLegalDays(11)).toBe(17); });
  it('24 年 → 30', () => { expect(calculateLegalDays(24)).toBe(30); });
  it('25 年以上 → 上限 30', () => {
    expect(calculateLegalDays(25)).toBe(30);
    expect(calculateLegalDays(40)).toBe(30);
  });
  it('負值 / NaN → 0', () => {
    expect(calculateLegalDays(-1)).toBe(0);
    expect(calculateLegalDays(NaN)).toBe(0);
    expect(calculateLegalDays('abc')).toBe(0);
  });
});

describe('calculatePeriodBoundary — 週年制', () => {
  it('today 已過今年週年日 → period 是今年週年日 ~ 明年-1', () => {
    const r = calculatePeriodBoundary('2020-03-15', '2026-04-26');
    expect(r.period_start).toBe('2026-03-15');
    expect(r.period_end).toBe('2027-03-14');
    expect(r.seniority_years).toBe(6);
  });

  it('today 還沒到今年週年日 → period 是去年週年日 ~ 今年-1', () => {
    const r = calculatePeriodBoundary('2020-08-01', '2026-04-26');
    expect(r.period_start).toBe('2025-08-01');
    expect(r.period_end).toBe('2026-07-31');
    expect(r.seniority_years).toBe(5);
  });

  it('剛好週年日當天 → period 從今天開始', () => {
    const r = calculatePeriodBoundary('2020-04-26', '2026-04-26');
    expect(r.period_start).toBe('2026-04-26');
    expect(r.period_end).toBe('2027-04-25');
    expect(r.seniority_years).toBe(6);
  });

  it('today 早於 seniority_start → 首期 0 年', () => {
    const r = calculatePeriodBoundary('2027-01-01', '2026-04-26');
    expect(r.period_start).toBe('2027-01-01');
    expect(r.seniority_years).toBe(0);
  });

  it('閏年 2/29:平年沒這天,週期端點推到 2/28 + 一日', () => {
    // 2020/2/29 是閏年;2025-04-26 → 推到 2025-02-29 不存在,JS Date 自動轉 3/1
    const r = calculatePeriodBoundary('2020-02-29', '2025-04-26');
    // 接受 3/1 或 2/28+1day 之類的合理結果(JS 行為:2025-02-29 → 2025-03-01)
    expect(['2025-02-28', '2025-03-01']).toContain(r.period_start);
    expect(r.seniority_years).toBeGreaterThanOrEqual(4);
  });

  it('invalid date 拋錯', () => {
    expect(() => calculatePeriodBoundary('foo', '2026-04-26')).toThrow();
    expect(() => calculatePeriodBoundary('2020-01-01', 'bar')).toThrow();
  });
});
