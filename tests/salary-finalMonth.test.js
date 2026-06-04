// tests/salary-finalMonth.test.js — resolveFinalMonthDays 純函式測試
// 對應 lib/salary/finalMonth.js

import { describe, it, expect } from 'vitest';
import { resolveFinalMonthDays } from '../lib/salary/finalMonth.js';

describe('resolveFinalMonthDays — 離職月 calendar-day prorata 推導', () => {
  it('status=active → null(非離職員工不推導)', () => {
    expect(resolveFinalMonthDays(
      { status: 'active', resigned_at: '2026-05-10T00:00:00+08:00' },
      2026, 5,
    )).toBeNull();
  });

  it('status=inactive → null(非 resigned 一律不推導)', () => {
    expect(resolveFinalMonthDays(
      { status: 'inactive', resigned_at: '2026-05-10T00:00:00+08:00' },
      2026, 5,
    )).toBeNull();
  });

  it('emp 為 null / undefined → null(防呆)', () => {
    expect(resolveFinalMonthDays(null, 2026, 5)).toBeNull();
    expect(resolveFinalMonthDays(undefined, 2026, 5)).toBeNull();
  });

  it('resign_date 與 resigned_at 都 null → null', () => {
    expect(resolveFinalMonthDays(
      { status: 'resigned', resign_date: null, resigned_at: null },
      2026, 5,
    )).toBeNull();
  });

  it('resign_date 優先(planning > audit):resign_date=5/13 ignore resigned_at=4/30', () => {
    const r = resolveFinalMonthDays(
      { status: 'resigned', resign_date: '2026-05-13', resigned_at: '2026-04-30T15:00:00+00:00' },
      2026, 5,
    );
    expect(r).toEqual({ workedDays: 13, totalDaysInMonth: 31 });
  });

  it('只有 resigned_at(無 resign_date)、台北日 5/10 → workedDays=10', () => {
    // resigned_at = UTC 2026-05-09T17:00:00Z = Taipei 2026-05-10 01:00 → 第 10 日
    const r = resolveFinalMonthDays(
      { status: 'resigned', resigned_at: '2026-05-09T17:00:00Z' },
      2026, 5,
    );
    expect(r).toEqual({ workedDays: 10, totalDaysInMonth: 31 });
  });

  it('resign_date 月份 ≠ 結算月 → null(防止跨月誤判)', () => {
    expect(resolveFinalMonthDays(
      { status: 'resigned', resign_date: '2026-04-28' },
      2026, 5,
    )).toBeNull();
    expect(resolveFinalMonthDays(
      { status: 'resigned', resign_date: '2026-06-01' },
      2026, 5,
    )).toBeNull();
  });

  it('resigned_at 月份 ≠ 結算月 → null(同上、走 resigned_at 路徑)', () => {
    expect(resolveFinalMonthDays(
      { status: 'resigned', resigned_at: '2026-04-28T00:00:00+08:00' },
      2026, 5,
    )).toBeNull();
  });

  it('月底邊界:5/31 離職 → workedDays=31、totalDaysInMonth=31', () => {
    const r = resolveFinalMonthDays(
      { status: 'resigned', resign_date: '2026-05-31' },
      2026, 5,
    );
    expect(r).toEqual({ workedDays: 31, totalDaysInMonth: 31 });
  });

  it('月初邊界:5/1 離職 → workedDays=1', () => {
    const r = resolveFinalMonthDays(
      { status: 'resigned', resign_date: '2026-05-01' },
      2026, 5,
    );
    expect(r).toEqual({ workedDays: 1, totalDaysInMonth: 31 });
  });

  it('2 月閏年(2024):2/15 離職 → totalDaysInMonth=29', () => {
    const r = resolveFinalMonthDays(
      { status: 'resigned', resign_date: '2024-02-15' },
      2024, 2,
    );
    expect(r).toEqual({ workedDays: 15, totalDaysInMonth: 29 });
  });

  it('2 月平年(2026):2/15 離職 → totalDaysInMonth=28', () => {
    const r = resolveFinalMonthDays(
      { status: 'resigned', resign_date: '2026-02-15' },
      2026, 2,
    );
    expect(r).toEqual({ workedDays: 15, totalDaysInMonth: 28 });
  });

  it('30 天月(2026/4):4/30 離職 → totalDaysInMonth=30', () => {
    const r = resolveFinalMonthDays(
      { status: 'resigned', resign_date: '2026-04-30' },
      2026, 4,
    );
    expect(r).toEqual({ workedDays: 30, totalDaysInMonth: 30 });
  });

  it('resign_date 格式異常(非 YYYY-MM-DD)→ null(parseInt 失敗、防呆)', () => {
    expect(resolveFinalMonthDays(
      { status: 'resigned', resign_date: 'invalid' },
      2026, 5,
    )).toBeNull();
  });
});
