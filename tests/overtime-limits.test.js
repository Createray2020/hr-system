import { describe, it, expect, vi } from 'vitest';
import {
  getEffectiveLimits, checkOverLimit, computeDateRanges, isCrossMonth,
} from '../lib/overtime/limits.js';

function makeRepo(over = {}) {
  return {
    findActiveOvertimeLimits: vi.fn(async () => ({ employee: null, company: null })),
    findOvertimeApprovedHours: vi.fn(async () => ({ daily: 0, weekly: 0, monthly: 0, yearly: 0 })),
    ...over,
  };
}

describe('getEffectiveLimits — 個人優先 fallback 公司', () => {
  it('沒個人 + 沒公司 → 全部 null', async () => {
    const r = await getEffectiveLimits(makeRepo(), 'E001', '2026-04-26');
    expect(r).toEqual({ daily: null, weekly: null, monthly: null, yearly: null, monthly_hard_cap: null });
  });

  it('只有公司 → 用公司值', async () => {
    const repo = makeRepo({
      findActiveOvertimeLimits: vi.fn(async () => ({
        employee: null,
        company:  { daily_limit_hours: 4, monthly_limit_hours: 46, monthly_hard_cap_hours: 54 },
      })),
    });
    const r = await getEffectiveLimits(repo, 'E001', '2026-04-26');
    expect(r.daily).toBe(4);
    expect(r.monthly).toBe(46);
    expect(r.monthly_hard_cap).toBe(54);
    expect(r.weekly).toBe(null);
  });

  it('個人 + 公司 → 個人欄位優先,個人 null 那欄 fallback 公司', async () => {
    const repo = makeRepo({
      findActiveOvertimeLimits: vi.fn(async () => ({
        employee: { daily_limit_hours: 6, monthly_limit_hours: null }, // 個人放寬 daily,monthly 沒設
        company:  { daily_limit_hours: 4, monthly_limit_hours: 46, monthly_hard_cap_hours: 54 },
      })),
    });
    const r = await getEffectiveLimits(repo, 'E001', '2026-04-26');
    expect(r.daily).toBe(6);   // 個人優先
    expect(r.monthly).toBe(46); // 個人 null,fallback 公司
    expect(r.monthly_hard_cap).toBe(54); // 個人沒給 → 公司
  });
});

describe('checkOverLimit — 三流向(規範 §9.2)', () => {
  it('流向 1:沒超 → is_over_limit=false, exceeds_hard_cap=false', async () => {
    const repo = makeRepo({
      findActiveOvertimeLimits: vi.fn(async () => ({
        employee: null,
        company:  { daily_limit_hours: 4, monthly_limit_hours: 46, monthly_hard_cap_hours: 54 },
      })),
      findOvertimeApprovedHours: vi.fn(async () => ({
        daily: 0, weekly: 0, monthly: 10, yearly: 50,
      })),
    });
    const r = await checkOverLimit(repo, {
      employee_id: 'E001', overtime_date: '2026-04-26', hours: 2,
    });
    expect(r.is_over_limit).toBe(false);
    expect(r.over_limit_dimensions).toEqual([]);
    expect(r.exceeds_hard_cap).toBe(false);
    expect(r.projected.monthly).toBe(12);
  });

  it('流向 2:超 monthly limit 但沒超 hard_cap → is_over_limit=true (CEO 流程)', async () => {
    const repo = makeRepo({
      findActiveOvertimeLimits: vi.fn(async () => ({
        employee: null,
        company:  { daily_limit_hours: 4, monthly_limit_hours: 46, monthly_hard_cap_hours: 54 },
      })),
      findOvertimeApprovedHours: vi.fn(async () => ({
        daily: 0, weekly: 0, monthly: 45, yearly: 100,
      })),
    });
    const r = await checkOverLimit(repo, {
      employee_id: 'E001', overtime_date: '2026-04-26', hours: 4,
    });
    // 45 + 4 = 49 > 46 (limit) 但 < 54 (hard_cap)
    expect(r.is_over_limit).toBe(true);
    expect(r.over_limit_dimensions).toContain('monthly');
    expect(r.exceeds_hard_cap).toBe(false);
  });

  it('流向 3:超 hard_cap → exceeds_hard_cap=true (系統直接擋)', async () => {
    const repo = makeRepo({
      findActiveOvertimeLimits: vi.fn(async () => ({
        employee: null,
        company:  { daily_limit_hours: 4, monthly_limit_hours: 46, monthly_hard_cap_hours: 54 },
      })),
      findOvertimeApprovedHours: vi.fn(async () => ({
        daily: 0, weekly: 0, monthly: 50, yearly: 100,
      })),
    });
    const r = await checkOverLimit(repo, {
      employee_id: 'E001', overtime_date: '2026-04-26', hours: 6,
    });
    // 50 + 6 = 56 > 54 (hard_cap)
    expect(r.exceeds_hard_cap).toBe(true);
    expect(r.is_over_limit).toBe(true); // 也超 limit
    expect(r.over_limit_dimensions).toContain('monthly');
  });

  it('多維度同時超 → 都記在 over_limit_dimensions', async () => {
    const repo = makeRepo({
      findActiveOvertimeLimits: vi.fn(async () => ({
        employee: null,
        company:  { daily_limit_hours: 4, weekly_limit_hours: 16, monthly_limit_hours: 46 },
      })),
      findOvertimeApprovedHours: vi.fn(async () => ({
        daily: 3, weekly: 14, monthly: 45, yearly: 0,
      })),
    });
    const r = await checkOverLimit(repo, {
      employee_id: 'E001', overtime_date: '2026-04-26', hours: 3,
    });
    // daily 3+3=6>4, weekly 14+3=17>16, monthly 45+3=48>46, yearly 不檢查(null)
    expect(r.is_over_limit).toBe(true);
    expect(r.over_limit_dimensions).toEqual(['daily', 'weekly', 'monthly']);
  });

  it('上限欄位 null → 該維度不檢查', async () => {
    const repo = makeRepo({
      findActiveOvertimeLimits: vi.fn(async () => ({
        employee: null,
        company:  { daily_limit_hours: 4, weekly_limit_hours: null, monthly_limit_hours: null },
      })),
      findOvertimeApprovedHours: vi.fn(async () => ({
        daily: 1, weekly: 100, monthly: 999, yearly: 0,
      })),
    });
    const r = await checkOverLimit(repo, {
      employee_id: 'E001', overtime_date: '2026-04-26', hours: 1,
    });
    expect(r.is_over_limit).toBe(false); // weekly/monthly 上限 null → skip
  });

  it('hours 非正 → throw', async () => {
    await expect(checkOverLimit(makeRepo(), {
      employee_id: 'E001', overtime_date: '2026-04-26', hours: 0,
    })).rejects.toThrow();
  });
});

describe('computeDateRanges — 日 / 週 / 月 / 年區間', () => {
  it('週一 2026-04-27', () => {
    const r = computeDateRanges('2026-04-27');
    expect(r.day).toBe('2026-04-27');
    expect(r.weekStart).toBe('2026-04-27');
    expect(r.weekEnd).toBe('2026-05-03');
    expect(r.monthStart).toBe('2026-04-01');
    expect(r.monthEnd).toBe('2026-04-30');
    expect(r.yearStart).toBe('2026-01-01');
    expect(r.yearEnd).toBe('2026-12-31');
  });

  it('週日 2026-04-26 → weekStart 是 04-20', () => {
    const r = computeDateRanges('2026-04-26');
    expect(r.weekStart).toBe('2026-04-20');
    expect(r.weekEnd).toBe('2026-04-26');
  });

  it('月底 2026-04-30', () => {
    const r = computeDateRanges('2026-04-30');
    expect(r.monthStart).toBe('2026-04-01');
    expect(r.monthEnd).toBe('2026-04-30');
  });

  it('閏年 2024-02-29', () => {
    const r = computeDateRanges('2024-02-29');
    expect(r.monthStart).toBe('2024-02-01');
    expect(r.monthEnd).toBe('2024-02-29');
  });

  it('invalid date → throw', () => {
    expect(() => computeDateRanges('invalid')).toThrow();
  });
});

describe('isCrossMonth — 規範 §9.6 不能跨月申請', () => {
  it('同年同月 → false', () => {
    expect(isCrossMonth('2026-04-26', '2026-04-15')).toBe(false);
    expect(isCrossMonth('2026-04-01', '2026-04-30')).toBe(false);
  });

  it('跨月(同年)→ true', () => {
    expect(isCrossMonth('2026-05-01', '2026-04-30')).toBe(true);
    expect(isCrossMonth('2026-03-31', '2026-04-01')).toBe(true);
  });

  it('跨年 → true', () => {
    expect(isCrossMonth('2027-01-01', '2026-12-31')).toBe(true);
    expect(isCrossMonth('2025-12-31', '2026-01-01')).toBe(true);
  });

  it('overtimeDate 缺 → true(保守視為跨月)', () => {
    expect(isCrossMonth(null, '2026-04-26')).toBe(true);
    expect(isCrossMonth(undefined, '2026-04-26')).toBe(true);
    expect(isCrossMonth('', '2026-04-26')).toBe(true);
  });

  it('today 缺 → true(保守視為跨月)', () => {
    expect(isCrossMonth('2026-04-26', null)).toBe(true);
    expect(isCrossMonth('2026-04-26', undefined)).toBe(true);
    expect(isCrossMonth('2026-04-26', '')).toBe(true);
  });

  it('兩者都缺 → true', () => {
    expect(isCrossMonth(null, null)).toBe(true);
  });

  it('YYYY-MM-DD 後面附 timestamp 也接受(只看前 7 字)', () => {
    expect(isCrossMonth('2026-04-26T18:00:00+08:00', '2026-04-15')).toBe(false);
  });
});
