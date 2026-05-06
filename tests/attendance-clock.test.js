import { describe, it, expect, vi } from 'vitest';
import {
  clockIn, clockOut,
  pickSegmentForClockIn, calculateLateMinutes, calculateEarlyLeaveMinutes,
  calculateEarlyArrivalMinutes,
  isoToMinutesOfDay, isoToTaipeiDateString,
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

// ─── Phase: timezone-aware helpers(修 live punch 全 early_leave bug)───
describe('isoToMinutesOfDay — 多種 timezone 形式回相同值', () => {
  // 18:09 台灣 = 10:09 UTC = 1089 wall-clock minutes
  it('UTC Z (.000Z 結尾) → Taipei wall-clock minutes', () => {
    expect(isoToMinutesOfDay('2026-05-05T10:09:00.000Z')).toBe(1089);
  });

  it('+08:00 顯式時區 → 同樣 1089', () => {
    expect(isoToMinutesOfDay('2026-05-05T18:09:00+08:00')).toBe(1089);
  });

  it('+0000 顯式 UTC(無冒號 / 4 位數)→ 同樣 1089', () => {
    // 注意:'+00' (兩位數)在 Node ISO T 形式解析為 NaN、必須用 +0000 / +00:00 / Z
    expect(isoToMinutesOfDay('2026-05-05T10:09:00.123+0000')).toBe(1089);
  });

  it('PG style 空格分隔 + +00 → 同樣 1089', () => {
    expect(isoToMinutesOfDay('2026-05-05 10:09:00+00')).toBe(1089);
  });

  it('凌晨 00:30 台灣 = 前日 16:30 UTC → 30', () => {
    expect(isoToMinutesOfDay('2026-05-05T16:30:00.000Z')).toBe(30);
  });

  it('invalid date 字串 → 0', () => {
    expect(isoToMinutesOfDay('not a date')).toBe(0);
    expect(isoToMinutesOfDay('')).toBe(0);
  });
});

describe('isoToTaipeiDateString — UTC 跨日邊界轉台灣日期', () => {
  it('UTC 16:30 → 台灣隔日 00:30、回隔日日期', () => {
    expect(isoToTaipeiDateString('2026-05-05T16:30:00.000Z')).toBe('2026-05-06');
  });

  it('UTC 15:59:59 → 台灣 23:59:59、回當日', () => {
    expect(isoToTaipeiDateString('2026-05-05T15:59:59.000Z')).toBe('2026-05-05');
  });

  it('+08:00 顯式時區 → 字串日期跟 wall-clock 一致', () => {
    expect(isoToTaipeiDateString('2026-05-05T09:00:00+08:00')).toBe('2026-05-05');
    expect(isoToTaipeiDateString('2026-05-05T23:59:00+08:00')).toBe('2026-05-05');
  });

  it('invalid date → 空字串', () => {
    expect(isoToTaipeiDateString('not a date')).toBe('');
  });
});

describe('calculateLateMinutes / EarlyLeaveMinutes — UTC ISO 輸入(live punch)', () => {
  it('calculateEarlyLeaveMinutes:18:09 台灣 UTC 形式、end=18:00 → 0(不算早退)', () => {
    // 修補前的 bug:UTC Z 抓到 10:09、跟 18:00 比、會誤算 471 分早退
    expect(calculateEarlyLeaveMinutes('2026-05-05T10:09:00.000Z', '2026-05-05', '18:00', false)).toBe(0);
  });

  it('calculateEarlyLeaveMinutes:17:30 台灣 UTC 形式、end=18:00 → 30', () => {
    expect(calculateEarlyLeaveMinutes('2026-05-05T09:30:00.000Z', '2026-05-05', '18:00', false)).toBe(30);
  });

  it('calculateLateMinutes:09:05 台灣 UTC 形式、start=09:00 → 5', () => {
    expect(calculateLateMinutes('2026-05-05T01:05:00.000Z', '2026-05-05', '09:00')).toBe(5);
  });

  it('calculateLateMinutes:08:55 台灣 UTC 形式、start=09:00 → 0(早到 max 蓋掉)', () => {
    expect(calculateLateMinutes('2026-05-05T00:55:00.000Z', '2026-05-05', '09:00')).toBe(0);
  });

  it('calculateLateMinutes:09:00 整點台灣 UTC 形式 → 0', () => {
    expect(calculateLateMinutes('2026-05-05T01:00:00.000Z', '2026-05-05', '09:00')).toBe(0);
  });

  it('calculateEarlyLeaveMinutes:跨日班、UTC 隔日 21:30 = 台灣隔日 05:30、end=06:00 → 30', () => {
    // 跨日班 work_date='2026-04-26'、隔日 5:30 台灣打卡
    expect(calculateEarlyLeaveMinutes('2026-04-26T21:30:00.000Z', '2026-04-26', '06:00', true)).toBe(30);
  });
});

// ─── early_arrival_minutes audit 欄位(純記錄、不影響 status / overtime)───
describe('calculateEarlyArrivalMinutes — 純 audit 早到分鐘', () => {
  it('準時 09:00 → 0', () => {
    expect(calculateEarlyArrivalMinutes('2026-05-05T09:00:00+08:00', '2026-05-05', '09:00')).toBe(0);
  });

  it('早到 30min(08:30、scheduled 09:00)→ 30', () => {
    expect(calculateEarlyArrivalMinutes('2026-05-05T08:30:00+08:00', '2026-05-05', '09:00')).toBe(30);
  });

  it('早到 60min(08:00、scheduled 09:00)→ 60', () => {
    expect(calculateEarlyArrivalMinutes('2026-05-05T08:00:00+08:00', '2026-05-05', '09:00')).toBe(60);
  });

  it('遲到 5min → 0(本欄位純正向、不跟 late 互補)', () => {
    expect(calculateEarlyArrivalMinutes('2026-05-05T09:05:00+08:00', '2026-05-05', '09:00')).toBe(0);
  });

  it('UTC 形式 08:30 台灣(00:30 UTC)、start=09:00 → 30', () => {
    expect(calculateEarlyArrivalMinutes('2026-05-05T00:30:00.000Z', '2026-05-05', '09:00')).toBe(30);
  });

  it('startTime 解析失敗 → 0(safe fallback)', () => {
    expect(calculateEarlyArrivalMinutes('2026-05-05T08:30:00+08:00', '2026-05-05', 'bad')).toBe(0);
  });
});

describe('clockIn — early_arrival_minutes 寫入', () => {
  it('員工 08:30 早到、scheduled 09:00 → late=0、early_arrival=30、status=normal', async () => {
    const repo = makeRepo();
    const att = await clockIn(repo, { employee_id: 'E001', timestamp: '2026-04-26T08:30:00+08:00' });
    expect(att.late_minutes).toBe(0);
    expect(att.early_arrival_minutes).toBe(30);
    expect(att.status).toBe('normal');
  });

  it('員工 09:00 準時 → late=0、early_arrival=0', async () => {
    const repo = makeRepo();
    const att = await clockIn(repo, { employee_id: 'E001', timestamp: '2026-04-26T09:00:00+08:00' });
    expect(att.late_minutes).toBe(0);
    expect(att.early_arrival_minutes).toBe(0);
  });

  it('員工 09:30 遲到 → late=30、early_arrival=0(不耦合)、status=late', async () => {
    const repo = makeRepo();
    const att = await clockIn(repo, { employee_id: 'E001', timestamp: '2026-04-26T09:30:00+08:00' });
    expect(att.late_minutes).toBe(30);
    expect(att.early_arrival_minutes).toBe(0);
    expect(att.status).toBe('late');
  });

  it('多段班員工 14:00 打第二段 → 用 segment.start_time=14:00 算 early_arrival(=0)', async () => {
    const seg1 = dayShift({ id: 'S1', segment_no: 1, start_time: '09:00', end_time: '12:00' });
    const seg2 = dayShift({ id: 'S2', segment_no: 2, start_time: '14:00', end_time: '18:00' });
    const repo = makeRepo({ findSchedulesForDate: vi.fn().mockResolvedValue([seg1, seg2]) });
    const att = await clockIn(repo, { employee_id: 'E001', timestamp: '2026-04-26T14:00:00+08:00' });
    expect(att.segment_no).toBe(2);
    expect(att.early_arrival_minutes).toBe(0);
  });
});

describe('clockOut overtime — 守護:early_arrival 不影響現有算法(Phase B 才改)', () => {
  it('08:30 早到 + 18:00 下班 → workHours=9.5、overtime=1.5(維持現況、Phase B 才改算法)', async () => {
    const repo = makeRepo({
      findOpenAttendanceForEmployee: vi.fn().mockResolvedValue({
        id: 'A1', work_date: '2026-04-26', clock_in: '2026-04-26T08:30:00+08:00',
        schedule_id: 'S1', segment_no: 1, status: 'normal',
      }),
      findScheduleById: vi.fn().mockResolvedValue(dayShift()),
    });
    const att = await clockOut(repo, { employee_id: 'E001', timestamp: '2026-04-26T18:00:00+08:00' });
    expect(att.work_hours).toBe(9.5);
    expect(att.overtime_hours).toBe(1.5);  // Phase B 待重評估、本階不動
  });
});
