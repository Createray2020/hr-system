import { describe, it, expect, vi } from 'vitest';
import {
  clockIn, clockOut,
  pickSegmentForClockIn, calculateLateMinutes, calculateEarlyLeaveMinutes,
  NoScheduleError, AlreadyClockedInError, NoOpenAttendanceError,
} from '../lib/attendance/clock.js';

function dayShift(over = {}) {
  return {
    id: 'S1', employee_id: 'E001', work_date: '2026-04-26', period_id: 'p1',
    segment_no: 1,
    start_time: '09:00', end_time: '18:00',
    crosses_midnight: false, scheduled_work_minutes: 480,
    ...over,
  };
}
function nightShift(over = {}) {
  return {
    id: 'S2', employee_id: 'E001', work_date: '2026-04-26', period_id: 'p1',
    segment_no: 1,
    start_time: '22:00', end_time: '06:00',
    crosses_midnight: true, scheduled_work_minutes: 420,
    ...over,
  };
}

function makeRepo(over = {}) {
  return {
    findSchedulesForDate: vi.fn().mockResolvedValue([dayShift()]),
    findHolidayByDate:    vi.fn().mockResolvedValue(null),
    findAttendanceByDateSegment: vi.fn().mockResolvedValue(null),
    findOpenAttendanceForEmployee: vi.fn().mockResolvedValue(null),
    findScheduleById: vi.fn().mockResolvedValue(dayShift()),
    upsertAttendance: vi.fn(async row => ({ ...row })),
    updateAttendance: vi.fn(async (id, patch) => ({ id, ...patch })),
    ...over,
  };
}

describe('clockIn — happy paths', () => {
  it('準時上班 → status=normal, late_minutes=0', async () => {
    const repo = makeRepo();
    const att = await clockIn(repo, { employee_id: 'E001', timestamp: '2026-04-26T09:00:00+08:00' });
    expect(att.status).toBe('normal');
    expect(att.late_minutes).toBe(0);
    expect(att.segment_no).toBe(1);
    expect(att.schedule_id).toBe('S1');
  });

  it('遲到 12 分鐘 → status=late', async () => {
    const repo = makeRepo();
    const att = await clockIn(repo, { employee_id: 'E001', timestamp: '2026-04-26T09:12:00+08:00' });
    expect(att.status).toBe('late');
    expect(att.late_minutes).toBe(12);
  });

  it('早到打卡（08:50）→ status=normal,not late', async () => {
    const repo = makeRepo();
    const att = await clockIn(repo, { employee_id: 'E001', timestamp: '2026-04-26T08:50:00+08:00' });
    expect(att.status).toBe('normal');
    expect(att.late_minutes).toBe(0);
  });

  it('國定假日工作 → is_holiday_work=true、holiday_id 填入', async () => {
    const repo = makeRepo({
      findHolidayByDate: vi.fn().mockResolvedValue({ id: 42, holiday_type: 'national' }),
    });
    const att = await clockIn(repo, { employee_id: 'E001', timestamp: '2026-04-26T09:00:00+08:00' });
    expect(att.is_holiday_work).toBe(true);
    expect(att.holiday_id).toBe(42);
  });

  it('makeup_workday 不算 holiday_work', async () => {
    const repo = makeRepo({
      findHolidayByDate: vi.fn().mockResolvedValue({ id: 7, holiday_type: 'makeup_workday' }),
    });
    const att = await clockIn(repo, { employee_id: 'E001', timestamp: '2026-04-26T09:00:00+08:00' });
    expect(att.is_holiday_work).toBe(false);
  });
});

describe('clockIn — errors', () => {
  it('沒 schedule → NoScheduleError', async () => {
    const repo = makeRepo({ findSchedulesForDate: vi.fn().mockResolvedValue([]) });
    await expect(
      clockIn(repo, { employee_id: 'E001', timestamp: '2026-04-26T09:00:00+08:00' })
    ).rejects.toBeInstanceOf(NoScheduleError);
  });

  it('schedule null → NoScheduleError', async () => {
    const repo = makeRepo({ findSchedulesForDate: vi.fn().mockResolvedValue(null) });
    await expect(
      clockIn(repo, { employee_id: 'E001', timestamp: '2026-04-26T09:00:00+08:00' })
    ).rejects.toBeInstanceOf(NoScheduleError);
  });

  it('該段已打過上班卡 → AlreadyClockedInError', async () => {
    const repo = makeRepo({
      findAttendanceByDateSegment: vi.fn().mockResolvedValue({
        id: 'A1', clock_in: '2026-04-26T09:00:00+08:00', clock_out: null,
      }),
    });
    await expect(
      clockIn(repo, { employee_id: 'E001', timestamp: '2026-04-26T10:00:00+08:00' })
    ).rejects.toBeInstanceOf(AlreadyClockedInError);
  });

  it('缺 employee_id 拒絕', async () => {
    await expect(clockIn(makeRepo(), { timestamp: '2026-04-26T09:00:00+08:00' }))
      .rejects.toThrow(/employee_id/);
  });
});

describe('clockIn — 多段班 segment 對應', () => {
  it('多段班:落在第二段 → 選第二段', async () => {
    const seg1 = dayShift({ id: 'S1', segment_no: 1, start_time: '09:00', end_time: '12:00' });
    const seg2 = dayShift({ id: 'S2', segment_no: 2, start_time: '14:00', end_time: '18:00' });
    const repo = makeRepo({ findSchedulesForDate: vi.fn().mockResolvedValue([seg1, seg2]) });
    const att = await clockIn(repo, { employee_id: 'E001', timestamp: '2026-04-26T14:05:00+08:00' });
    expect(att.segment_no).toBe(2);
    expect(att.schedule_id).toBe('S2');
  });

  it('多段班:在 12:30 不落在任一段(中間)→ 選第一段(start 較近且 ≤ t)', async () => {
    const seg1 = dayShift({ id: 'S1', segment_no: 1, start_time: '09:00', end_time: '12:00' });
    const seg2 = dayShift({ id: 'S2', segment_no: 2, start_time: '14:00', end_time: '18:00' });
    const repo = makeRepo({ findSchedulesForDate: vi.fn().mockResolvedValue([seg1, seg2]) });
    const att = await clockIn(repo, { employee_id: 'E001', timestamp: '2026-04-26T12:30:00+08:00' });
    expect(att.segment_no).toBe(1);
  });

  it('多段班:08:00 早於所有段 → 選第一段(避免拒絕早到)', async () => {
    const seg1 = dayShift({ id: 'S1', segment_no: 1, start_time: '09:00', end_time: '12:00' });
    const seg2 = dayShift({ id: 'S2', segment_no: 2, start_time: '14:00', end_time: '18:00' });
    const repo = makeRepo({ findSchedulesForDate: vi.fn().mockResolvedValue([seg1, seg2]) });
    const att = await clockIn(repo, { employee_id: 'E001', timestamp: '2026-04-26T08:00:00+08:00' });
    expect(att.segment_no).toBe(1);
  });
});

describe('clockIn — 跨日班', () => {
  it('22:30 打卡到 22:00 開始的跨日班 → late=30', async () => {
    const repo = makeRepo({ findSchedulesForDate: vi.fn().mockResolvedValue([nightShift()]) });
    const att = await clockIn(repo, { employee_id: 'E001', timestamp: '2026-04-26T22:30:00+08:00' });
    expect(att.late_minutes).toBe(30);
    expect(att.status).toBe('late');
  });
});

describe('clockOut — happy paths', () => {
  it('準時下班 18:00 → work_hours=8 (含1h 休息但 work_hours 是時鐘差)', async () => {
    const repo = makeRepo({
      findOpenAttendanceForEmployee: vi.fn().mockResolvedValue({
        id: 'A1', employee_id: 'E001', work_date: '2026-04-26',
        schedule_id: 'S1', clock_in: '2026-04-26T09:00:00+08:00',
        status: 'normal',
      }),
    });
    const att = await clockOut(repo, { employee_id: 'E001', timestamp: '2026-04-26T18:00:00+08:00' });
    expect(att.work_hours).toBe(9);
    expect(att.status).toBe('normal');
    expect(att.early_leave_minutes).toBe(0);
  });

  it('早退 17:30 → status=early_leave, early_leave_minutes=30', async () => {
    const repo = makeRepo({
      findOpenAttendanceForEmployee: vi.fn().mockResolvedValue({
        id: 'A1', employee_id: 'E001', work_date: '2026-04-26',
        schedule_id: 'S1', clock_in: '2026-04-26T09:00:00+08:00',
        status: 'normal',
      }),
    });
    const att = await clockOut(repo, { employee_id: 'E001', timestamp: '2026-04-26T17:30:00+08:00' });
    expect(att.status).toBe('early_leave');
    expect(att.early_leave_minutes).toBe(30);
  });

  it('加班 19:00 下班 → overtime_hours = 2 (work 10h - sched 8h)', async () => {
    const repo = makeRepo({
      findOpenAttendanceForEmployee: vi.fn().mockResolvedValue({
        id: 'A1', employee_id: 'E001', work_date: '2026-04-26',
        schedule_id: 'S1', clock_in: '2026-04-26T09:00:00+08:00',
        status: 'normal',
      }),
    });
    const att = await clockOut(repo, { employee_id: 'E001', timestamp: '2026-04-26T19:00:00+08:00' });
    expect(att.overtime_hours).toBe(2);
  });

  it('跨日班:前一天 22:00 上班,今天 06:00 下班 → 找前一天的 open attendance', async () => {
    const findOpen = vi.fn().mockResolvedValue({
      id: 'A2', employee_id: 'E001', work_date: '2026-04-25',
      schedule_id: 'S2', clock_in: '2026-04-25T22:00:00+08:00',
      status: 'normal',
    });
    const repo = makeRepo({
      findOpenAttendanceForEmployee: findOpen,
      findScheduleById: vi.fn().mockResolvedValue(nightShift({ work_date: '2026-04-25' })),
    });
    const att = await clockOut(repo, { employee_id: 'E001', timestamp: '2026-04-26T06:00:00+08:00' });
    // findOpen 應該被傳入 [今天, 昨天] 兩個候選
    expect(findOpen).toHaveBeenCalledWith('E001', ['2026-04-26', '2026-04-25']);
    expect(att.work_hours).toBe(8);
  });

  it('沒 open attendance → NoOpenAttendanceError', async () => {
    const repo = makeRepo({ findOpenAttendanceForEmployee: vi.fn().mockResolvedValue(null) });
    await expect(
      clockOut(repo, { employee_id: 'E001', timestamp: '2026-04-26T18:00:00+08:00' })
    ).rejects.toBeInstanceOf(NoOpenAttendanceError);
  });
});

describe('helpers', () => {
  it('calculateLateMinutes — 基本', () => {
    expect(calculateLateMinutes('2026-04-26T09:30:00+08:00', '2026-04-26', '09:00')).toBe(30);
    expect(calculateLateMinutes('2026-04-26T08:50:00+08:00', '2026-04-26', '09:00')).toBe(0);
    expect(calculateLateMinutes('2026-04-26T09:00:00+08:00', '2026-04-26', '09:00')).toBe(0);
  });

  it('calculateLateMinutes — 跨日打卡日期不符 → 0', () => {
    // 隔日打卡(理論上不該發生 in clock_in,但防呆)
    expect(calculateLateMinutes('2026-04-27T09:30:00+08:00', '2026-04-26', '09:00')).toBe(0);
  });

  it('calculateEarlyLeaveMinutes — 普通班', () => {
    expect(calculateEarlyLeaveMinutes('2026-04-26T17:30:00+08:00', '2026-04-26', '18:00', false)).toBe(30);
    expect(calculateEarlyLeaveMinutes('2026-04-26T18:30:00+08:00', '2026-04-26', '18:00', false)).toBe(0);
  });

  it('calculateEarlyLeaveMinutes — 跨日班隔日打卡 06:00 之前', () => {
    expect(calculateEarlyLeaveMinutes('2026-04-27T05:30:00+08:00', '2026-04-26', '06:00', true)).toBe(30);
    expect(calculateEarlyLeaveMinutes('2026-04-27T06:00:00+08:00', '2026-04-26', '06:00', true)).toBe(0);
  });

  it('pickSegmentForClockIn — 落在第一段', () => {
    const segs = [
      { segment_no: 1, start_time: '09:00', end_time: '12:00' },
      { segment_no: 2, start_time: '14:00', end_time: '18:00' },
    ];
    expect(pickSegmentForClockIn(segs, '2026-04-26T10:00:00+08:00').segment_no).toBe(1);
  });
});
