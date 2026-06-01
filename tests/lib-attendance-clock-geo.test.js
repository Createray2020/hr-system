// tests/lib-attendance-clock-geo.test.js — GPS Phase A:clockIn / clockOut 接 geo
//
// 對齊既有 attendance-clock.test.js mock pattern。

import { describe, it, expect, vi } from 'vitest';
import { clockIn, clockOut } from '../lib/attendance/clock.js';

function dayShift(over = {}) {
  return {
    id: 'S1', employee_id: 'E001', work_date: '2026-04-26', period_id: 'p1',
    segment_no: 1,
    start_time: '09:00', end_time: '18:00',
    crosses_midnight: false, scheduled_work_minutes: 480,
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
    findApprovedOvertimeRequestByDate: vi.fn().mockResolvedValue(null),
    upsertAttendance: vi.fn(async row => ({ ...row })),
    updateAttendance: vi.fn(async (id, patch) => ({ id, ...patch })),
    findActiveOfficeLocations: vi.fn(async () => []),
    ...over,
  };
}

// HQ 在台北 101、radius=150
const HQ = { id: 'LOC_HQ', lat: 25.0339, lng: 121.5645, radius_m: 150 };

// ════════════════════════════════════════════════════════════
// clockIn / GPS 三態
// ════════════════════════════════════════════════════════════
describe('clockIn — GPS Phase A', () => {
  it('A. 不傳 geo → row 不含任何 GPS 欄位(向後相容)', async () => {
    const repo = makeRepo();
    const att = await clockIn(repo, {
      employee_id: 'E001', timestamp: '2026-04-26T09:00:00+08:00',
    });
    // 既有非 GPS 行為不變
    expect(att.status).toBe('normal');
    // GPS 欄位不該出現在 row 上(undefined、不是 null)
    expect(att.clock_in_lat).toBeUndefined();
    expect(att.clock_in_lng).toBeUndefined();
    expect(att.clock_in_distance_m).toBeUndefined();
    expect(att.clock_in_location_id).toBeUndefined();
    expect(att.gps_flag).toBeUndefined();
    // findActiveOfficeLocations 不該被呼叫(geo undefined 時不撈)
    expect(repo.findActiveOfficeLocations).not.toHaveBeenCalled();
  });

  it('B. geo=null → gps_flag=denied、座標全 NULL', async () => {
    const repo = makeRepo();
    const att = await clockIn(repo, {
      employee_id: 'E001', timestamp: '2026-04-26T09:00:00+08:00',
      geo: null,
    });
    expect(att.gps_flag).toBe('denied');
    expect(att.clock_in_lat).toBeNull();
    expect(att.clock_in_lng).toBeNull();
    expect(att.clock_in_accuracy).toBeNull();
    expect(att.clock_in_distance_m).toBeNull();
    expect(att.clock_in_location_id).toBeNull();
  });

  it('C. geo 在 HQ radius 內 + locations 從 repo 撈 → flag=null + location_id 對', async () => {
    const repo = makeRepo({
      findActiveOfficeLocations: vi.fn(async () => [HQ]),
    });
    const att = await clockIn(repo, {
      employee_id: 'E001', timestamp: '2026-04-26T09:00:00+08:00',
      geo: { lat: HQ.lat, lng: HQ.lng, accuracy: 15 },
      // 沒傳 locations、lib 自己撈
    });
    expect(repo.findActiveOfficeLocations).toHaveBeenCalledTimes(1);
    expect(att.gps_flag).toBeNull();
    expect(att.clock_in_location_id).toBe('LOC_HQ');
    expect(att.clock_in_lat).toBe(HQ.lat);
    expect(att.clock_in_lng).toBe(HQ.lng);
    expect(att.clock_in_accuracy).toBe(15);
    expect(att.clock_in_distance_m).toBeGreaterThanOrEqual(0);
    expect(att.clock_in_distance_m).toBeLessThan(150);
  });

  it('D. 距 HQ 200m、HQ.radius=150 → flag=outside', async () => {
    const repo = makeRepo();
    const att = await clockIn(repo, {
      employee_id: 'E001', timestamp: '2026-04-26T09:00:00+08:00',
      geo: { lat: HQ.lat + 0.0018, lng: HQ.lng, accuracy: 20 },
      locations: [HQ],  // 直接傳、lib 不該再撈
    });
    expect(repo.findActiveOfficeLocations).not.toHaveBeenCalled();
    expect(att.gps_flag).toBe('outside');
    expect(att.clock_in_location_id).toBe('LOC_HQ');
    expect(att.clock_in_distance_m).toBeGreaterThan(150);
  });

  it('E. accuracy=200(超 100 threshold)→ flag=low_accuracy(優先級高於 outside)', async () => {
    const repo = makeRepo();
    const att = await clockIn(repo, {
      employee_id: 'E001', timestamp: '2026-04-26T09:00:00+08:00',
      geo: { lat: HQ.lat, lng: HQ.lng, accuracy: 200 },
      locations: [HQ],
    });
    expect(att.gps_flag).toBe('low_accuracy');
    expect(att.clock_in_location_id).toBe('LOC_HQ');  // 仍填 location_id 給 audit
  });

  it('F. locations 空 → flag=outside(沒據點可比)', async () => {
    const repo = makeRepo();
    const att = await clockIn(repo, {
      employee_id: 'E001', timestamp: '2026-04-26T09:00:00+08:00',
      geo: { lat: 25.0, lng: 121.5, accuracy: 20 },
      locations: [],
    });
    expect(att.gps_flag).toBe('outside');
    expect(att.clock_in_location_id).toBeNull();
    expect(att.clock_in_distance_m).toBeNull();
  });

  it('G. repo 沒實作 findActiveOfficeLocations → fallback 視為空、flag=outside', async () => {
    const repo = makeRepo();
    delete repo.findActiveOfficeLocations;
    const att = await clockIn(repo, {
      employee_id: 'E001', timestamp: '2026-04-26T09:00:00+08:00',
      geo: { lat: 25.0, lng: 121.5, accuracy: 20 },
      // locations undefined、repo 也沒方法 → fallback []
    });
    expect(att.gps_flag).toBe('outside');
  });
});

// ════════════════════════════════════════════════════════════
// clockOut / GPS
// ════════════════════════════════════════════════════════════
describe('clockOut — GPS Phase A', () => {
  // 模擬既有 open attendance(clockIn 已寫過、含 GPS denied)
  function openAttWithDenied(over = {}) {
    return {
      id: 'A1', employee_id: 'E001', work_date: '2026-04-26',
      schedule_id: 'S1', segment_no: 1, status: 'normal',
      clock_in: '2026-04-26T09:00:00+08:00',
      clock_out: null,
      gps_flag: 'denied',
      clock_in_lat: null, clock_in_lng: null,
      ...over,
    };
  }

  it('H. 不傳 geo → patch 不含 GPS 欄位(不覆寫既有 gps_flag)', async () => {
    const repo = makeRepo({
      findOpenAttendanceForEmployee: vi.fn().mockResolvedValue(openAttWithDenied()),
    });
    const att = await clockOut(repo, {
      employee_id: 'E001', timestamp: '2026-04-26T18:00:00+08:00',
    });
    // patch 對應的 update 沒有 gps_flag、clock_out_lat 等欄位
    expect(att.gps_flag).toBeUndefined();
    expect(att.clock_out_lat).toBeUndefined();
    expect(att.clock_out_lng).toBeUndefined();
    expect(repo.findActiveOfficeLocations).not.toHaveBeenCalled();
  });

  it('G. clockIn 已 denied、clockOut geo 正常 + 在 radius → gps_flag 覆寫成 null', async () => {
    const repo = makeRepo({
      findOpenAttendanceForEmployee: vi.fn().mockResolvedValue(openAttWithDenied()),
    });
    const att = await clockOut(repo, {
      employee_id: 'E001', timestamp: '2026-04-26T18:00:00+08:00',
      geo: { lat: HQ.lat, lng: HQ.lng, accuracy: 15 },
      locations: [HQ],
    });
    // gps_flag 覆寫(null = 在 radius 內、最近一次狀況贏)
    expect(att.gps_flag).toBeNull();
    expect(att.clock_out_lat).toBe(HQ.lat);
    expect(att.clock_out_location_id).toBe('LOC_HQ');
    expect(att.clock_out_distance_m).toBeGreaterThanOrEqual(0);
  });

  it('I. 傳 geo、locations 沒傳 → lib 自己撈 office_locations', async () => {
    const repo = makeRepo({
      findOpenAttendanceForEmployee: vi.fn().mockResolvedValue(openAttWithDenied()),
      findActiveOfficeLocations: vi.fn(async () => [HQ]),
    });
    const att = await clockOut(repo, {
      employee_id: 'E001', timestamp: '2026-04-26T18:00:00+08:00',
      geo: { lat: HQ.lat, lng: HQ.lng, accuracy: 15 },
    });
    expect(repo.findActiveOfficeLocations).toHaveBeenCalledTimes(1);
    expect(att.gps_flag).toBeNull();
    expect(att.clock_out_location_id).toBe('LOC_HQ');
  });

  it('clockOut + geo=null → gps_flag=denied、座標全 NULL(覆寫)', async () => {
    const repo = makeRepo({
      findOpenAttendanceForEmployee: vi.fn().mockResolvedValue(openAttWithDenied({
        gps_flag: null,  // 假設 clockIn 是 ok 的、clockOut 才 denied
      })),
    });
    const att = await clockOut(repo, {
      employee_id: 'E001', timestamp: '2026-04-26T18:00:00+08:00',
      geo: null,
    });
    expect(att.gps_flag).toBe('denied');
    expect(att.clock_out_lat).toBeNull();
    expect(att.clock_out_lng).toBeNull();
    expect(att.clock_out_distance_m).toBeNull();
    expect(att.clock_out_location_id).toBeNull();
  });
});
