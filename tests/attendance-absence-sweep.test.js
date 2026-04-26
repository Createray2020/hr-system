import { describe, it, expect, vi } from 'vitest';
import { runAbsenceSweep } from '../lib/attendance/absence-sweep.js';

function makeRepo(over = {}) {
  return {
    findLockedSchedulesByDate: vi.fn().mockResolvedValue([]),
    findAttendanceByDateSegment: vi.fn().mockResolvedValue(null),
    findApprovedLeaveCovering: vi.fn().mockResolvedValue(null),
    getEmployeeManager: vi.fn().mockResolvedValue({ id: 'E001', manager_id: 'M001' }),
    upsertAttendance: vi.fn(async row => ({ ...row })),
    notifyAbsence: vi.fn(async () => ({ ok: true })),
    ...over,
  };
}

const sched = (over = {}) => ({
  id: 'S1', employee_id: 'E001', segment_no: 1, period_id: 'p1', ...over,
});

describe('runAbsenceSweep — basic', () => {
  it('要 today,沒給時拒絕', async () => {
    await expect(runAbsenceSweep(makeRepo(), null)).rejects.toThrow(/today/);
  });

  it('掃昨日(today-1):today=2026-04-26 → swept_date=2026-04-25', async () => {
    const repo = makeRepo();
    const r = await runAbsenceSweep(repo, '2026-04-26');
    expect(r.swept_date).toBe('2026-04-25');
    expect(repo.findLockedSchedulesByDate).toHaveBeenCalledWith('2026-04-25');
  });

  it('沒 locked schedules → 全部 0', async () => {
    const r = await runAbsenceSweep(makeRepo(), '2026-04-26');
    expect(r).toMatchObject({ absent_count: 0, leave_count: 0, normal_count: 0 });
  });

  it('repo 缺 method 拒絕', async () => {
    await expect(runAbsenceSweep({}, '2026-04-26')).rejects.toThrow(/findLockedSchedulesByDate/);
  });
});

describe('runAbsenceSweep — 三種 case', () => {
  it('已打卡(有 clock_in)→ normal_count++,不寫 attendance,不通知', async () => {
    const repo = makeRepo({
      findLockedSchedulesByDate: vi.fn().mockResolvedValue([sched()]),
      findAttendanceByDateSegment: vi.fn().mockResolvedValue({
        id: 'A1', clock_in: '2026-04-25T09:00:00+08:00',
      }),
    });
    const r = await runAbsenceSweep(repo, '2026-04-26');
    expect(r).toMatchObject({ absent_count: 0, leave_count: 0, normal_count: 1 });
    expect(repo.upsertAttendance).not.toHaveBeenCalled();
    expect(repo.notifyAbsence).not.toHaveBeenCalled();
  });

  it('沒打卡 + 有 approved leave → leave_count++,寫 status=leave,不通知', async () => {
    const repo = makeRepo({
      findLockedSchedulesByDate: vi.fn().mockResolvedValue([sched()]),
      findApprovedLeaveCovering: vi.fn().mockResolvedValue({ id: 'L1', leave_type: 'sick' }),
    });
    const r = await runAbsenceSweep(repo, '2026-04-26');
    expect(r).toMatchObject({ absent_count: 0, leave_count: 1, normal_count: 0 });
    expect(repo.upsertAttendance).toHaveBeenCalledTimes(1);
    expect(repo.upsertAttendance.mock.calls[0][0]).toMatchObject({
      status: 'leave', is_anomaly: false, employee_id: 'E001', work_date: '2026-04-25',
    });
    expect(repo.notifyAbsence).not.toHaveBeenCalled();
  });

  it('沒打卡 + 沒請假 → absent_count++,寫 status=absent + is_anomaly=false,觸發通知', async () => {
    const repo = makeRepo({
      findLockedSchedulesByDate: vi.fn().mockResolvedValue([sched()]),
    });
    const r = await runAbsenceSweep(repo, '2026-04-26');
    expect(r).toMatchObject({ absent_count: 1, leave_count: 0, normal_count: 0 });
    expect(repo.upsertAttendance.mock.calls[0][0]).toMatchObject({
      status: 'absent', is_anomaly: false, employee_id: 'E001',
      schedule_id: 'S1', segment_no: 1, work_date: '2026-04-25',
    });
    expect(repo.notifyAbsence).toHaveBeenCalledTimes(1);
    expect(repo.notifyAbsence.mock.calls[0][0]).toMatchObject({
      employee_id: 'E001', manager_id: 'M001', work_date: '2026-04-25', segment_no: 1,
    });
  });

  it('attendance 已存在但無 clock_in → 視為未打卡(可能上班卡漏)→ absent', async () => {
    const repo = makeRepo({
      findLockedSchedulesByDate: vi.fn().mockResolvedValue([sched()]),
      findAttendanceByDateSegment: vi.fn().mockResolvedValue({
        id: 'A1', clock_in: null, clock_out: null,
      }),
    });
    const r = await runAbsenceSweep(repo, '2026-04-26');
    expect(r.absent_count).toBe(1);
    // 應該 reuse 既有 id（避免 INSERT 衝突）
    expect(repo.upsertAttendance.mock.calls[0][0].id).toBe('A1');
  });
});

describe('runAbsenceSweep — 多段班', () => {
  it('員工某天兩段班,一段有打卡一段沒 → normal+absent 各 1', async () => {
    const seg1 = sched({ id: 'S1', segment_no: 1 });
    const seg2 = sched({ id: 'S2', segment_no: 2 });
    const repo = makeRepo({
      findLockedSchedulesByDate: vi.fn().mockResolvedValue([seg1, seg2]),
      findAttendanceByDateSegment: vi.fn().mockImplementation(async (emp, d, segNo) => {
        if (segNo === 1) return { id: 'A1', clock_in: '2026-04-25T09:00:00+08:00' };
        return null;
      }),
    });
    const r = await runAbsenceSweep(repo, '2026-04-26');
    expect(r).toMatchObject({ absent_count: 1, leave_count: 0, normal_count: 1 });
    expect(repo.notifyAbsence).toHaveBeenCalledTimes(1);
    expect(repo.notifyAbsence.mock.calls[0][0].segment_no).toBe(2);
  });
});
