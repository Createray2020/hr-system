import { describe, it, expect } from 'vitest';
import { recomputeAttendanceStatus } from '../lib/attendance/recompute.js';

const dayShift = { start_time: '09:00', end_time: '18:00', crosses_midnight: false };
const nightShift = { start_time: '22:00', end_time: '06:00', crosses_midnight: true };

describe('recomputeAttendanceStatus — 9-5 班', () => {
  it('準時 09:00 / 18:00 → normal / 0 / 0', () => {
    const r = recomputeAttendanceStatus({
      clock_in:  '2026-05-05T09:00:00+08:00',
      clock_out: '2026-05-05T18:00:00+08:00',
      work_date: '2026-05-05',
      status: 'normal',
    }, dayShift);
    expect(r).toEqual({ late_minutes: 0, early_arrival_minutes: 0, early_leave_minutes: 0, status: 'normal' });
  });

  it('遲到 09:05 / 準時 18:00 → late / 5 / 0', () => {
    const r = recomputeAttendanceStatus({
      clock_in:  '2026-05-05T09:05:00+08:00',
      clock_out: '2026-05-05T18:00:00+08:00',
      work_date: '2026-05-05',
      status: 'normal',
    }, dayShift);
    expect(r).toEqual({ late_minutes: 5, early_arrival_minutes: 0, early_leave_minutes: 0, status: 'late' });
  });

  it('準時 / 早退 17:30 → early_leave / 0 / 30', () => {
    const r = recomputeAttendanceStatus({
      clock_in:  '2026-05-05T09:00:00+08:00',
      clock_out: '2026-05-05T17:30:00+08:00',
      work_date: '2026-05-05',
      status: 'early_leave',  // 既有舊狀態(被 bug 寫過)、會被重算覆寫
    }, dayShift);
    expect(r).toEqual({ late_minutes: 0, early_arrival_minutes: 0, early_leave_minutes: 30, status: 'early_leave' });
  });

  it('遲到 + 早退 09:05 / 17:30 → late 優先(取 late、early_leave_minutes 仍寫)', () => {
    const r = recomputeAttendanceStatus({
      clock_in:  '2026-05-05T09:05:00+08:00',
      clock_out: '2026-05-05T17:30:00+08:00',
      work_date: '2026-05-05',
      status: 'normal',
    }, dayShift);
    expect(r).toEqual({ late_minutes: 5, early_arrival_minutes: 0, early_leave_minutes: 30, status: 'late' });
  });

  it('UTC Z 形式 18:09 台灣 → normal / 0 / 0(修補前 bug 會誤算 471 早退)', () => {
    const r = recomputeAttendanceStatus({
      clock_in:  '2026-05-05T01:00:00.000Z',  // 09:00 台灣
      clock_out: '2026-05-05T10:09:00.000Z',  // 18:09 台灣
      work_date: '2026-05-05',
      status: 'early_leave',  // 被 bug 寫成這個、應重算為 normal
    }, dayShift);
    expect(r).toEqual({ late_minutes: 0, early_arrival_minutes: 0, early_leave_minutes: 0, status: 'normal' });
  });
});

describe('recomputeAttendanceStatus — early_arrival_minutes audit(純記錄、不影響 status)', () => {
  it('早到 30min(08:30 / 18:00)→ early_arrival=30、status=normal、late=0', () => {
    const r = recomputeAttendanceStatus({
      clock_in:  '2026-05-05T08:30:00+08:00',
      clock_out: '2026-05-05T18:00:00+08:00',
      work_date: '2026-05-05',
      status: 'normal',
    }, dayShift);
    expect(r.early_arrival_minutes).toBe(30);
    expect(r.late_minutes).toBe(0);
    expect(r.early_leave_minutes).toBe(0);
    expect(r.status).toBe('normal');
  });

  it('早到 + 早退(08:30 / 17:30)→ early_arrival=30、early_leave=30、status=early_leave', () => {
    const r = recomputeAttendanceStatus({
      clock_in:  '2026-05-05T08:30:00+08:00',
      clock_out: '2026-05-05T17:30:00+08:00',
      work_date: '2026-05-05',
      status: 'normal',
    }, dayShift);
    expect(r.early_arrival_minutes).toBe(30);
    expect(r.early_leave_minutes).toBe(30);
    expect(r.status).toBe('early_leave');
  });

  it("PRESERVED status='leave' + 早到 → leave 保留、early_arrival 仍計算回傳", () => {
    const r = recomputeAttendanceStatus({
      clock_in:  '2026-05-05T08:30:00+08:00',
      clock_out: '2026-05-05T17:30:00+08:00',
      work_date: '2026-05-05',
      status: 'leave',
    }, dayShift);
    expect(r.status).toBe('leave');
    expect(r.early_arrival_minutes).toBe(30);
  });

  it('schedule=null → early_arrival=0(算不出、safe fallback)', () => {
    const r = recomputeAttendanceStatus({
      clock_in:  '2026-05-05T08:30:00+08:00',
      clock_out: '2026-05-05T17:30:00+08:00',
      work_date: '2026-05-05',
      status: 'normal',
    }, null);
    expect(r.early_arrival_minutes).toBe(0);
  });
});

describe('recomputeAttendanceStatus — schedule 為 null', () => {
  it('schedule=null → 原 status / 0 / 0', () => {
    const r = recomputeAttendanceStatus({
      clock_in:  '2026-05-05T09:05:00+08:00',
      clock_out: '2026-05-05T17:30:00+08:00',
      work_date: '2026-05-05',
      status: 'early_leave',  // 既有 status、保留(算不出 late/early、不該擅自改)
    }, null);
    // schedule null → late/early 都 0、status 不在 PRESERVED → 回 'normal'(根據算法)
    expect(r.late_minutes).toBe(0);
    expect(r.early_leave_minutes).toBe(0);
    expect(r.status).toBe('normal');
  });
});

describe('recomputeAttendanceStatus — PRESERVED status 不覆寫', () => {
  it("status='leave' → 不動 status、但仍回傳重算的分鐘數", () => {
    const r = recomputeAttendanceStatus({
      clock_in:  '2026-05-05T09:05:00+08:00',
      clock_out: '2026-05-05T17:30:00+08:00',
      work_date: '2026-05-05',
      status: 'leave',
    }, dayShift);
    expect(r.status).toBe('leave');
    expect(r.late_minutes).toBe(5);
    expect(r.early_leave_minutes).toBe(30);
  });

  it("status='holiday' → 不動", () => {
    const r = recomputeAttendanceStatus({
      clock_in:  '2026-05-05T09:00:00+08:00',
      clock_out: '2026-05-05T18:00:00+08:00',
      work_date: '2026-05-05',
      status: 'holiday',
    }, dayShift);
    expect(r.status).toBe('holiday');
  });

  it("status='absent' → 不動(cron-absence-detection 寫的)", () => {
    const r = recomputeAttendanceStatus({
      clock_in: null, clock_out: null,
      work_date: '2026-05-05',
      status: 'absent',
    }, dayShift);
    expect(r.status).toBe('absent');
    expect(r.late_minutes).toBe(0);
    expect(r.early_leave_minutes).toBe(0);
  });
});

describe('recomputeAttendanceStatus — 跨日班', () => {
  it('22:05 上 / 05:30 下、night shift → late / 5 / 30', () => {
    const r = recomputeAttendanceStatus({
      clock_in:  '2026-04-26T22:05:00+08:00',
      clock_out: '2026-04-27T05:30:00+08:00',
      work_date: '2026-04-26',
      status: 'normal',
    }, nightShift);
    expect(r.late_minutes).toBe(5);
    expect(r.early_leave_minutes).toBe(30);
    expect(r.status).toBe('late');
  });
});

describe('recomputeAttendanceStatus — 缺 clock_in / clock_out', () => {
  it('clock_out null → early_leave_minutes=0、視 late 決定 status', () => {
    const r = recomputeAttendanceStatus({
      clock_in: '2026-05-05T09:10:00+08:00',
      clock_out: null,
      work_date: '2026-05-05',
      status: 'normal',
    }, dayShift);
    expect(r.late_minutes).toBe(10);
    expect(r.early_leave_minutes).toBe(0);
    expect(r.status).toBe('late');
  });

  it('clock_in null → late=0、視 early 決定 status', () => {
    const r = recomputeAttendanceStatus({
      clock_in: null,
      clock_out: '2026-05-05T17:30:00+08:00',
      work_date: '2026-05-05',
      status: 'normal',
    }, dayShift);
    expect(r.late_minutes).toBe(0);
    expect(r.early_leave_minutes).toBe(30);
    expect(r.status).toBe('early_leave');
  });
});
