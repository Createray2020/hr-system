import { describe, it, expect, vi } from 'vitest';
import { runAnnualRollover } from '../lib/leave/annual-rollover.js';

function makeRepo(over = {}) {
  return {
    findEmployeesWithAnniversaryToday: vi.fn(async () => []),
    findActiveAnnualRecord: vi.fn(async () => null),
    updateAnnualRecord: vi.fn(async (id, patch) => ({ id, ...patch })),
    insertAnnualRecord: vi.fn(async (row) => ({ id: 999, ...row })),
    insertBalanceLog: vi.fn(async (row) => ({ id: 1, ...row })),
    ...over,
  };
}

describe('runAnnualRollover — basic', () => {
  it('沒員工週年 → count 0', async () => {
    const r = await runAnnualRollover(makeRepo(), '2026-04-26');
    expect(r).toMatchObject({ rollover_count: 0, payout_total: 0 });
  });

  it('today 必填', async () => {
    await expect(runAnnualRollover(makeRepo(), null)).rejects.toThrow(/today/);
  });

  it('repo 缺 method 拒絕', async () => {
    await expect(runAnnualRollover({}, '2026-04-26')).rejects.toThrow();
  });
});

describe('runAnnualRollover — 滾動流程', () => {
  it('員工首次滾動(沒舊 record)→ 直接建新 record + grant log', async () => {
    const repo = makeRepo({
      findEmployeesWithAnniversaryToday: vi.fn(async () => [{
        id: 'E001', annual_leave_seniority_start: '2024-04-26',
      }]),
    });
    const r = await runAnnualRollover(repo, '2026-04-26');
    expect(r.rollover_count).toBe(1);
    expect(repo.updateAnnualRecord).not.toHaveBeenCalled();
    expect(repo.insertAnnualRecord).toHaveBeenCalledTimes(1);
    const newRow = repo.insertAnnualRecord.mock.calls[0][0];
    expect(newRow.employee_id).toBe('E001');
    // senStart=2024-04-26, today=2026-04-26 → period_start=2026-04-26, seniority_years=2 → 10 天
    expect(newRow.legal_days).toBe(10);
    expect(newRow.granted_days).toBe(10);
    expect(newRow.used_days).toBe(0);
    expect(newRow.status).toBe('active');
    expect(repo.insertBalanceLog).toHaveBeenCalledTimes(1);
    const log = repo.insertBalanceLog.mock.calls[0][0];
    expect(log.change_type).toBe('grant');
    expect(log.hours_delta).toBe(80); // 10 days * 8
  });

  it('有舊 record → 結算(status=paid_out, settlement_amount=0)+ 新建', async () => {
    const repo = makeRepo({
      findEmployeesWithAnniversaryToday: vi.fn(async () => [{
        id: 'E001', annual_leave_seniority_start: '2020-04-26',
      }]),
      findActiveAnnualRecord: vi.fn(async () => ({
        id: 7, employee_id: 'E001',
        period_start: '2025-04-26', period_end: '2026-04-25',
        granted_days: 14, used_days: 4, status: 'active',
      })),
    });
    const r = await runAnnualRollover(repo, '2026-04-26');
    expect(r.rollover_count).toBe(1);
    expect(r.payout_total).toBe(0); // TODO Batch 9
    expect(repo.updateAnnualRecord).toHaveBeenCalledTimes(1);
    const updPatch = repo.updateAnnualRecord.mock.calls[0][1];
    expect(updPatch.status).toBe('paid_out');
    expect(updPatch.settlement_amount).toBe(0); // TODO Batch 9 換實際金額
    expect(updPatch.settled_at).toContain('2026-04-26');

    // 結算 log
    const settleLog = repo.insertBalanceLog.mock.calls.find(c => c[0].change_type === 'settle');
    expect(settleLog).toBeDefined();
    expect(settleLog[0].hours_delta).toBe(-(14 - 4) * 8); // remaining 10 days * -8

    // 新 record + grant log
    expect(repo.insertAnnualRecord).toHaveBeenCalledTimes(1);
    const newRow = repo.insertAnnualRecord.mock.calls[0][0];
    expect(newRow.legal_days).toBe(15); // senStart 2020-04-26 → today 2026-04-26 → 滿 6 年 → 15
  });

  it('legal_days=0(年資不到 0.5)→ 不寫 grant log', async () => {
    const repo = makeRepo({
      findEmployeesWithAnniversaryToday: vi.fn(async () => [{
        id: 'E001', annual_leave_seniority_start: '2026-04-26',
      }]),
    });
    // 同日入職同日 rollover → seniority_years = 0,legal_days = 0
    await runAnnualRollover(repo, '2026-04-26');
    const grantLogs = repo.insertBalanceLog.mock.calls.filter(c => c[0].change_type === 'grant');
    expect(grantLogs.length).toBe(0);
  });

  it('多員工累計 rollover_count', async () => {
    const repo = makeRepo({
      findEmployeesWithAnniversaryToday: vi.fn(async () => [
        { id: 'E001', annual_leave_seniority_start: '2024-04-26' },
        { id: 'E002', annual_leave_seniority_start: '2023-04-26' },
        { id: 'E003', annual_leave_seniority_start: '2020-04-26' },
      ]),
    });
    const r = await runAnnualRollover(repo, '2026-04-26');
    expect(r.rollover_count).toBe(3);
    expect(repo.insertAnnualRecord).toHaveBeenCalledTimes(3);
  });

  it('員工 annual_leave_seniority_start 為 null → 跳過(不增加 count)', async () => {
    const repo = makeRepo({
      findEmployeesWithAnniversaryToday: vi.fn(async () => [
        { id: 'E001', annual_leave_seniority_start: null },
        { id: 'E002', annual_leave_seniority_start: '2023-04-26' },
      ]),
    });
    const r = await runAnnualRollover(repo, '2026-04-26');
    expect(r.rollover_count).toBe(1);
    expect(repo.insertAnnualRecord).toHaveBeenCalledTimes(1);
    expect(repo.insertAnnualRecord.mock.calls[0][0].employee_id).toBe('E002');
  });
});
