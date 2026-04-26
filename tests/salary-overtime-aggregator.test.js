import { describe, it, expect, vi } from 'vitest';
import { aggregateOvertimePay } from '../lib/salary/overtime-aggregator.js';

function makeRepo(over = {}) {
  return {
    findApprovedOvertimePayRequests: vi.fn(async () => []),
    markOvertimeRequestApplied: vi.fn(async (id, sid) => ({ id, applied_to_salary_record_id: sid })),
    ...over,
  };
}

describe('aggregateOvertimePay', () => {
  it('沒 approved → total=0', async () => {
    const r = await aggregateOvertimePay(makeRepo(), {
      employee_id:'E001', year:2026, month:4, salary_record_id:'S1',
    });
    expect(r.total).toBe(0);
    expect(r.count).toBe(0);
    expect(r.breakdown).toEqual([]);
  });

  it('多筆 approved → 加總 estimated_pay,mark applied', async () => {
    const repo = makeRepo({
      findApprovedOvertimePayRequests: vi.fn(async () => [
        { id: 100, overtime_date:'2026-04-05', hours: 2, pay_multiplier: 1.34, estimated_pay: 536 },
        { id: 101, overtime_date:'2026-04-12', hours: 4, pay_multiplier: 1.67, estimated_pay: 1204 },
        { id: 102, overtime_date:'2026-04-26', hours: 8, pay_multiplier: 2.0,  estimated_pay: 3200 },
      ]),
    });
    const r = await aggregateOvertimePay(repo, {
      employee_id:'E001', year:2026, month:4, salary_record_id:'S_E001_2026_04',
    });
    expect(r.total).toBe(536 + 1204 + 3200);
    expect(r.count).toBe(3);
    expect(repo.markOvertimeRequestApplied).toHaveBeenCalledTimes(3);
    expect(repo.markOvertimeRequestApplied).toHaveBeenCalledWith(100, 'S_E001_2026_04');
  });

  it('沒 salary_record_id 不 mark', async () => {
    const repo = makeRepo({
      findApprovedOvertimePayRequests: vi.fn(async () => [
        { id: 100, hours: 2, estimated_pay: 500 },
      ]),
    });
    await aggregateOvertimePay(repo, { employee_id:'E001', year:2026, month:4 });
    expect(repo.markOvertimeRequestApplied).not.toHaveBeenCalled();
  });

  it('estimated_pay 為 null → 視為 0(不報錯)', async () => {
    const repo = makeRepo({
      findApprovedOvertimePayRequests: vi.fn(async () => [
        { id: 100, hours: 2, estimated_pay: null },
        { id: 101, hours: 2, estimated_pay: 500 },
      ]),
    });
    const r = await aggregateOvertimePay(repo, { employee_id:'E001', year:2026, month:4 });
    expect(r.total).toBe(500);
  });

  it('參數驗證', async () => {
    await expect(aggregateOvertimePay({}, { employee_id:'E001', year:2026, month:4 })).rejects.toThrow();
    await expect(aggregateOvertimePay(makeRepo(), { year:2026, month:4 })).rejects.toThrow(/employee_id/);
  });
});
