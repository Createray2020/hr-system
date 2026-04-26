import { describe, it, expect, vi } from 'vitest';
import { runCompExpirySweep } from '../lib/comp-time/expiry-sweep.js';
import { runCompExpiryWarning } from '../lib/comp-time/expiry-warning.js';

const baseSettings = {
  comp_expiry_action: 'auto_payout',
  comp_expiry_warning_days: 30,
  weekday_overtime_first_2h_rate: 1.34,
};

function makeSweepRepo(over = {}) {
  return {
    getSystemOvertimeSettings: vi.fn(async () => baseSettings),
    findExpiringCompBalances:  vi.fn(async () => []),
    updateCompBalance:         vi.fn(async (id, patch) => ({ id, ...patch })),
    findEmployeeHourlyRate:    vi.fn(async () => 200), // 預設時薪 200
    applyToSalaryRecord:       vi.fn(async () => ({ ok: true })),
    insertBalanceLog:          vi.fn(async (row) => ({ id: 1, ...row })),
    ...over,
  };
}

const cb = (over = {}) => ({
  id: 1, employee_id: 'E001',
  earned_hours: 8, used_hours: 0,
  earned_at: '2025-04-26T00:00:00Z',
  expires_at: '2026-04-26',
  status: 'active',
  ...over,
});

describe('runCompExpirySweep — basic', () => {
  it('today 必填', async () => {
    await expect(runCompExpirySweep(makeSweepRepo(), null)).rejects.toThrow(/today/);
  });

  it('repo 缺 method 拒絕', async () => {
    await expect(runCompExpirySweep({}, '2026-04-26')).rejects.toThrow();
  });

  it('沒 expiring → 全 0', async () => {
    const r = await runCompExpirySweep(makeSweepRepo(), '2026-04-26');
    expect(r).toMatchObject({ expired_count: 0, payout_total: 0, action: 'auto_payout' });
  });
});

describe('runCompExpirySweep — auto_payout', () => {
  it('算金額 = 時薪 × remaining × rate;標 expired_paid', async () => {
    const repo = makeSweepRepo({
      findExpiringCompBalances: vi.fn(async () => [cb({ earned_hours: 4, used_hours: 0 })]),
    });
    const r = await runCompExpirySweep(repo, '2026-04-26');
    expect(r.expired_count).toBe(1);
    // 200 * 4 * 1.34 = 1072
    expect(r.payout_total).toBe(1072);
    const updPatch = repo.updateCompBalance.mock.calls[0][1];
    expect(updPatch.status).toBe('expired_paid');
    expect(updPatch.expiry_payout_amount).toBe(1072);
    // expire log
    const log = repo.insertBalanceLog.mock.calls[0][0];
    expect(log.balance_type).toBe('comp');
    expect(log.change_type).toBe('expire');
    expect(log.hours_delta).toBe(-4);
  });

  it('Batch 9 重新設計:不再呼叫 applyToSalaryRecord(改由 calculator 月底讀)', async () => {
    const repo = makeSweepRepo({
      findExpiringCompBalances: vi.fn(async () => [cb()]),
    });
    await runCompExpirySweep(repo, '2026-04-26');
    // expiry-sweep 仍寫入 comp_time_balance.expiry_payout_amount(本身欄位)
    expect(repo.updateCompBalance).toHaveBeenCalled();
    const updPatch = repo.updateCompBalance.mock.calls[0][1];
    expect(updPatch.expiry_payout_amount).toBeGreaterThan(0);
    // 但不再寫 salary_records(Batch 9 已重新設計)
    expect(repo.applyToSalaryRecord).not.toHaveBeenCalled();
  });

  it('時薪 0 → payout 0(不 throw)', async () => {
    const repo = makeSweepRepo({
      findExpiringCompBalances: vi.fn(async () => [cb()]),
      findEmployeeHourlyRate: vi.fn(async () => 0),
    });
    const r = await runCompExpirySweep(repo, '2026-04-26');
    expect(r.payout_total).toBe(0);
  });
});

describe('runCompExpirySweep — manual_review', () => {
  it('標 expired_paid 但金額 NULL', async () => {
    const repo = makeSweepRepo({
      getSystemOvertimeSettings: vi.fn(async () => ({ ...baseSettings, comp_expiry_action: 'manual_review' })),
      findExpiringCompBalances: vi.fn(async () => [cb()]),
    });
    const r = await runCompExpirySweep(repo, '2026-04-26');
    expect(r.action).toBe('manual_review');
    expect(r.payout_total).toBe(0);
    const updPatch = repo.updateCompBalance.mock.calls[0][1];
    expect(updPatch.status).toBe('expired_paid');
    expect(updPatch.expiry_payout_amount).toBe(null);
    expect(repo.applyToSalaryRecord).not.toHaveBeenCalled();
  });
});

describe('runCompExpirySweep — void', () => {
  it('標 expired_void,不算金額', async () => {
    const repo = makeSweepRepo({
      getSystemOvertimeSettings: vi.fn(async () => ({ ...baseSettings, comp_expiry_action: 'void' })),
      findExpiringCompBalances: vi.fn(async () => [cb()]),
    });
    const r = await runCompExpirySweep(repo, '2026-04-26');
    expect(r.action).toBe('void');
    const updPatch = repo.updateCompBalance.mock.calls[0][1];
    expect(updPatch.status).toBe('expired_void');
    expect(repo.applyToSalaryRecord).not.toHaveBeenCalled();
  });
});

describe('runCompExpirySweep — fully_used 防呆', () => {
  it('remaining=0 直接標 fully_used,不寫 expire log', async () => {
    const repo = makeSweepRepo({
      findExpiringCompBalances: vi.fn(async () => [cb({ earned_hours: 5, used_hours: 5 })]),
    });
    const r = await runCompExpirySweep(repo, '2026-04-26');
    expect(r.expired_count).toBe(0);
    expect(repo.updateCompBalance.mock.calls[0][1].status).toBe('fully_used');
    expect(repo.insertBalanceLog).not.toHaveBeenCalled();
  });
});

// ─── expiry-warning ─────────────────────────────────────────

function makeWarnRepo(over = {}) {
  return {
    getSystemOvertimeSettings: vi.fn(async () => baseSettings),
    findCompBalancesExpiringOn: vi.fn(async () => []),
    notifyExpiryWarning: vi.fn(async () => ({ ok: true })),
    ...over,
  };
}

describe('runCompExpiryWarning', () => {
  it('today 必填', async () => {
    await expect(runCompExpiryWarning(makeWarnRepo(), null)).rejects.toThrow(/today/);
  });

  it('用 settings.comp_expiry_warning_days 計算 target;預設 30', async () => {
    const repo = makeWarnRepo();
    const r = await runCompExpiryWarning(repo, '2026-04-26');
    expect(r.warning_days).toBe(30);
    expect(r.target_date).toBe('2026-05-26');
    expect(repo.findCompBalancesExpiringOn).toHaveBeenCalledWith('2026-05-26');
  });

  it('settings 未提供 → fallback 30 天', async () => {
    const repo = makeWarnRepo({
      getSystemOvertimeSettings: vi.fn(async () => null),
    });
    const r = await runCompExpiryWarning(repo, '2026-04-26');
    expect(r.warning_days).toBe(30);
  });

  it('settings 自訂 14 → 14 天後', async () => {
    const repo = makeWarnRepo({
      getSystemOvertimeSettings: vi.fn(async () => ({ ...baseSettings, comp_expiry_warning_days: 14 })),
    });
    const r = await runCompExpiryWarning(repo, '2026-04-26');
    expect(r.warning_days).toBe(14);
    expect(r.target_date).toBe('2026-05-10');
  });

  it('每筆 active 觸發推播', async () => {
    const repo = makeWarnRepo({
      findCompBalancesExpiringOn: vi.fn(async () => [
        cb({ id: 1, earned_hours: 4, used_hours: 0 }),
        cb({ id: 2, earned_hours: 6, used_hours: 2 }),
      ]),
    });
    const r = await runCompExpiryWarning(repo, '2026-04-26');
    expect(r.warning_sent_count).toBe(2);
    expect(repo.notifyExpiryWarning).toHaveBeenCalledTimes(2);
    expect(repo.notifyExpiryWarning.mock.calls[0][0].remaining_hours).toBe(4);
    expect(repo.notifyExpiryWarning.mock.calls[1][0].remaining_hours).toBe(4);
  });

  it('remaining 0 → skip 不通知', async () => {
    const repo = makeWarnRepo({
      findCompBalancesExpiringOn: vi.fn(async () => [
        cb({ earned_hours: 5, used_hours: 5 }),
      ]),
    });
    const r = await runCompExpiryWarning(repo, '2026-04-26');
    expect(r.warning_sent_count).toBe(0);
    expect(repo.notifyExpiryWarning).not.toHaveBeenCalled();
  });
});
