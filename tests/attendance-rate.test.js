import { describe, it, expect, vi } from 'vitest';
import { calculateAttendanceRate, countWorkdaysInMonth } from '../lib/attendance/rate.js';

function makeRepo(over = {}) {
  return {
    findAttendanceByEmployeeMonth: vi.fn(async () => []),
    findHolidaysByMonth: vi.fn(async () => []),
    findApprovedLeavesByEmployeeMonth: vi.fn(async () => []),
    ...over,
  };
}

describe('countWorkdaysInMonth', () => {
  it('2026-04 共 30 天,週末 8 天 → 22 工作日', () => {
    expect(countWorkdaysInMonth(2026, 4)).toBe(22);
  });
  it('2026-04 + 2 個 national holidays(週間)→ 22 - 2 = 20', () => {
    const set = new Set(['2026-04-04', '2026-04-06']); // 週六/週一
    // 4/4 是 Sat → 不在 weekday 中,扣不到;4/6 是 Mon → 工作日,扣 1
    const r = countWorkdaysInMonth(2026, 4, set);
    expect(r).toBe(21);
  });
  it('閏年 2024-02 共 29 天,週末 8 天 → 21', () => {
    expect(countWorkdaysInMonth(2024, 2)).toBe(21);
  });
  it('2026-12', () => {
    expect(countWorkdaysInMonth(2026, 12)).toBeGreaterThan(0);
  });
});

describe('calculateAttendanceRate', () => {
  it('全部空 → rate 0', async () => {
    const r = await calculateAttendanceRate(makeRepo(), { employee_id:'E001', year:2026, month:4 });
    expect(r.rate).toBe(0);
    expect(r.total_attended).toBe(0);
    expect(r.total_required).toBe(22 * 8);
    expect(r.note).toMatch(/stub/);
  });

  it('滿勤(每天打卡 8 小時)→ rate 1.0', async () => {
    const atts = [];
    for (let d = 1; d <= 30; d++) {
      atts.push({ work_hours: 8, late_minutes: 0, early_leave_minutes: 0 });
    }
    const repo = makeRepo({
      findAttendanceByEmployeeMonth: vi.fn(async () => atts),
    });
    const r = await calculateAttendanceRate(repo, { employee_id:'E001', year:2026, month:4 });
    // attended 240h > required 176h → rate cap 1.0
    expect(r.rate).toBe(1);
  });

  it('遲到早退會扣 attended', async () => {
    const repo = makeRepo({
      findAttendanceByEmployeeMonth: vi.fn(async () => [
        { work_hours: 8, late_minutes: 30, early_leave_minutes: 0 },
        { work_hours: 8, late_minutes: 0,  early_leave_minutes: 60 },
      ]),
    });
    const r = await calculateAttendanceRate(repo, { employee_id:'E001', year:2026, month:4 });
    expect(r.deductions.late_hours).toBe(0.5);
    expect(r.deductions.early_leave_hours).toBe(1);
    expect(r.deductions.adjusted_attended).toBe(16 - 0.5 - 1);
  });

  it('affects_attendance_rate=false 的請假時段扣應出勤分母', async () => {
    const repo = makeRepo({
      findAttendanceByEmployeeMonth: vi.fn(async () => [{ work_hours: 80 }]),
      findApprovedLeavesByEmployeeMonth: vi.fn(async () => [
        { finalized_hours: 16, affects_attendance_rate: false }, // 2 天免扣
      ]),
    });
    const r = await calculateAttendanceRate(repo, { employee_id:'E001', year:2026, month:4 });
    expect(r.deductions.exempt_hours_from_no_rate_leaves).toBe(16);
    expect(r.deductions.adjusted_required).toBe(176 - 16); // 160
    expect(r.rate).toBe(round3(80 / 160));
  });

  it('affects_attendance_rate=true 的請假不扣分母', async () => {
    const repo = makeRepo({
      findAttendanceByEmployeeMonth: vi.fn(async () => [{ work_hours: 80 }]),
      findApprovedLeavesByEmployeeMonth: vi.fn(async () => [
        { finalized_hours: 16, affects_attendance_rate: true },
      ]),
    });
    const r = await calculateAttendanceRate(repo, { employee_id:'E001', year:2026, month:4 });
    expect(r.deductions.exempt_hours_from_no_rate_leaves).toBe(0);
    expect(r.deductions.adjusted_required).toBe(176);
  });

  it('national holiday 扣應出勤分子', async () => {
    const repo = makeRepo({
      findHolidaysByMonth: vi.fn(async () => [
        { date: '2026-04-06', holiday_type: 'national' }, // Mon
        { date: '2026-04-07', holiday_type: 'national' }, // Tue
      ]),
    });
    const r = await calculateAttendanceRate(repo, { employee_id:'E001', year:2026, month:4 });
    // 22 - 2 = 20 workdays * 8 = 160
    expect(r.total_required).toBe(160);
  });

  it('參數驗證', async () => {
    await expect(calculateAttendanceRate(makeRepo(), { year:2026, month:4 })).rejects.toThrow(/employee_id/);
    await expect(calculateAttendanceRate(makeRepo(), { employee_id:'E001', month:4 })).rejects.toThrow(/year/);
    await expect(calculateAttendanceRate(makeRepo(), { employee_id:'E001', year:2026, month:13 })).rejects.toThrow(/month/);
  });
});

function round3(n){ return Math.round(Number(n)*1000)/1000; }
