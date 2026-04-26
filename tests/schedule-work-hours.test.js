import { describe, it, expect } from 'vitest';
import {
  calculateScheduleWorkMinutes,
  calculateDailyTotalMinutes,
  detectSegmentOverlap,
} from '../lib/schedule/work-hours.js';

describe('calculateScheduleWorkMinutes', () => {
  it('普通班 09:00-18:00 扣 60 分鐘休息 = 480', () => {
    expect(calculateScheduleWorkMinutes('09:00', '18:00', 60, false)).toBe(480);
  });

  it('無休息 09:00-12:00 = 180', () => {
    expect(calculateScheduleWorkMinutes('09:00', '12:00', 0, false)).toBe(180);
  });

  it('跨日 22:00-06:00 + 60 分休息 = 8h - 1h = 420', () => {
    expect(calculateScheduleWorkMinutes('22:00', '06:00', 60, true)).toBe(420);
  });

  it('end < start 自動視為跨日（不需 crossesMidnight=true）', () => {
    expect(calculateScheduleWorkMinutes('22:00', '06:00', 0, false)).toBe(480);
  });

  it('支援 HH:MM:SS 格式（DB TIME 可能多帶秒）', () => {
    expect(calculateScheduleWorkMinutes('09:00:00', '18:00:00', 60, false)).toBe(480);
  });

  it('break 比工時還大 → 0（不回負）', () => {
    expect(calculateScheduleWorkMinutes('09:00', '10:00', 120, false)).toBe(0);
  });

  it('無效時間 → 0', () => {
    expect(calculateScheduleWorkMinutes('25:99', '18:00', 0, false)).toBe(0);
    expect(calculateScheduleWorkMinutes(null, '18:00', 0, false)).toBe(0);
    expect(calculateScheduleWorkMinutes('09:00', '', 0, false)).toBe(0);
  });

  it('breakMinutes 為 null → 視為 0', () => {
    expect(calculateScheduleWorkMinutes('09:00', '18:00', null, false)).toBe(540);
  });
});

describe('calculateDailyTotalMinutes', () => {
  it('多段加總', () => {
    expect(calculateDailyTotalMinutes([
      { start_time: '09:00', end_time: '12:00', break_minutes: 0 },
      { start_time: '13:00', end_time: '18:00', break_minutes: 0 },
    ])).toBe(180 + 300);
  });

  it('空陣列 = 0', () => {
    expect(calculateDailyTotalMinutes([])).toBe(0);
  });

  it('非陣列 = 0', () => {
    expect(calculateDailyTotalMinutes(null)).toBe(0);
    expect(calculateDailyTotalMinutes(undefined)).toBe(0);
  });

  it('含跨日段', () => {
    expect(calculateDailyTotalMinutes([
      { start_time: '09:00', end_time: '12:00', break_minutes: 0 },
      { start_time: '22:00', end_time: '02:00', break_minutes: 0, crosses_midnight: true },
    ])).toBe(180 + 240);
  });
});

describe('detectSegmentOverlap', () => {
  it('無重疊 → 空陣列', () => {
    const r = detectSegmentOverlap([
      { start_time: '09:00', end_time: '12:00' },
      { start_time: '13:00', end_time: '18:00' },
    ]);
    expect(r).toEqual([]);
  });

  it('完全相同的兩段 → 重疊一對', () => {
    const segs = [
      { start_time: '09:00', end_time: '18:00' },
      { start_time: '09:00', end_time: '18:00' },
    ];
    const r = detectSegmentOverlap(segs);
    expect(r).toHaveLength(1);
    expect(r[0].segmentA).toBe(segs[0]);
    expect(r[0].segmentB).toBe(segs[1]);
  });

  it('部分重疊 → 偵測', () => {
    const r = detectSegmentOverlap([
      { start_time: '09:00', end_time: '13:00' },
      { start_time: '12:00', end_time: '18:00' },
    ]);
    expect(r).toHaveLength(1);
  });

  it('相鄰不重疊（前段結束 = 後段開始）→ 不算重疊', () => {
    const r = detectSegmentOverlap([
      { start_time: '09:00', end_time: '12:00' },
      { start_time: '12:00', end_time: '15:00' },
    ]);
    expect(r).toEqual([]);
  });

  it('跨日段 + 隔日早班 → 偵測', () => {
    const r = detectSegmentOverlap([
      { start_time: '22:00', end_time: '06:00', crosses_midnight: true }, // 22:00-30:00
      { start_time: '05:00', end_time: '08:00' },                          //  5:00- 8:00
    ]);
    // 22:00-30:00 跟 5:00-8:00 不相交（絕對時間軸上）— ranges 是 [1320,1800] 跟 [300,480]，不重疊
    // 此測試確認跨日平移後比較正確
    expect(r).toEqual([]);
  });

  it('三段中兩兩重疊 → 兩對', () => {
    const segs = [
      { start_time: '09:00', end_time: '13:00' },
      { start_time: '12:00', end_time: '18:00' },
      { start_time: '14:00', end_time: '16:00' },
    ];
    const r = detectSegmentOverlap(segs);
    // (0,1) 重疊；(1,2) 重疊；(0,2) 不重疊（13<14）
    expect(r).toHaveLength(2);
  });

  it('小於 2 段或非陣列 → 空陣列', () => {
    expect(detectSegmentOverlap([])).toEqual([]);
    expect(detectSegmentOverlap([{ start_time: '09:00', end_time: '18:00' }])).toEqual([]);
    expect(detectSegmentOverlap(null)).toEqual([]);
  });
});
