import { describe, it, expect, vi } from 'vitest';
import {
  getAnnualBalance, deductAnnualLeave, refundAnnualLeave,
} from '../lib/leave/balance.js';

function makeRepo(over = {}) {
  return {
    findActiveAnnualRecord: vi.fn().mockResolvedValue(null),
    lockAndIncrementUsedDays: vi.fn().mockResolvedValue({ ok: true, record: { id: 1, used_days: 1 } }),
    insertBalanceLog: vi.fn().mockResolvedValue({ id: 100 }),
    ...over,
  };
}

const activeRec = (over = {}) => ({
  id: 1,
  employee_id: 'E001',
  period_start: '2026-04-01',
  period_end: '2027-03-31',
  legal_days: 14,
  granted_days: 14,
  used_days: 0,
  status: 'active',
  ...over,
});

describe('getAnnualBalance', () => {
  it('沒 active record → has_record:false, all 0', async () => {
    const r = await getAnnualBalance(makeRepo(), 'E001');
    expect(r.has_record).toBe(false);
    expect(r.legal_days).toBe(0);
    expect(r.remaining_days).toBe(0);
  });

  it('有 active record → 計算 remaining', async () => {
    const repo = makeRepo({
      findActiveAnnualRecord: vi.fn().mockResolvedValue(activeRec({ used_days: 3 })),
    });
    const r = await getAnnualBalance(repo, 'E001');
    expect(r.has_record).toBe(true);
    expect(r.legal_days).toBe(14);
    expect(r.granted_days).toBe(14);
    expect(r.used_days).toBe(3);
    expect(r.remaining_days).toBe(11);
  });

  it('used > granted(防呆)→ remaining 取 0', async () => {
    const repo = makeRepo({
      findActiveAnnualRecord: vi.fn().mockResolvedValue(activeRec({ used_days: 99 })),
    });
    const r = await getAnnualBalance(repo, 'E001');
    expect(r.remaining_days).toBe(0);
  });

  it('repo 缺 method → 拒絕', async () => {
    await expect(getAnnualBalance({}, 'E001')).rejects.toThrow(/findActiveAnnualRecord/);
  });

  it('缺 employee_id → 拒絕', async () => {
    await expect(getAnnualBalance(makeRepo(), null)).rejects.toThrow(/employee_id/);
  });
});

describe('deductAnnualLeave', () => {
  it('成功扣減 1 天 → log hours_delta = -8', async () => {
    const repo = makeRepo({
      findActiveAnnualRecord: vi.fn().mockResolvedValue(activeRec()),
    });
    const r = await deductAnnualLeave(repo, {
      employee_id: 'E001', days: 1, leave_request_id: 'L1', changed_by: 'HR1',
    });
    expect(r.ok).toBe(true);
    expect(repo.lockAndIncrementUsedDays).toHaveBeenCalledWith({
      record_id: 1, delta_days: 1, allow_negative: false,
    });
    expect(repo.insertBalanceLog).toHaveBeenCalled();
    const log = repo.insertBalanceLog.mock.calls[0][0];
    expect(log.balance_type).toBe('annual');
    expect(log.change_type).toBe('use');
    expect(log.hours_delta).toBe(-8); // 1 day * 8
    expect(log.annual_record_id).toBe(1);
    expect(log.leave_request_id).toBe('L1');
  });

  it('沒 active record → reason=NO_ACTIVE_RECORD,不寫 log', async () => {
    const repo = makeRepo();
    const r = await deductAnnualLeave(repo, {
      employee_id: 'E001', days: 1, changed_by: 'HR1',
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('NO_ACTIVE_RECORD');
    expect(repo.insertBalanceLog).not.toHaveBeenCalled();
  });

  it('餘額不足 → 不寫 log,回 lock 失敗 reason', async () => {
    const repo = makeRepo({
      findActiveAnnualRecord: vi.fn().mockResolvedValue(activeRec({ granted_days: 5, used_days: 4 })),
      lockAndIncrementUsedDays: vi.fn().mockResolvedValue({ ok: false, reason: 'INSUFFICIENT_BALANCE' }),
    });
    const r = await deductAnnualLeave(repo, {
      employee_id: 'E001', days: 3, changed_by: 'HR1',
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('INSUFFICIENT_BALANCE');
    expect(repo.insertBalanceLog).not.toHaveBeenCalled();
  });

  it('缺 changed_by → throw', async () => {
    await expect(deductAnnualLeave(makeRepo(), { employee_id: 'E001', days: 1 }))
      .rejects.toThrow(/changed_by/);
  });

  it('days 非正數 → throw', async () => {
    await expect(deductAnnualLeave(makeRepo(), { employee_id: 'E001', days: 0, changed_by: 'HR1' }))
      .rejects.toThrow();
    await expect(deductAnnualLeave(makeRepo(), { employee_id: 'E001', days: -1, changed_by: 'HR1' }))
      .rejects.toThrow();
  });
});

describe('refundAnnualLeave', () => {
  it('退還 0.5 天 → log hours_delta = +4', async () => {
    const repo = makeRepo({
      findActiveAnnualRecord: vi.fn().mockResolvedValue(activeRec({ used_days: 3 })),
    });
    const r = await refundAnnualLeave(repo, {
      employee_id: 'E001', days: 0.5, leave_request_id: 'L1', changed_by: 'HR1',
    });
    expect(r.ok).toBe(true);
    const log = repo.insertBalanceLog.mock.calls[0][0];
    expect(log.change_type).toBe('cancel_use');
    expect(log.hours_delta).toBe(4);
  });

  it('lockAndIncrement 傳 negative delta', async () => {
    const repo = makeRepo({
      findActiveAnnualRecord: vi.fn().mockResolvedValue(activeRec({ used_days: 3 })),
    });
    await refundAnnualLeave(repo, {
      employee_id: 'E001', days: 1, changed_by: 'HR1',
    });
    expect(repo.lockAndIncrementUsedDays.mock.calls[0][0]).toEqual({
      record_id: 1, delta_days: -1, allow_negative: false,
    });
  });
});
