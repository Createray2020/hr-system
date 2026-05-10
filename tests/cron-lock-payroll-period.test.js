// tests/cron-lock-payroll-period.test.js
//
// 階段 C3:每月 1 號自動 lock 上個月以前 paid 的薪資期間。
// 抓 lib/salary/payroll-period-lock.js runLockPayrollPeriodSweep 純函式行為。
// (cron auth gate 已由 lib/cron-auth.js 處理、本檔不重複測)

import { describe, it, expect, vi } from 'vitest';
import { runLockPayrollPeriodSweep } from '../lib/salary/payroll-period-lock.js';

function makeRepo(periods) {
  const locked = [];
  return {
    findPaidPeriodsBefore: vi.fn(async ({ year, month }) =>
      periods.filter(p => p.status === 'paid' && (p.year < year || (p.year === year && p.month < month)))
    ),
    lockPeriod: vi.fn(async (id) => {
      const p = periods.find(x => x.id === id && x.status === 'paid');
      if (!p) return null;
      p.status = 'locked';
      locked.push(id);
      return { ...p };
    }),
    _locked: locked,
  };
}

describe('runLockPayrollPeriodSweep', () => {
  it('today=2026-06-01 → lock 2026-05 paid period', async () => {
    const repo = makeRepo([
      { id: 'PP_2026_05', year: 2026, month: 5, status: 'paid' },
      { id: 'PP_2026_06', year: 2026, month: 6, status: 'paid' },  // 同月不鎖
    ]);
    const r = await runLockPayrollPeriodSweep(repo, '2026-06-01');
    expect(r.locked_count).toBe(1);
    expect(r.locked_ids).toEqual(['PP_2026_05']);
    expect(r.threshold).toEqual({ year: 2026, month: 6 });
  });

  it('多個 paid 跨年 → 全 lock', async () => {
    const repo = makeRepo([
      { id: 'PP_2025_12', year: 2025, month: 12, status: 'paid' },
      { id: 'PP_2026_01', year: 2026, month: 1,  status: 'paid' },
      { id: 'PP_2026_05', year: 2026, month: 5,  status: 'paid' },
    ]);
    const r = await runLockPayrollPeriodSweep(repo, '2026-06-01');
    expect(r.locked_count).toBe(3);
    expect(r.locked_ids.sort()).toEqual(['PP_2025_12', 'PP_2026_01', 'PP_2026_05']);
  });

  it('不鎖 draft / calculating / pending_review / approved', async () => {
    const repo = makeRepo([
      { id: 'PP_2026_05a', year: 2026, month: 5, status: 'draft' },
      { id: 'PP_2026_05b', year: 2026, month: 5, status: 'calculating' },
      { id: 'PP_2026_05c', year: 2026, month: 5, status: 'pending_review' },
      { id: 'PP_2026_05d', year: 2026, month: 5, status: 'approved' },
    ]);
    const r = await runLockPayrollPeriodSweep(repo, '2026-06-01');
    expect(r.locked_count).toBe(0);
  });

  it('已 locked 的不重複動', async () => {
    const repo = makeRepo([
      { id: 'PP_2026_05', year: 2026, month: 5, status: 'locked' },
    ]);
    const r = await runLockPayrollPeriodSweep(repo, '2026-06-01');
    expect(r.locked_count).toBe(0);
  });

  it('當月 paid 不鎖 (還沒結束)', async () => {
    const repo = makeRepo([
      { id: 'PP_2026_06', year: 2026, month: 6, status: 'paid' },
    ]);
    const r = await runLockPayrollPeriodSweep(repo, '2026-06-01');
    expect(r.locked_count).toBe(0);
  });

  it('沒 today 參數 → throw', async () => {
    const repo = makeRepo([]);
    await expect(runLockPayrollPeriodSweep(repo, null)).rejects.toThrow(/today required/);
  });

  it('today 格式錯 → throw', async () => {
    const repo = makeRepo([]);
    await expect(runLockPayrollPeriodSweep(repo, '2026/06/01')).rejects.toThrow(/YYYY-MM-DD/);
  });

  it('repo 缺 method → throw', async () => {
    await expect(runLockPayrollPeriodSweep({}, '2026-06-01')).rejects.toThrow(/required/);
  });

  it('lockPeriod race condition (period 在 between query 與 lock 之間被改 status) → 該筆不算 locked', async () => {
    const periods = [
      { id: 'PP_2026_05', year: 2026, month: 5, status: 'paid' },
    ];
    const repo = {
      findPaidPeriodsBefore: vi.fn(async () => [{ ...periods[0] }]),
      // 模擬 race: lock 時 period 已被別人改 status
      lockPeriod: vi.fn(async () => null),
    };
    const r = await runLockPayrollPeriodSweep(repo, '2026-06-01');
    expect(r.locked_count).toBe(0);
    expect(r.locked_ids).toEqual([]);
  });
});
