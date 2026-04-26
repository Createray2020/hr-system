import { describe, it, expect, vi } from 'vitest';
import {
  calculateLeaveHours,
  submitLeaveRequest, approveLeaveRequest,
  rejectLeaveRequest, cancelLeaveRequest,
} from '../lib/leave/request-flow.js';

const SEED_LT = {
  annual:    { code:'annual',    name_zh:'特休', is_paid:true,  has_balance:true,  is_active:true },
  sick:      { code:'sick',      name_zh:'病假', is_paid:true,  has_balance:false, is_active:true },
  personal:  { code:'personal',  name_zh:'事假', is_paid:false, has_balance:false, is_active:true },
  comp:      { code:'comp',      name_zh:'補休', is_paid:true,  has_balance:true,  is_active:true },
};

function makeRepo(over = {}) {
  const _now = '2026-04-26T12:00:00.000Z';
  const repo = {
    nowIso: () => _now,
    findLeaveType: vi.fn(async (code) => SEED_LT[code] || null),
    listActiveLeaveTypes: vi.fn(async () => Object.values(SEED_LT)),
    findSchedulesInRange: vi.fn(async () => []),
    findActiveAnnualRecord: vi.fn(async () => null),
    lockAndIncrementUsedDays: vi.fn(async () => ({ ok: true, record: { id: 1 } })),
    insertBalanceLog: vi.fn(async () => ({ id: 1 })),
    insertLeaveRequest: vi.fn(async (row) => ({ ...row })),
    findLeaveRequestById: vi.fn(async () => null),
    updateLeaveRequest: vi.fn(async (id, patch) => ({ id, ...patch })),
    ...over,
  };
  return repo;
}

const dayShift = (over = {}) => ({
  id: 'S1', employee_id: 'E001', work_date: '2026-04-27',
  start_time: '09:00', end_time: '18:00',
  crosses_midnight: false, scheduled_work_minutes: 480, // 9h-1h break
  ...over,
});

describe('calculateLeaveHours', () => {
  it('整段請假涵蓋整段排班 → 8 hours(扣 break)', async () => {
    const repo = makeRepo({ findSchedulesInRange: vi.fn(async () => [dayShift()]) });
    const h = await calculateLeaveHours(repo, {
      employee_id: 'E001',
      start_at: '2026-04-27T09:00:00+08:00',
      end_at:   '2026-04-27T18:00:00+08:00',
    });
    expect(h).toBe(8);
  });

  it('半天請假(9-13)→ 4 hours(按比例扣 break)', async () => {
    const repo = makeRepo({ findSchedulesInRange: vi.fn(async () => [dayShift()]) });
    const h = await calculateLeaveHours(repo, {
      employee_id: 'E001',
      start_at: '2026-04-27T09:00:00+08:00',
      end_at:   '2026-04-27T13:00:00+08:00',
    });
    // 4h overlap × (480/540) ratio ≈ 3.555 → round 0.5 = 3.5
    expect(h).toBe(3.5);
  });

  it('多段班(早+晚)各請半段 → 加總', async () => {
    const segs = [
      dayShift({ id:'S1', start_time:'09:00', end_time:'12:00', scheduled_work_minutes: 180 }),
      dayShift({ id:'S2', start_time:'14:00', end_time:'18:00', scheduled_work_minutes: 240 }),
    ];
    const repo = makeRepo({ findSchedulesInRange: vi.fn(async () => segs) });
    const h = await calculateLeaveHours(repo, {
      employee_id: 'E001',
      start_at: '2026-04-27T09:00:00+08:00',
      end_at:   '2026-04-27T18:00:00+08:00',
    });
    // S1 全段 180min + S2 全段 240min = 420 min = 7 hours
    expect(h).toBe(7);
  });

  it('沒排班 → 0 hours', async () => {
    const h = await calculateLeaveHours(makeRepo(), {
      employee_id: 'E001',
      start_at: '2026-04-27T09:00:00+08:00',
      end_at:   '2026-04-27T18:00:00+08:00',
    });
    expect(h).toBe(0);
  });

  it('end_at <= start_at → throw', async () => {
    await expect(calculateLeaveHours(makeRepo(), {
      employee_id: 'E001',
      start_at: '2026-04-27T18:00:00+08:00',
      end_at:   '2026-04-27T09:00:00+08:00',
    })).rejects.toThrow();
  });
});

describe('submitLeaveRequest', () => {
  it('annual + 餘額足夠 → 建立 pending', async () => {
    const repo = makeRepo({
      findSchedulesInRange: vi.fn(async () => [dayShift()]),
      findActiveAnnualRecord: vi.fn(async () => ({ id: 1, granted_days: 14, used_days: 0 })),
    });
    const r = await submitLeaveRequest(repo, {
      employee_id: 'E001', leave_type: 'annual',
      start_at: '2026-04-27T09:00:00+08:00',
      end_at:   '2026-04-27T18:00:00+08:00',
      reason: '出國',
    });
    expect(r.ok).toBe(true);
    expect(r.request.status).toBe('pending');
    expect(r.request.hours).toBe(8);
    expect(r.request.finalized_hours).toBe(null);
    expect(r.request.days).toBe(1); // legacy 欄位
  });

  it('annual + 餘額不足 → ok:false INSUFFICIENT_BALANCE', async () => {
    const repo = makeRepo({
      findSchedulesInRange: vi.fn(async () => [dayShift()]),
      findActiveAnnualRecord: vi.fn(async () => ({ id: 1, granted_days: 0.5, used_days: 0 })),
    });
    const r = await submitLeaveRequest(repo, {
      employee_id: 'E001', leave_type: 'annual',
      start_at: '2026-04-27T09:00:00+08:00',
      end_at:   '2026-04-27T18:00:00+08:00',
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('INSUFFICIENT_BALANCE');
  });

  it('annual + 沒 active record → NO_ACTIVE_ANNUAL_RECORD', async () => {
    const repo = makeRepo({
      findSchedulesInRange: vi.fn(async () => [dayShift()]),
    });
    const r = await submitLeaveRequest(repo, {
      employee_id: 'E001', leave_type: 'annual',
      start_at: '2026-04-27T09:00:00+08:00',
      end_at:   '2026-04-27T18:00:00+08:00',
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('NO_ACTIVE_ANNUAL_RECORD');
  });

  it('personal(不扣餘額)→ 不檢查 annual record,直接建', async () => {
    const repo = makeRepo({
      findSchedulesInRange: vi.fn(async () => [dayShift()]),
    });
    const r = await submitLeaveRequest(repo, {
      employee_id: 'E001', leave_type: 'personal',
      start_at: '2026-04-27T09:00:00+08:00',
      end_at:   '2026-04-27T18:00:00+08:00',
    });
    expect(r.ok).toBe(true);
    expect(repo.findActiveAnnualRecord).not.toHaveBeenCalled();
  });

  it('comp + 餘額足夠 → 建 pending', async () => {
    const repo = makeRepo({
      findSchedulesInRange: vi.fn(async () => [dayShift()]),
      findActiveCompBalances: vi.fn(async () => [
        { id: 1, earned_hours: 10, used_hours: 0, expires_at: '2026-12-31', earned_at: '2026-01-01T00:00:00Z' },
      ]),
    });
    const r = await submitLeaveRequest(repo, {
      employee_id: 'E001', leave_type: 'comp',
      start_at: '2026-04-27T09:00:00+08:00',
      end_at:   '2026-04-27T18:00:00+08:00',
    });
    expect(r.ok).toBe(true);
    expect(r.request.leave_type).toBe('comp');
  });

  it('comp + 餘額不足 → INSUFFICIENT_COMP_BALANCE', async () => {
    const repo = makeRepo({
      findSchedulesInRange: vi.fn(async () => [dayShift()]),
      findActiveCompBalances: vi.fn(async () => [
        { id: 1, earned_hours: 4, used_hours: 0, expires_at: '2026-12-31', earned_at: '2026-01-01T00:00:00Z' },
      ]),
    });
    const r = await submitLeaveRequest(repo, {
      employee_id: 'E001', leave_type: 'comp',
      start_at: '2026-04-27T09:00:00+08:00',
      end_at:   '2026-04-27T18:00:00+08:00',
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('INSUFFICIENT_COMP_BALANCE');
  });

  it('未知 leave_type → throw', async () => {
    await expect(submitLeaveRequest(makeRepo(), {
      employee_id: 'E001', leave_type: 'NOPE',
      start_at: '2026-04-27T09:00:00+08:00',
      end_at:   '2026-04-27T18:00:00+08:00',
    })).rejects.toThrow(/leave_type/);
  });
});

describe('approveLeaveRequest', () => {
  it('annual:重算時數,扣餘額,寫 finalized_hours', async () => {
    const req = {
      id: 'L1', employee_id: 'E001', leave_type: 'annual',
      start_at: '2026-04-27T09:00:00+08:00', end_at: '2026-04-27T18:00:00+08:00',
      hours: 8, finalized_hours: null, status: 'pending',
    };
    const repo = makeRepo({
      findLeaveRequestById: vi.fn(async () => req),
      findSchedulesInRange: vi.fn(async () => [dayShift()]),
      findActiveAnnualRecord: vi.fn(async () => ({ id: 1, granted_days: 14, used_days: 0 })),
    });
    const r = await approveLeaveRequest(repo, { request_id: 'L1', approved_by: 'M001' });
    expect(r.ok).toBe(true);
    expect(repo.lockAndIncrementUsedDays).toHaveBeenCalledWith({
      record_id: 1, delta_days: 1, allow_negative: false,
    });
    expect(repo.updateLeaveRequest).toHaveBeenCalled();
    const patch = repo.updateLeaveRequest.mock.calls[0][1];
    expect(patch.status).toBe('approved');
    expect(patch.finalized_hours).toBe(8);
  });

  it('comp:扣 comp_time_balance(FIFO),不扣 annual', async () => {
    const req = {
      id: 'L2', employee_id: 'E001', leave_type: 'comp',
      start_at: '2026-04-27T09:00:00+08:00', end_at: '2026-04-27T18:00:00+08:00',
      hours: 8, finalized_hours: null, status: 'pending',
    };
    const repo = makeRepo({
      findLeaveRequestById: vi.fn(async () => req),
      findSchedulesInRange: vi.fn(async () => [dayShift()]),
      findActiveCompBalances: vi.fn(async () => [
        { id: 1, earned_hours: 10, used_hours: 0, expires_at: '2026-12-31', earned_at: '2026-01-01T00:00:00Z' },
      ]),
      lockAndIncrementCompUsedHours: vi.fn(async () => ({ ok: true, record: { id: 1 } })),
    });
    const r = await approveLeaveRequest(repo, { request_id: 'L2', approved_by: 'M001' });
    expect(r.ok).toBe(true);
    expect(repo.lockAndIncrementUsedDays).not.toHaveBeenCalled(); // 不扣 annual
    expect(repo.lockAndIncrementCompUsedHours).toHaveBeenCalledWith({
      comp_id: 1, delta_hours: 8, allow_negative: false,
    });
    expect(repo.updateLeaveRequest.mock.calls[0][1].status).toBe('approved');
  });

  it('comp:跨多筆 FIFO 扣餘額(8h 跨兩筆 5+5)', async () => {
    const req = {
      id: 'L3', employee_id: 'E001', leave_type: 'comp',
      start_at: '2026-04-27T09:00:00+08:00', end_at: '2026-04-27T18:00:00+08:00',
      hours: 8, finalized_hours: null, status: 'pending',
    };
    const repo = makeRepo({
      findLeaveRequestById: vi.fn(async () => req),
      findSchedulesInRange: vi.fn(async () => [dayShift()]),
      findActiveCompBalances: vi.fn(async () => [
        { id: 10, earned_hours: 5, used_hours: 0, expires_at: '2026-06-30', earned_at: '2025-06-30T00:00:00Z' },
        { id: 11, earned_hours: 5, used_hours: 0, expires_at: '2026-12-31', earned_at: '2025-12-31T00:00:00Z' },
      ]),
      lockAndIncrementCompUsedHours: vi.fn(async () => ({ ok: true })),
    });
    const r = await approveLeaveRequest(repo, { request_id: 'L3', approved_by: 'M001' });
    expect(r.ok).toBe(true);
    // 第一筆扣 5h(全扣完),第二筆扣 3h
    expect(repo.lockAndIncrementCompUsedHours).toHaveBeenCalledTimes(2);
    expect(repo.lockAndIncrementCompUsedHours.mock.calls[0][0]).toEqual({
      comp_id: 10, delta_hours: 5, allow_negative: false,
    });
    expect(repo.lockAndIncrementCompUsedHours.mock.calls[1][0]).toEqual({
      comp_id: 11, delta_hours: 3, allow_negative: false,
    });
  });

  it('NOT_FOUND → 拒絕', async () => {
    const r = await approveLeaveRequest(makeRepo(), { request_id: 'L99', approved_by: 'HR1' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('NOT_FOUND');
  });

  it('已 approved 的不能再 approve', async () => {
    const repo = makeRepo({
      findLeaveRequestById: vi.fn(async () => ({ id: 'L1', status: 'approved', leave_type: 'annual' })),
    });
    const r = await approveLeaveRequest(repo, { request_id: 'L1', approved_by: 'HR1' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('NOT_PENDING');
  });
});

describe('rejectLeaveRequest', () => {
  it('reason 必填', async () => {
    const repo = makeRepo({
      findLeaveRequestById: vi.fn(async () => ({ id:'L1', status:'pending', leave_type:'annual' })),
    });
    const r = await rejectLeaveRequest(repo, { request_id: 'L1', rejected_by: 'HR1', reject_reason: '' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('REJECT_REASON_REQUIRED');
  });

  it('成功駁回 → status=rejected,不扣餘額', async () => {
    const repo = makeRepo({
      findLeaveRequestById: vi.fn(async () => ({ id:'L1', status:'pending', leave_type:'annual' })),
    });
    const r = await rejectLeaveRequest(repo, {
      request_id: 'L1', rejected_by: 'HR1', reject_reason: '資料不全',
    });
    expect(r.ok).toBe(true);
    expect(repo.updateLeaveRequest.mock.calls[0][1].status).toBe('rejected');
    expect(repo.lockAndIncrementUsedDays).not.toHaveBeenCalled();
  });
});

describe('cancelLeaveRequest', () => {
  it('本人 + pending → 撤回成功', async () => {
    const repo = makeRepo({
      findLeaveRequestById: vi.fn(async () => ({ id:'L1', employee_id:'E001', status:'pending' })),
    });
    const r = await cancelLeaveRequest(repo, { request_id: 'L1', cancelled_by: 'E001' });
    expect(r.ok).toBe(true);
    expect(repo.updateLeaveRequest.mock.calls[0][1].status).toBe('cancelled');
  });

  it('approved 之後不能撤回', async () => {
    const repo = makeRepo({
      findLeaveRequestById: vi.fn(async () => ({ id:'L1', employee_id:'E001', status:'approved' })),
    });
    const r = await cancelLeaveRequest(repo, { request_id: 'L1', cancelled_by: 'E001' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('NOT_PENDING');
  });

  it('別人不能撤本人的假', async () => {
    const repo = makeRepo({
      findLeaveRequestById: vi.fn(async () => ({ id:'L1', employee_id:'E001', status:'pending' })),
    });
    const r = await cancelLeaveRequest(repo, { request_id: 'L1', cancelled_by: 'E999' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('NOT_OWN_REQUEST');
  });
});
