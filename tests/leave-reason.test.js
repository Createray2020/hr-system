// tests/leave-reason.test.js
//
// 階段 D1:public/js/leave/reason.js 純函式行為。
// 替換 employee-leave.html「沒有可請假的工時」單一訊息成 3 種 reason code 分流。

import { describe, it, expect } from 'vitest';
import {
  getDayBlockReason,
  getEffectiveStartTime,
  getEffectiveEndTime,
  reasonMessage,
  diagnoseRange,
} from '../public/js/leave/reason.js';

describe('getDayBlockReason', () => {
  it('null / undefined sched → "no_schedule"', () => {
    expect(getDayBlockReason(null)).toBe('no_schedule');
    expect(getDayBlockReason(undefined)).toBe('no_schedule');
  });

  it('shift_types.is_off=true → "off_day"', () => {
    const sched = { work_date: '2026-05-11', shift_types: { is_off: true, name: '例假' } };
    expect(getDayBlockReason(sched)).toBe('off_day');
  });

  it('start_time 跟 shift_types.start_time 都缺 → "no_time"', () => {
    const sched = { work_date: '2026-05-11', start_time: null, shift_types: { is_off: false, name: '彈性班' } };
    expect(getDayBlockReason(sched)).toBe('no_time');
  });

  it('start_time 空字串 + shift_types 沒 fallback → "no_time"', () => {
    const sched = { work_date: '2026-05-11', start_time: '', shift_types: { is_off: false } };
    expect(getDayBlockReason(sched)).toBe('no_time');
  });

  it('schedule.start_time 有值 → null (可請假)', () => {
    const sched = { work_date: '2026-05-11', start_time: '09:00', end_time: '18:00', shift_types: { is_off: false } };
    expect(getDayBlockReason(sched)).toBeNull();
  });

  it('schedule.start_time=null + shift_types.start_time 有值 → null (fallback、可請假)', () => {
    const sched = {
      work_date: '2026-05-11',
      start_time: null, end_time: null,
      shift_types: { is_off: false, start_time: '09:00', end_time: '18:00' },
    };
    expect(getDayBlockReason(sched)).toBeNull();
  });

  it('is_off 優先於 start_time (即使有 start_time、is_off=true 仍 off_day)', () => {
    const sched = { start_time: '09:00', shift_types: { is_off: true, name: '休假' } };
    expect(getDayBlockReason(sched)).toBe('off_day');
  });

  it('沒 shift_types nested 但 schedule.start_time 有值 → null', () => {
    const sched = { work_date: '2026-05-11', start_time: '09:00' };
    expect(getDayBlockReason(sched)).toBeNull();
  });
});

describe('getEffectiveStartTime / getEffectiveEndTime (fallback 邏輯)', () => {
  it('schedule overrides 優先', () => {
    const sched = { start_time: '10:00', end_time: '19:00', shift_types: { start_time: '09:00', end_time: '18:00' } };
    expect(getEffectiveStartTime(sched)).toBe('10:00');
    expect(getEffectiveEndTime(sched)).toBe('19:00');
  });
  it('schedule 為 null → fallback shift_types default', () => {
    const sched = { start_time: null, end_time: null, shift_types: { start_time: '09:00', end_time: '18:00' } };
    expect(getEffectiveStartTime(sched)).toBe('09:00');
    expect(getEffectiveEndTime(sched)).toBe('18:00');
  });
  it('兩個都缺 → null', () => {
    expect(getEffectiveStartTime({})).toBeNull();
    expect(getEffectiveEndTime({})).toBeNull();
    expect(getEffectiveStartTime(null)).toBeNull();
  });
});

describe('reasonMessage', () => {
  it('3 種 reason 各有具體訊息含 dateStr', () => {
    expect(reasonMessage('no_schedule', '2026-05-11')).toContain('2026-05-11');
    expect(reasonMessage('no_schedule', '2026-05-11')).toContain('還沒被排班');
    expect(reasonMessage('off_day',     '2026-05-12')).toContain('休假日');
    expect(reasonMessage('no_time',     '2026-05-13')).toContain('排班時間未設定');
  });
  it('未知 reason → fallback「其他原因」', () => {
    expect(reasonMessage('unknown', '2026-05-11')).toContain('其他原因');
  });
});

describe('diagnoseRange', () => {
  const cachedSchedules = [
    // 2026-05-11:沒 row (擋掉)
    { work_date: '2026-05-12', shift_types: { is_off: true, name: '例假' } },                       // off_day
    { work_date: '2026-05-13', start_time: null, shift_types: { is_off: false } },                  // no_time
    { work_date: '2026-05-14', start_time: '09:00', end_time: '18:00', shift_types: { is_off: false } }, // workable
  ];

  it('分類 workable / blocked、每個 blocked 含 date + reason + message', () => {
    const dates = ['2026-05-11', '2026-05-12', '2026-05-13', '2026-05-14'];
    const r = diagnoseRange(dates, cachedSchedules);
    expect(r.workable).toEqual(['2026-05-14']);
    expect(r.blocked).toHaveLength(3);
    expect(r.blocked.map(b => b.reason)).toEqual(['no_schedule', 'off_day', 'no_time']);
    r.blocked.forEach(b => { expect(b.message).toContain(b.date); });
  });

  it('work_date 是 ISO timestamp ("2026-05-12T00:00:00") 也能 match (slice 0,10)', () => {
    const dates = ['2026-05-12'];
    const sched = [{ work_date: '2026-05-12T00:00:00+00:00', shift_types: { is_off: true } }];
    const r = diagnoseRange(dates, sched);
    expect(r.blocked[0].reason).toBe('off_day');
  });

  it('null/empty 寬容', () => {
    expect(diagnoseRange(null, null)).toEqual({ workable: [], blocked: [] });
    expect(diagnoseRange([], [])).toEqual({ workable: [], blocked: [] });
  });

  it('全可請 → blocked 空', () => {
    const dates = ['2026-05-14'];
    const r = diagnoseRange(dates, cachedSchedules);
    expect(r.workable).toEqual(['2026-05-14']);
    expect(r.blocked).toEqual([]);
  });
});
