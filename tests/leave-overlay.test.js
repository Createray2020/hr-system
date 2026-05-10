// tests/leave-overlay.test.js — lib/leave/overlay.js 純函式
//
// 抓 schedule / attendance API 顯示層 leave 覆蓋的行為。
// cron-absence-detection (lib/attendance/absence-sweep.js) 不在本檔範圍。

import { describe, it, expect } from 'vitest';
import {
  leaveCoversDate,
  findOverlayForRow,
  applyLeaveOverlay,
  buildVirtualLeaveAttendance,
} from '../lib/leave/overlay.js';

const SICK = {
  id: 1, employee_id: 'E001', leave_type: 'sick',
  start_at: '2026-05-15T00:00:00+08:00',
  end_at:   '2026-05-15T23:59:59+08:00',
  status: 'approved', hours: 8, finalized_hours: 8,
};
const ANNUAL_4DAY = {
  id: 2, employee_id: 'E001', leave_type: 'annual',
  start_at: '2026-05-15T00:00:00+08:00',
  end_at:   '2026-05-18T23:59:59+08:00',
  status: 'approved', hours: 32, finalized_hours: 32,
};
const HALF_PERSONAL = {
  id: 3, employee_id: 'E001', leave_type: 'personal',
  start_at: '2026-05-20T13:00:00+08:00',
  end_at:   '2026-05-20T17:00:00+08:00',
  status: 'approved', hours: 4, finalized_hours: 4,
};
const PENDING = {
  id: 4, employee_id: 'E001', leave_type: 'sick',
  start_at: '2026-05-15T00:00:00+08:00', end_at: '2026-05-15T23:59:59+08:00',
  status: 'pending_mgr', hours: 8,
};
const NAME_MAP = { sick: '病假', annual: '特休', personal: '事假' };

describe('leaveCoversDate', () => {
  it('approved + 同日 → true', () => {
    expect(leaveCoversDate(SICK, '2026-05-15')).toBe(true);
  });
  it('approved + 跨日(4 天)中間每天都 cover', () => {
    expect(leaveCoversDate(ANNUAL_4DAY, '2026-05-15')).toBe(true);
    expect(leaveCoversDate(ANNUAL_4DAY, '2026-05-16')).toBe(true);
    expect(leaveCoversDate(ANNUAL_4DAY, '2026-05-17')).toBe(true);
    expect(leaveCoversDate(ANNUAL_4DAY, '2026-05-18')).toBe(true);
    expect(leaveCoversDate(ANNUAL_4DAY, '2026-05-19')).toBe(false);
    expect(leaveCoversDate(ANNUAL_4DAY, '2026-05-14')).toBe(false);
  });
  it('pending / rejected status → false', () => {
    expect(leaveCoversDate(PENDING, '2026-05-15')).toBe(false);
  });
  it('null / undefined / 缺欄位 → false 不爆', () => {
    expect(leaveCoversDate(null, '2026-05-15')).toBe(false);
    expect(leaveCoversDate(SICK, null)).toBe(false);
    expect(leaveCoversDate({ status: 'approved' }, '2026-05-15')).toBe(false);
  });
});

describe('findOverlayForRow', () => {
  const row = { employee_id: 'E001', work_date: '2026-05-15' };

  it('全日請假 → is_full_day=true、overlay_label_short="全日請假"', () => {
    const o = findOverlayForRow(row, [SICK], NAME_MAP);
    expect(o).toEqual({
      leave_request_id: 1,
      leave_type:       'sick',
      leave_name:       '病假',
      hours:            8,
      is_full_day:      true,
      overlay_label_short: '全日請假',
    });
  });
  it('半天請假 → is_full_day=false、overlay_label_short 含 hours (Phase 1.3)', () => {
    const halfRow = { employee_id: 'E001', work_date: '2026-05-20' };
    const o = findOverlayForRow(halfRow, [HALF_PERSONAL], NAME_MAP);
    expect(o.hours).toBe(4);
    expect(o.is_full_day).toBe(false);
    expect(o.leave_name).toBe('事假');
    expect(o.overlay_label_short).toBe('半日請假 (4h)');
  });
  it('半天 hours=2 → overlay_label_short = "半日請假 (2h)"', () => {
    const leave = { ...HALF_PERSONAL, hours: 2, finalized_hours: 2 };
    const o = findOverlayForRow({ employee_id: 'E001', work_date: '2026-05-20' }, [leave], NAME_MAP);
    expect(o.overlay_label_short).toBe('半日請假 (2h)');
    expect(o.is_full_day).toBe(false);
  });
  it('沒 leave_type name map → fallback 用 code', () => {
    const o = findOverlayForRow(row, [SICK], {});
    expect(o.leave_name).toBe('sick');
  });
  it('row 不在任何 leave 範圍 → null', () => {
    const o = findOverlayForRow({ employee_id: 'E001', work_date: '2026-06-01' }, [SICK], NAME_MAP);
    expect(o).toBeNull();
  });
  it('別的員工的 leave → null', () => {
    const o = findOverlayForRow({ employee_id: 'E002', work_date: '2026-05-15' }, [SICK], NAME_MAP);
    expect(o).toBeNull();
  });
  it('null/undefined 寬容', () => {
    expect(findOverlayForRow(null, [SICK], NAME_MAP)).toBeNull();
    expect(findOverlayForRow({}, [SICK], NAME_MAP)).toBeNull();
    expect(findOverlayForRow(row, null, NAME_MAP)).toBeNull();
    expect(findOverlayForRow(row, [], NAME_MAP)).toBeNull();
  });
  it('finalized_hours 優先於 hours', () => {
    const leave = { ...SICK, hours: 8, finalized_hours: 4 };
    const o = findOverlayForRow(row, [leave], NAME_MAP);
    expect(o.hours).toBe(4);
    expect(o.is_full_day).toBe(false);
  });
});

describe('applyLeaveOverlay', () => {
  const schedules = [
    { id: 'S1', employee_id: 'E001', work_date: '2026-05-15', shift_types: { name: '早班' } },
    { id: 'S2', employee_id: 'E001', work_date: '2026-05-16', shift_types: { name: '早班' } },
    { id: 'S3', employee_id: 'E002', work_date: '2026-05-15', shift_types: { name: '晚班' } },
  ];

  it('每個 row 都加 leave_overlay 欄位 (有 leave 物件 / 沒 null)', () => {
    const r = applyLeaveOverlay(schedules, [SICK], NAME_MAP);
    expect(r).toHaveLength(3);
    expect(r[0].leave_overlay?.leave_type).toBe('sick');     // E001 5/15
    expect(r[1].leave_overlay).toBeNull();                    // E001 5/16 沒 leave
    expect(r[2].leave_overlay).toBeNull();                    // E002 5/15 (別人的 leave)
  });
  it('原 row 欄位保留 (shift_types 等)', () => {
    const r = applyLeaveOverlay(schedules, [SICK], NAME_MAP);
    expect(r[0].id).toBe('S1');
    expect(r[0].shift_types.name).toBe('早班');
  });
  it('跨日 leave 每天都 attach overlay', () => {
    const r = applyLeaveOverlay(schedules, [ANNUAL_4DAY], NAME_MAP);
    expect(r[0].leave_overlay?.leave_type).toBe('annual');
    expect(r[1].leave_overlay?.leave_type).toBe('annual');
  });
  it('null/empty 寬容', () => {
    expect(applyLeaveOverlay(null, [SICK])).toEqual([]);
    expect(applyLeaveOverlay([], [SICK])).toEqual([]);
    const r = applyLeaveOverlay(schedules, null);
    expect(r).toHaveLength(3);
    r.forEach(x => expect(x.leave_overlay).toBeNull());
  });

  // ── 階段 B1 Task 3:post-hoc leave detection ──────────────
  it('attendance row 有 clock_in + 該日有 leave → post_hoc_leave=true', async () => {
    const att = [
      { id:'A1', employee_id:'E001', work_date:'2026-05-15', clock_in:'2026-05-15T01:00:00Z', segment_no:1 },
    ];
    const r = applyLeaveOverlay(att, [SICK], NAME_MAP);
    expect(r[0].post_hoc_leave).toBe(true);
    expect(r[0].leave_overlay?.leave_type).toBe('sick');
  });
  it('attendance row 沒 clock_in (還沒打) + 該日有 leave → post_hoc_leave=false', async () => {
    const att = [
      { id:'A1', employee_id:'E001', work_date:'2026-05-15', clock_in:null, segment_no:1 },
    ];
    const r = applyLeaveOverlay(att, [SICK], NAME_MAP);
    expect(r[0].post_hoc_leave).toBe(false);
    expect(r[0].leave_overlay?.leave_type).toBe('sick');  // overlay 仍標
  });
  it('attendance row 有 clock_in 但該日無 leave → post_hoc_leave=false', async () => {
    const att = [
      { id:'A1', employee_id:'E001', work_date:'2026-06-01', clock_in:'2026-06-01T01:00:00Z', segment_no:1 },
    ];
    const r = applyLeaveOverlay(att, [SICK], NAME_MAP);
    expect(r[0].post_hoc_leave).toBe(false);
    expect(r[0].leave_overlay).toBeNull();
  });
  it('schedule row (沒 clock_in 欄位) → post_hoc_leave 永遠 false (即使有 leave)', async () => {
    const sched = [{ id:'S1', employee_id:'E001', work_date:'2026-05-15', shift_types:{ name:'早班' } }];
    const r = applyLeaveOverlay(sched, [SICK], NAME_MAP);
    expect(r[0].post_hoc_leave).toBe(false);
    expect(r[0].leave_overlay?.leave_type).toBe('sick');
  });
});

describe('buildVirtualLeaveAttendance', () => {
  const schedules = [
    { id: 'SCH1', employee_id: 'E001', work_date: '2026-05-15', segment_no: 1 },
    { id: 'SCH2', employee_id: 'E001', work_date: '2026-05-16', segment_no: 1 },
  ];

  it('該日 attendance 沒 row + 有 leave → 補 virtual row、status=leave、is_virtual=true', () => {
    const att = [];  // attendance 完全沒 row
    const v = buildVirtualLeaveAttendance(att, schedules, [SICK], NAME_MAP);
    expect(v).toHaveLength(1);  // 只有 5/15 有 leave
    expect(v[0].employee_id).toBe('E001');
    expect(v[0].work_date).toBe('2026-05-15');
    expect(v[0].status).toBe('leave');
    expect(v[0].is_virtual).toBe(true);
    expect(v[0].leave_overlay?.leave_type).toBe('sick');
    expect(v[0].id).toMatch(/^V_E001_20260515/);
  });
  it('該日 attendance 已有 row → 不補(避免重複)、由 applyLeaveOverlay 加 overlay 處理', () => {
    const att = [{ id: 'A1', employee_id: 'E001', work_date: '2026-05-15', segment_no: 1, status: 'leave' }];
    const v = buildVirtualLeaveAttendance(att, schedules, [SICK], NAME_MAP);
    expect(v).toHaveLength(0);
  });
  it('跨日 leave (4 天) → 補 4 個 virtual row(假設 schedule 都有對應)', () => {
    const fourDaySchedules = [
      { id: 'X1', employee_id: 'E001', work_date: '2026-05-15', segment_no: 1 },
      { id: 'X2', employee_id: 'E001', work_date: '2026-05-16', segment_no: 1 },
      { id: 'X3', employee_id: 'E001', work_date: '2026-05-17', segment_no: 1 },
      { id: 'X4', employee_id: 'E001', work_date: '2026-05-18', segment_no: 1 },
    ];
    const v = buildVirtualLeaveAttendance([], fourDaySchedules, [ANNUAL_4DAY], NAME_MAP);
    expect(v).toHaveLength(4);
    expect(v.map(r => r.work_date)).toEqual(['2026-05-15','2026-05-16','2026-05-17','2026-05-18']);
  });
  it('null/empty 寬容', () => {
    expect(buildVirtualLeaveAttendance(null, null, null)).toEqual([]);
    expect(buildVirtualLeaveAttendance([], [], [])).toEqual([]);
  });
});
