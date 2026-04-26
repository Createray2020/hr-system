import { describe, it, expect, vi } from 'vitest';
import { calculateSettlementAmount } from '../lib/salary/settlement.js';

function makeRepo(over = {}) {
  return {
    findAnnualRecordsForSettlement: vi.fn(async () => []),
    findCompBalancesForSettlement:  vi.fn(async () => []),
    updateAnnualRecord: vi.fn(async (id, p) => ({ id, ...p })),
    // updateCompBalance 仍在 mock 內以驗證「不被呼叫」
    updateCompBalance:  vi.fn(async (id, p) => ({ id, ...p })),
    getDailyWageSnapshot: vi.fn(async () => 2000),
    ...over,
  };
}

describe('calculateSettlementAmount', () => {
  it('沒記錄 → 0', async () => {
    const r = await calculateSettlementAmount(makeRepo(), { employee_id:'E001', year:2026, month:4 });
    expect(r).toMatchObject({ annual_settlement: 0, comp_expiry_payout: 0 });
  });

  it('annual:剩餘 5 天 × 日薪 2000 = 10000,update 該 record', async () => {
    const repo = makeRepo({
      findAnnualRecordsForSettlement: vi.fn(async () => [
        { id: 1, granted_days: 14, used_days: 9, period_start: '2025-04-01', period_end: '2026-03-31' },
      ]),
    });
    const r = await calculateSettlementAmount(repo, { employee_id:'E001', year:2026, month:4, daily_wage: 2000 });
    expect(r.annual_settlement).toBe(10000);
    expect(repo.updateAnnualRecord).toHaveBeenCalledWith(1, { settlement_amount: 10000 });
    expect(r.breakdown.annual[0]).toMatchObject({
      annual_record_id: 1, remaining_days: 5, daily_wage: 2000, amount: 10000,
    });
  });

  it('annual:已用完(remaining=0)→ 0', async () => {
    const repo = makeRepo({
      findAnnualRecordsForSettlement: vi.fn(async () => [
        { id: 1, granted_days: 5, used_days: 5 },
      ]),
    });
    const r = await calculateSettlementAmount(repo, { employee_id:'E001', year:2026, month:4, daily_wage: 2000 });
    expect(r.annual_settlement).toBe(0);
  });

  it('comp:讀 expiry_payout_amount(由 expiry-sweep 算好)→ 加總,不重算', async () => {
    const repo = makeRepo({
      findCompBalancesForSettlement: vi.fn(async () => [
        { id: 10, expiry_payout_amount: 2144, earned_at: '2025-04-26', expires_at: '2026-04-26' },
      ]),
    });
    const r = await calculateSettlementAmount(repo, { employee_id:'E001', year:2026, month:4 });
    expect(r.comp_expiry_payout).toBe(2144);
    // 不再重算 → 不應 update comp_time_balance
    expect(repo.updateCompBalance).not.toHaveBeenCalled();
  });

  it('comp:expiry_payout_amount=NULL(manual_review 待 HR 填)→ skip', async () => {
    const repo = makeRepo({
      findCompBalancesForSettlement: vi.fn(async () => [
        { id: 11, expiry_payout_amount: null,  earned_at: '2025-01-01' }, // skip
        { id: 12, expiry_payout_amount: 1500,  earned_at: '2025-02-01' },
        { id: 13, expiry_payout_amount: 0,     earned_at: '2025-03-01' }, // amount=0 仍算入
      ]),
    });
    const r = await calculateSettlementAmount(repo, { employee_id:'E001', year:2026, month:4 });
    expect(r.comp_expiry_payout).toBe(1500);
    expect(r.breakdown.comp).toHaveLength(2); // null 那筆被 skip
  });

  it('annual + comp 同時:兩者分別在不同欄位', async () => {
    const repo = makeRepo({
      findAnnualRecordsForSettlement: vi.fn(async () => [
        { id: 1, granted_days: 10, used_days: 8 },
      ]),
      findCompBalancesForSettlement: vi.fn(async () => [
        { id: 10, expiry_payout_amount: 1072 }, // 已由 expiry-sweep 算好
      ]),
    });
    const r = await calculateSettlementAmount(repo, { employee_id:'E001', year:2026, month:4, daily_wage: 2000 });
    expect(r.annual_settlement).toBe(2 * 2000);   // 4000
    expect(r.comp_expiry_payout).toBe(1072);
  });

  it('多筆 annual records 加總', async () => {
    const repo = makeRepo({
      findAnnualRecordsForSettlement: vi.fn(async () => [
        { id: 1, granted_days: 5, used_days: 0 },
        { id: 2, granted_days: 3, used_days: 1 },
      ]),
    });
    const r = await calculateSettlementAmount(repo, { employee_id:'E001', year:2026, month:4, daily_wage: 1000 });
    expect(r.annual_settlement).toBe(5000 + 2000); // 7000
    expect(repo.updateAnnualRecord).toHaveBeenCalledTimes(2);
  });

  it('參數驗證', async () => {
    await expect(calculateSettlementAmount(makeRepo(), { year:2026, month:4 })).rejects.toThrow(/employee_id/);
    await expect(calculateSettlementAmount(makeRepo(), { employee_id:'E', month:4 })).rejects.toThrow(/year/);
    await expect(calculateSettlementAmount(makeRepo(), { employee_id:'E', year:2026, month:13 })).rejects.toThrow(/month/);
    await expect(calculateSettlementAmount({}, { employee_id:'E', year:2026, month:4 })).rejects.toThrow();
  });
});
