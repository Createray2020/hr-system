import { describe, it, expect, vi } from 'vitest';
import {
  getAnnualBalance, deductAnnualLeave, refundAnnualLeave,
} from '../lib/leave/balance.js';

function makeRepo(over = {}) {
  return {
    findAnnualRecordCoveringDate: vi.fn().mockResolvedValue(null),
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
      findAnnualRecordCoveringDate: vi.fn().mockResolvedValue(activeRec({ used_days: 3 })),
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
      findAnnualRecordCoveringDate: vi.fn().mockResolvedValue(activeRec({ used_days: 99 })),
    });
    const r = await getAnnualBalance(repo, 'E001');
    expect(r.remaining_days).toBe(0);
  });

  it('repo 缺 method → 拒絕', async () => {
    await expect(getAnnualBalance({}, 'E001')).rejects.toThrow(/findAnnualRecordCoveringDate/);
  });

  it('缺 employee_id → 拒絕', async () => {
    await expect(getAnnualBalance(makeRepo(), null)).rejects.toThrow(/employee_id/);
  });

  // B14:預設 as_of_date 走 today(Asia/Taipei)
  it('B14:沒傳 as_of_date → 用今天日期呼叫 findAnnualRecordCoveringDate', async () => {
    const repo = makeRepo({
      findAnnualRecordCoveringDate: vi.fn().mockResolvedValue(activeRec({ used_days: 2 })),
    });
    await getAnnualBalance(repo, 'E001');
    const callArgs = repo.findAnnualRecordCoveringDate.mock.calls[0];
    expect(callArgs[0]).toBe('E001');
    // 第二個參數應該是 YYYY-MM-DD 格式的字串
    expect(callArgs[1]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('B14:顯式傳 as_of_date → 用該日期呼叫 findAnnualRecordCoveringDate', async () => {
    const repo = makeRepo({
      findAnnualRecordCoveringDate: vi.fn().mockResolvedValue(activeRec({ used_days: 1 })),
    });
    await getAnnualBalance(repo, 'E001', '2026-05-11');
    expect(repo.findAnnualRecordCoveringDate).toHaveBeenCalledWith('E001', '2026-05-11');
  });
});

describe('deductAnnualLeave', () => {
  it('成功扣減 1 天 → log hours_delta = -8', async () => {
    const repo = makeRepo({
      findAnnualRecordCoveringDate: vi.fn().mockResolvedValue(activeRec()),
    });
    const r = await deductAnnualLeave(repo, {
      employee_id: 'E001', days: 1, leave_request_id: 'L1', changed_by: 'HR1',
      leave_date: '2026-04-27',
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
      employee_id: 'E001', days: 1, changed_by: 'HR1', leave_date: '2026-04-27',
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('NO_ACTIVE_RECORD');
    expect(repo.insertBalanceLog).not.toHaveBeenCalled();
  });

  it('餘額不足 → 不寫 log,回 lock 失敗 reason', async () => {
    const repo = makeRepo({
      findAnnualRecordCoveringDate: vi.fn().mockResolvedValue(activeRec({ granted_days: 5, used_days: 4 })),
      lockAndIncrementUsedDays: vi.fn().mockResolvedValue({ ok: false, reason: 'INSUFFICIENT_BALANCE' }),
    });
    const r = await deductAnnualLeave(repo, {
      employee_id: 'E001', days: 3, changed_by: 'HR1', leave_date: '2026-04-27',
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('INSUFFICIENT_BALANCE');
    expect(repo.insertBalanceLog).not.toHaveBeenCalled();
  });

  it('缺 changed_by → throw', async () => {
    await expect(deductAnnualLeave(makeRepo(), { employee_id: 'E001', days: 1, leave_date: '2026-04-27' }))
      .rejects.toThrow(/changed_by/);
  });

  it('days 非正數 → throw', async () => {
    await expect(deductAnnualLeave(makeRepo(), { employee_id: 'E001', days: 0, changed_by: 'HR1', leave_date: '2026-04-27' }))
      .rejects.toThrow();
    await expect(deductAnnualLeave(makeRepo(), { employee_id: 'E001', days: -1, changed_by: 'HR1', leave_date: '2026-04-27' }))
      .rejects.toThrow();
  });

  // B14 新增 cases
  it('B14:缺 leave_date → throw', async () => {
    await expect(deductAnnualLeave(makeRepo(), {
      employee_id: 'E001', days: 1, changed_by: 'HR1',
    })).rejects.toThrow(/leave_date/);
  });

  it('B14 regression:multi active records 並存、leave_date 5/11 → 挑當前 period(Record 73)、不挑未來 period(Record 74)', async () => {
    const rec73 = activeRec({
      id: 73, period_start: '2026-05-03', period_end: '2026-11-02', granted_days: 14, used_days: 0,
    });
    // mock 模擬 supabase 真實行為:WHERE period_start<=leaveDate AND period_end>=leaveDate
    // 對 2026-05-11 只回 rec73、未來 period (rec74 starts 2026-11-03) 不會被選
    const repo = makeRepo({
      findAnnualRecordCoveringDate: vi.fn(async (emp, date) => {
        if (date >= '2026-05-03' && date <= '2026-11-02') return rec73;
        return null; // 其他日期不關心
      }),
    });
    const r = await deductAnnualLeave(repo, {
      employee_id: 'EMP_01251101', days: 1, leave_request_id: 'L_511', changed_by: 'HR1',
      leave_date: '2026-05-11',
    });
    expect(r.ok).toBe(true);
    expect(repo.findAnnualRecordCoveringDate).toHaveBeenCalledWith('EMP_01251101', '2026-05-11');
    expect(repo.lockAndIncrementUsedDays).toHaveBeenCalledWith({
      record_id: 73, delta_days: 1, allow_negative: false,
    });
    const log = repo.insertBalanceLog.mock.calls[0][0];
    expect(log.annual_record_id).toBe(73);
  });
});

describe('refundAnnualLeave', () => {
  it('退還 0.5 天 → log hours_delta = +4', async () => {
    const repo = makeRepo({
      findAnnualRecordCoveringDate: vi.fn().mockResolvedValue(activeRec({ used_days: 3 })),
    });
    const r = await refundAnnualLeave(repo, {
      employee_id: 'E001', days: 0.5, leave_request_id: 'L1', changed_by: 'HR1',
      leave_date: '2026-04-27',
    });
    expect(r.ok).toBe(true);
    const log = repo.insertBalanceLog.mock.calls[0][0];
    expect(log.change_type).toBe('cancel_use');
    expect(log.hours_delta).toBe(4);
  });

  it('lockAndIncrement 傳 negative delta', async () => {
    const repo = makeRepo({
      findAnnualRecordCoveringDate: vi.fn().mockResolvedValue(activeRec({ used_days: 3 })),
    });
    await refundAnnualLeave(repo, {
      employee_id: 'E001', days: 1, changed_by: 'HR1', leave_date: '2026-04-27',
    });
    expect(repo.lockAndIncrementUsedDays.mock.calls[0][0]).toEqual({
      record_id: 1, delta_days: -1, allow_negative: false,
    });
  });

  // B14 新增
  it('B14:缺 leave_date → throw', async () => {
    await expect(refundAnnualLeave(makeRepo(), {
      employee_id: 'E001', days: 1, changed_by: 'HR1',
    })).rejects.toThrow(/leave_date/);
  });
});
