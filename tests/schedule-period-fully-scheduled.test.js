// tests/schedule-period-fully-scheduled.test.js — F2 純函式測試
//
// 對應 lib/schedule/period-coverage.js::isPeriodFullyScheduled
// 判定式:該 period_start ~ period_end 每一天都要有 ≥1 筆 schedules row
//        (任意 shift_type、含 ST003 休 / ST004 例假;例假/國定假日不豁免)

import { describe, it, expect } from 'vitest';
import { isPeriodFullyScheduled } from '../lib/schedule/period-coverage.js';

describe('isPeriodFullyScheduled — happy path', () => {
  it('每天都有狀態 → ok:true', () => {
    const period = { period_start: '2026-06-01', period_end: '2026-06-05' };
    const schedules = [
      { work_date: '2026-06-01' },
      { work_date: '2026-06-02' },
      { work_date: '2026-06-03' },
      { work_date: '2026-06-04' },
      { work_date: '2026-06-05' },
    ];
    expect(isPeriodFullyScheduled(period, schedules)).toEqual({ ok: true });
  });

  it('多 segment 同日(同一 work_date 多筆 row)→ 仍算該日已有狀態', () => {
    const period = { period_start: '2026-06-01', period_end: '2026-06-03' };
    const schedules = [
      { work_date: '2026-06-01' }, // 早班 segment 1
      { work_date: '2026-06-01' }, // 晚班 segment 2 同日
      { work_date: '2026-06-02' },
      { work_date: '2026-06-03' },
    ];
    expect(isPeriodFullyScheduled(period, schedules)).toEqual({ ok: true });
  });

  it('例假/休假 row(任意 shift_type)都算已有狀態', () => {
    // 純函式只看 work_date,不看 shift_type / is_off / note
    const period = { period_start: '2026-06-01', period_end: '2026-06-03' };
    const schedules = [
      { work_date: '2026-06-01' }, // ST001 早班
      { work_date: '2026-06-02' }, // ST003 休假日
      { work_date: '2026-06-03' }, // ST004 例假日
    ];
    expect(isPeriodFullyScheduled(period, schedules)).toEqual({ ok: true });
  });

  it('period_start === period_end 單日 + 有 row → ok', () => {
    expect(isPeriodFullyScheduled(
      { period_start: '2026-06-01', period_end: '2026-06-01' },
      [{ work_date: '2026-06-01' }]
    )).toEqual({ ok: true });
  });
});

describe('isPeriodFullyScheduled — 缺天 case', () => {
  it('中間缺 1 天 → ok:false 含該天', () => {
    const period = { period_start: '2026-06-01', period_end: '2026-06-05' };
    const schedules = [
      { work_date: '2026-06-01' },
      { work_date: '2026-06-02' },
      // 缺 06-03
      { work_date: '2026-06-04' },
      { work_date: '2026-06-05' },
    ];
    expect(isPeriodFullyScheduled(period, schedules)).toEqual({
      ok: false,
      missingDates: ['2026-06-03'],
    });
  });

  it('全空 schedules → 全部 missing', () => {
    const period = { period_start: '2026-06-01', period_end: '2026-06-03' };
    expect(isPeriodFullyScheduled(period, [])).toEqual({
      ok: false,
      missingDates: ['2026-06-01', '2026-06-02', '2026-06-03'],
    });
  });

  it('schedules 為 null / undefined → 全部 missing', () => {
    const period = { period_start: '2026-06-01', period_end: '2026-06-02' };
    expect(isPeriodFullyScheduled(period, null)).toEqual({
      ok: false,
      missingDates: ['2026-06-01', '2026-06-02'],
    });
    expect(isPeriodFullyScheduled(period, undefined)).toEqual({
      ok: false,
      missingDates: ['2026-06-01', '2026-06-02'],
    });
  });

  it('schedules 包含 period 範圍外 row → 範圍外忽略、範圍內缺天仍要抓', () => {
    const period = { period_start: '2026-06-01', period_end: '2026-06-02' };
    const schedules = [
      { work_date: '2026-05-31' }, // 範圍外、忽略
      { work_date: '2026-06-01' },
      // 06-02 缺
      { work_date: '2026-06-03' }, // 範圍外、忽略
    ];
    expect(isPeriodFullyScheduled(period, schedules)).toEqual({
      ok: false,
      missingDates: ['2026-06-02'],
    });
  });

  it('missingDates 按時間升序', () => {
    const period = { period_start: '2026-06-01', period_end: '2026-06-05' };
    const schedules = [{ work_date: '2026-06-03' }];
    expect(isPeriodFullyScheduled(period, schedules)).toEqual({
      ok: false,
      missingDates: ['2026-06-01', '2026-06-02', '2026-06-04', '2026-06-05'],
    });
  });
});

describe('isPeriodFullyScheduled — 跨月 / 月底 / 閏年(時區陷阱防護)', () => {
  it('跨月 5/28~6/2:6 天全有 → ok(月底 5/31 不漏)', () => {
    const period = { period_start: '2026-05-28', period_end: '2026-06-02' };
    const schedules = [
      { work_date: '2026-05-28' },
      { work_date: '2026-05-29' },
      { work_date: '2026-05-30' },
      { work_date: '2026-05-31' }, // ← 月底容易被時區計算漏掉
      { work_date: '2026-06-01' },
      { work_date: '2026-06-02' },
    ];
    expect(isPeriodFullyScheduled(period, schedules)).toEqual({ ok: true });
  });

  it('跨月 5/28~6/2:缺 5/31 → missingDates 抓得到(月底字串迭代正確)', () => {
    const period = { period_start: '2026-05-28', period_end: '2026-06-02' };
    const schedules = [
      { work_date: '2026-05-28' },
      { work_date: '2026-05-29' },
      { work_date: '2026-05-30' },
      // 缺 5/31
      { work_date: '2026-06-01' },
      { work_date: '2026-06-02' },
    ];
    expect(isPeriodFullyScheduled(period, schedules)).toEqual({
      ok: false,
      missingDates: ['2026-05-31'],
    });
  });

  it('非閏年 2 月底 2026-02-26~2026-03-02:5 天 = 2/26 2/27 2/28 3/1 3/2、缺 3/1', () => {
    const period = { period_start: '2026-02-26', period_end: '2026-03-02' };
    const schedules = [
      { work_date: '2026-02-26' },
      { work_date: '2026-02-27' },
      { work_date: '2026-02-28' },
      // 缺 3/1(月底 + 1 → 換月、迭代不能漏)
      { work_date: '2026-03-02' },
    ];
    expect(isPeriodFullyScheduled(period, schedules)).toEqual({
      ok: false,
      missingDates: ['2026-03-01'],
    });
  });

  it('閏年 2 月底 2024-02-27~2024-03-01:4 天 = 2/27 2/28 2/29 3/1(2/29 存在)', () => {
    const period = { period_start: '2024-02-27', period_end: '2024-03-01' };
    const schedules = [
      { work_date: '2024-02-27' },
      { work_date: '2024-02-28' },
      { work_date: '2024-02-29' }, // ← 閏年 2 月有 29 日、迭代必須產出這天
      { work_date: '2024-03-01' },
    ];
    expect(isPeriodFullyScheduled(period, schedules)).toEqual({ ok: true });
  });

  it('閏年 2 月 全月 2024-02-01~2024-02-29:29 天、給 28 天 → 缺 2/29', () => {
    const period = { period_start: '2024-02-01', period_end: '2024-02-29' };
    const schedules = Array.from({ length: 28 }, (_, i) => ({
      work_date: `2024-02-${String(i + 1).padStart(2, '0')}`,
    }));
    expect(isPeriodFullyScheduled(period, schedules)).toEqual({
      ok: false,
      missingDates: ['2024-02-29'],
    });
  });

  it('非閏年 2 月 全月 2026-02-01~2026-02-28:28 天、不該誤生 2/29', () => {
    const period = { period_start: '2026-02-01', period_end: '2026-02-28' };
    const schedules = Array.from({ length: 28 }, (_, i) => ({
      work_date: `2026-02-${String(i + 1).padStart(2, '0')}`,
    }));
    // 純函式必須知道 2026 非閏年、2/28 就是月底、不會把不存在的 2/29 加入 missingDates
    expect(isPeriodFullyScheduled(period, schedules)).toEqual({ ok: true });
  });

  it('跨年 2026-12-30~2027-01-02:缺 1/2', () => {
    const period = { period_start: '2026-12-30', period_end: '2027-01-02' };
    const schedules = [
      { work_date: '2026-12-30' },
      { work_date: '2026-12-31' }, // 12/31 → 1/1 換年迭代正確
      { work_date: '2027-01-01' },
      // 缺 1/2
    ];
    expect(isPeriodFullyScheduled(period, schedules)).toEqual({
      ok: false,
      missingDates: ['2027-01-02'],
    });
  });
});

describe('isPeriodFullyScheduled — 邊角', () => {
  it('period_start > period_end → ok:true(invalid range、純函式不 throw)', () => {
    expect(isPeriodFullyScheduled(
      { period_start: '2026-06-05', period_end: '2026-06-01' },
      []
    )).toEqual({ ok: true });
  });

  it('period 缺 period_start / period_end → ok:true(寬鬆、由 caller 守)', () => {
    expect(isPeriodFullyScheduled({}, [])).toEqual({ ok: true });
    expect(isPeriodFullyScheduled({ period_start: '2026-06-01' }, [])).toEqual({ ok: true });
    expect(isPeriodFullyScheduled(null, [])).toEqual({ ok: true });
  });
});
