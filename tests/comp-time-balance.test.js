import { describe, it, expect, vi } from 'vitest';
import { getCompBalance, grantCompTime } from '../lib/comp-time/balance.js';
import { deductCompTime, refundCompTime } from '../lib/leave/balance.js';

function makeRepo(over = {}) {
  return {
    findActiveCompBalances: vi.fn(async () => []),
    lockAndIncrementCompUsedHours: vi.fn(async () => ({ ok: true, record: { id: 1 } })),
    insertCompBalance: vi.fn(async (row) => ({ id: 999, ...row })),
    insertBalanceLog: vi.fn(async (row) => ({ id: 1, ...row })),
    ...over,
  };
}

const cb = (over = {}) => ({
  id: 1, employee_id: 'E001',
  source_overtime_request_id: 100,
  earned_at: '2025-06-01T00:00:00Z',
  expires_at: '2026-06-01',
  earned_hours: 8, used_hours: 0,
  status: 'active',
  ...over,
});

describe('getCompBalance', () => {
  it('沒記錄 → total_remaining 0、records 空', async () => {
    const r = await getCompBalance(makeRepo(), 'E001');
    expect(r).toEqual({ total_remaining: 0, records: [] });
  });

  it('多筆 active → 加總 remaining', async () => {
    const repo = makeRepo({
      findActiveCompBalances: vi.fn(async () => [
        cb({ id: 1, earned_hours: 8, used_hours: 2 }),
        cb({ id: 2, earned_hours: 5, used_hours: 0, expires_at: '2026-12-01' }),
      ]),
    });
    const r = await getCompBalance(repo, 'E001');
    expect(r.total_remaining).toBe(11); // (8-2) + (5-0)
    expect(r.records).toHaveLength(2);
    expect(r.records[0].remaining_hours).toBe(6);
    expect(r.records[1].remaining_hours).toBe(5);
  });

  it('used > earned 防呆 → remaining 取 0', async () => {
    const repo = makeRepo({
      findActiveCompBalances: vi.fn(async () => [cb({ used_hours: 99 })]),
    });
    const r = await getCompBalance(repo, 'E001');
    expect(r.total_remaining).toBe(0);
    expect(r.records[0].remaining_hours).toBe(0);
  });

  it('repo 缺 method → throw', async () => {
    await expect(getCompBalance({}, 'E001')).rejects.toThrow(/findActiveCompBalances/);
  });
});

describe('grantCompTime', () => {
  it('建 comp_balance + grant log', async () => {
    const repo = makeRepo();
    const r = await grantCompTime(repo, {
      employee_id: 'E001',
      hours: 4,
      source_overtime_request_id: 100,
      earned_at: '2026-04-26T18:00:00Z',
      changed_by: 'M001',
    });
    expect(repo.insertCompBalance).toHaveBeenCalled();
    const row = repo.insertCompBalance.mock.calls[0][0];
    expect(row.employee_id).toBe('E001');
    expect(row.earned_hours).toBe(4);
    expect(row.source_overtime_request_id).toBe(100);
    expect(row.expires_at).toBe('2027-04-26'); // earned_at + 1 year
    expect(row.status).toBe('active');
    expect(row.used_hours).toBe(0);

    const log = repo.insertBalanceLog.mock.calls[0][0];
    expect(log.balance_type).toBe('comp');
    expect(log.change_type).toBe('grant');
    expect(log.hours_delta).toBe(4);
    expect(log.changed_by).toBe('M001');
  });

  it('expires_at 可顯式覆蓋(早於 earned+1y)', async () => {
    const repo = makeRepo();
    await grantCompTime(repo, {
      employee_id: 'E001',
      hours: 4,
      source_overtime_request_id: 100,
      earned_at: '2026-04-26T18:00:00Z',
      expires_at: '2026-12-31',
    });
    expect(repo.insertCompBalance.mock.calls[0][0].expires_at).toBe('2026-12-31');
  });

  it('hours 非正 → throw', async () => {
    await expect(grantCompTime(makeRepo(), {
      employee_id: 'E001', hours: 0,
      source_overtime_request_id: 100, earned_at: '2026-04-26T00:00:00Z',
    })).rejects.toThrow();
  });

  it('缺 source_overtime_request_id → throw', async () => {
    await expect(grantCompTime(makeRepo(), {
      employee_id: 'E001', hours: 4, earned_at: '2026-04-26T00:00:00Z',
    })).rejects.toThrow(/source_overtime_request_id/);
  });
});

describe('deductCompTime — FIFO', () => {
  it('單筆內扣完 → 一次 lockAndIncrement,寫一筆 use log', async () => {
    const repo = makeRepo({
      findActiveCompBalances: vi.fn(async () => [
        cb({ id: 1, earned_hours: 10, used_hours: 0 }),
      ]),
    });
    const r = await deductCompTime(repo, {
      employee_id: 'E001', hours: 3, leave_request_id: 'L1', changed_by: 'M001',
    });
    expect(r.ok).toBe(true);
    expect(r.deductions).toEqual([{ comp_id: 1, hours: 3 }]);
    expect(repo.lockAndIncrementCompUsedHours).toHaveBeenCalledTimes(1);
    expect(repo.insertBalanceLog).toHaveBeenCalledTimes(1);
    const log = repo.insertBalanceLog.mock.calls[0][0];
    expect(log.balance_type).toBe('comp');
    expect(log.change_type).toBe('use');
    expect(log.hours_delta).toBe(-3);
  });

  it('跨多筆 FIFO(8h 跨 5+5)→ 第一筆扣 5、第二筆扣 3', async () => {
    const repo = makeRepo({
      findActiveCompBalances: vi.fn(async () => [
        cb({ id: 10, earned_hours: 5, used_hours: 0, expires_at: '2026-06-30' }),
        cb({ id: 11, earned_hours: 5, used_hours: 0, expires_at: '2026-12-31' }),
      ]),
    });
    const r = await deductCompTime(repo, {
      employee_id: 'E001', hours: 8, changed_by: 'M001',
    });
    expect(r.ok).toBe(true);
    expect(r.deductions).toEqual([
      { comp_id: 10, hours: 5 },
      { comp_id: 11, hours: 3 },
    ]);
    expect(repo.insertBalanceLog).toHaveBeenCalledTimes(2);
    expect(repo.insertBalanceLog.mock.calls[0][0].hours_delta).toBe(-5);
    expect(repo.insertBalanceLog.mock.calls[1][0].hours_delta).toBe(-3);
  });

  it('餘額不足 → INSUFFICIENT_COMP_BALANCE,不寫 log', async () => {
    const repo = makeRepo({
      findActiveCompBalances: vi.fn(async () => [
        cb({ id: 1, earned_hours: 4, used_hours: 0 }),
      ]),
    });
    const r = await deductCompTime(repo, {
      employee_id: 'E001', hours: 8, changed_by: 'M001',
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('INSUFFICIENT_COMP_BALANCE');
    expect(repo.lockAndIncrementCompUsedHours).not.toHaveBeenCalled();
    expect(repo.insertBalanceLog).not.toHaveBeenCalled();
  });

  it('skip 已用滿(remaining=0)的 record', async () => {
    const repo = makeRepo({
      findActiveCompBalances: vi.fn(async () => [
        cb({ id: 1, earned_hours: 5, used_hours: 5 }), // 已用滿(理論不該還是 active 但防呆)
        cb({ id: 2, earned_hours: 5, used_hours: 0 }),
      ]),
    });
    const r = await deductCompTime(repo, {
      employee_id: 'E001', hours: 3, changed_by: 'M001',
    });
    expect(r.ok).toBe(true);
    expect(r.deductions).toEqual([{ comp_id: 2, hours: 3 }]);
  });

  it('hours 非正 → throw', async () => {
    await expect(deductCompTime(makeRepo(), {
      employee_id: 'E001', hours: 0, changed_by: 'M001',
    })).rejects.toThrow();
  });
});

describe('refundCompTime', () => {
  it('依 original_deductions 反向退', async () => {
    const repo = makeRepo();
    const r = await refundCompTime(repo, {
      employee_id: 'E001', hours: 8, changed_by: 'HR1',
      original_deductions: [
        { comp_id: 10, hours: 5 },
        { comp_id: 11, hours: 3 },
      ],
    });
    expect(r.ok).toBe(true);
    expect(repo.lockAndIncrementCompUsedHours).toHaveBeenCalledTimes(2);
    expect(repo.lockAndIncrementCompUsedHours.mock.calls[0][0]).toEqual({
      comp_id: 10, delta_hours: -5, allow_negative: false,
    });
    expect(repo.lockAndIncrementCompUsedHours.mock.calls[1][0]).toEqual({
      comp_id: 11, delta_hours: -3, allow_negative: false,
    });
    const log0 = repo.insertBalanceLog.mock.calls[0][0];
    expect(log0.change_type).toBe('cancel_use');
    expect(log0.hours_delta).toBe(5);
  });

  it('沒 original_deductions:用 active records 中 used > 0 的退', async () => {
    const repo = makeRepo({
      findActiveCompBalances: vi.fn(async () => [
        cb({ id: 1, earned_hours: 5, used_hours: 5 }),
        cb({ id: 2, earned_hours: 5, used_hours: 2 }),
      ]),
    });
    const r = await refundCompTime(repo, {
      employee_id: 'E001', hours: 6, changed_by: 'HR1',
    });
    expect(r.ok).toBe(true);
    expect(r.unmatched_hours).toBe(0);
    // 第一筆退 5(used=5),第二筆退 1(剩 1h)
    expect(repo.lockAndIncrementCompUsedHours.mock.calls[0][0]).toEqual({
      comp_id: 1, delta_hours: -5, allow_negative: false,
    });
    expect(repo.lockAndIncrementCompUsedHours.mock.calls[1][0]).toEqual({
      comp_id: 2, delta_hours: -1, allow_negative: false,
    });
  });

  it('沒 original_deductions 且 used 不足:回 unmatched_hours > 0', async () => {
    const repo = makeRepo({
      findActiveCompBalances: vi.fn(async () => [
        cb({ id: 1, earned_hours: 5, used_hours: 2 }),
      ]),
    });
    const r = await refundCompTime(repo, {
      employee_id: 'E001', hours: 5, changed_by: 'HR1',
    });
    expect(r.ok).toBe(true);
    expect(r.unmatched_hours).toBe(3);
  });
});
