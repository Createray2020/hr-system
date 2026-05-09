import { describe, it, expect, vi } from 'vitest';
import {
  calculatePeriodStats, reconcilePeriodStats,
} from '../lib/salary/period-stats.js';

describe('calculatePeriodStats', () => {
  it('空 records → 全 0', () => {
    expect(calculatePeriodStats([])).toEqual({
      employee_count: 0, gross_total: 0, net_total: 0, employer_cost_total: 0,
    });
  });

  it('null → 全 0', () => {
    expect(calculatePeriodStats(null)).toEqual({
      employee_count: 0, gross_total: 0, net_total: 0, employer_cost_total: 0,
    });
  });

  it('undefined → 全 0', () => {
    expect(calculatePeriodStats(undefined)).toEqual({
      employee_count: 0, gross_total: 0, net_total: 0, employer_cost_total: 0,
    });
  });

  it('單個 record(全欄位)', () => {
    expect(calculatePeriodStats([{
      gross_salary: 50000,
      net_salary: 45000,
      employer_cost_labor: 3000,
      employer_cost_health: 1500,
      employer_cost_pension: 2700,
      employer_cost_occupational: 100,
      employer_cost_employment: 350,
      employer_cost_welfare: 0,
    }])).toEqual({
      employee_count: 1,
      gross_total: 50000,
      net_total: 45000,
      employer_cost_total: 7650,
    });
  });

  it('多個 record 加總', () => {
    expect(calculatePeriodStats([
      { gross_salary: 50000, net_salary: 45000, employer_cost_labor: 3000 },
      { gross_salary: 60000, net_salary: 54000, employer_cost_labor: 4000 },
    ])).toEqual({
      employee_count: 2,
      gross_total: 110000,
      net_total: 99000,
      employer_cost_total: 7000,
    });
  });

  it('null/undefined 欄位 → 視為 0', () => {
    expect(calculatePeriodStats([{
      gross_salary: 50000, net_salary: null, employer_cost_labor: undefined,
      employer_cost_health: 1500, employer_cost_pension: null,
    }])).toEqual({
      employee_count: 1,
      gross_total: 50000,
      net_total: 0,
      employer_cost_total: 1500,
    });
  });

  it('小數累加 round2', () => {
    expect(calculatePeriodStats([
      { gross_salary: 50000.123, net_salary: 45000.456 },
      { gross_salary: 60000.789, net_salary: 54000.001 },
    ])).toEqual({
      employee_count: 2,
      gross_total: 110000.91,
      net_total: 99000.46,
      employer_cost_total: 0,
    });
  });

  it('employee_count 是整數、不受 round 影響', () => {
    const records = Array.from({ length: 31 }, (_, i) => ({
      gross_salary: 30000 + i,
      net_salary: 27000 + i,
    }));
    expect(calculatePeriodStats(records).employee_count).toBe(31);
  });
});

describe('reconcilePeriodStats', () => {
  it('呼叫 repo 拿 records、傳給 calculatePeriodStats', async () => {
    const repo = {
      findSalaryRecordsByPeriodId: vi.fn(async () => [
        { gross_salary: 50000, net_salary: 45000, employer_cost_labor: 3000 },
        { gross_salary: 60000, net_salary: 54000, employer_cost_labor: 4000 },
      ]),
    };
    const stats = await reconcilePeriodStats(repo, 'PP_2026_04');
    expect(repo.findSalaryRecordsByPeriodId).toHaveBeenCalledWith('PP_2026_04');
    expect(stats).toEqual({
      employee_count: 2,
      gross_total: 110000,
      net_total: 99000,
      employer_cost_total: 7000,
    });
  });

  it('records 空 → 全 0', async () => {
    const repo = { findSalaryRecordsByPeriodId: vi.fn(async () => []) };
    const stats = await reconcilePeriodStats(repo, 'PP_2026_04');
    expect(stats).toEqual({
      employee_count: 0, gross_total: 0, net_total: 0, employer_cost_total: 0,
    });
  });
});
