// tests/unpaid-leave.test.js
// 抓 lib/salary/unpaid-leave.js allocateDaysInMonth 純函式行為(Phase 3B)

import { describe, it, expect } from 'vitest';
import { allocateDaysInMonth } from '../lib/salary/unpaid-leave.js';

describe('allocateDaysInMonth', () => {
  it('全程在目標月內 → 回 totalDays(無 clip)', () => {
    expect(allocateDaysInMonth('2026-06-05', '2026-06-07', 3, 2026, 6)).toBe(3);
    expect(allocateDaysInMonth('2026-06-15', '2026-06-15', 1, 2026, 6)).toBe(1);
  });

  it('單日半日請假(days=0.5、start=end)→ 回 0.5', () => {
    expect(allocateDaysInMonth('2026-06-15', '2026-06-15', 0.5, 2026, 6)).toBe(0.5);
  });

  it('完全在目標月之前(end < monthStart)→ 回 0', () => {
    expect(allocateDaysInMonth('2026-05-25', '2026-05-30', 6, 2026, 6)).toBe(0);
  });

  it('完全在目標月之後(start > monthEnd)→ 回 0', () => {
    expect(allocateDaysInMonth('2026-07-05', '2026-07-07', 3, 2026, 6)).toBe(0);
  });

  it('跨月(前半在目標月、後半溢出)→ 按比例', () => {
    // 6/28~7/2 共 5 曆日,目標月 6 月只佔 6/28~6/30 = 3 曆日 → days × 3/5
    expect(allocateDaysInMonth('2026-06-28', '2026-07-02', 5, 2026, 6)).toBeCloseTo(3, 10);
  });

  it('跨月(後半在目標月、前半在上月)→ 按比例', () => {
    // 5/30~6/2 共 4 曆日,目標月 6 月只佔 6/1~6/2 = 2 曆日 → days × 2/4 = days/2
    expect(allocateDaysInMonth('2026-05-30', '2026-06-02', 4, 2026, 6)).toBeCloseTo(2, 10);
  });

  it('跨月含半天(days=2.5、跨 2 天)→ 按比例(2.5 × 1/2 = 1.25)', () => {
    expect(allocateDaysInMonth('2026-05-31', '2026-06-01', 2.5, 2026, 6)).toBeCloseTo(1.25, 10);
  });

  it('整月覆蓋(start 早於月初、end 晚於月末)→ 按比例', () => {
    // 5/30~7/5 共 37 曆日,6 月佔 30 曆日 → days × 30/37
    expect(allocateDaysInMonth('2026-05-30', '2026-07-05', 30, 2026, 6)).toBeCloseTo(30 * 30/37, 10);
  });

  it('totalDays=0 / null / 負數 → 回 0', () => {
    expect(allocateDaysInMonth('2026-06-05', '2026-06-07', 0,    2026, 6)).toBe(0);
    expect(allocateDaysInMonth('2026-06-05', '2026-06-07', null, 2026, 6)).toBe(0);
    expect(allocateDaysInMonth('2026-06-05', '2026-06-07', -1,   2026, 6)).toBe(0);
  });

  it('日期格式錯誤 → 回 0', () => {
    expect(allocateDaysInMonth('invalid',    '2026-06-07', 3, 2026, 6)).toBe(0);
    expect(allocateDaysInMonth('2026-06-05', null,         3, 2026, 6)).toBe(0);
    expect(allocateDaysInMonth(null,         '2026-06-07', 3, 2026, 6)).toBe(0);
  });

  it('end < start → 回 0(防呆)', () => {
    expect(allocateDaysInMonth('2026-06-10', '2026-06-05', 3, 2026, 6)).toBe(0);
  });

  it('year/month 無效 → 回 0', () => {
    expect(allocateDaysInMonth('2026-06-05', '2026-06-07', 3, 2026, 13)).toBe(0);
    expect(allocateDaysInMonth('2026-06-05', '2026-06-07', 3, 2026, 0)).toBe(0);
  });

  it('閏年 2 月最後一天邊界', () => {
    // 2028 是閏年、2 月有 29 天
    expect(allocateDaysInMonth('2028-02-25', '2028-02-29', 5, 2028, 2)).toBe(5);
    // 2026 非閏年、2 月只 28 天;請假 2/25~3/2 共 6 曆日(25,26,27,28,1,2)、2 月佔 4 曆日
    // → days × 4/6 = 5 × 4/6 ≈ 3.333
    expect(allocateDaysInMonth('2026-02-25', '2026-03-02', 5, 2026, 2)).toBeCloseTo(5 * 4/6, 10);
  });
});
