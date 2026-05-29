// tests/api-overtime-repo.test.js — 鎖住 overtime repo 對 salary_records 的欄位名
//
// 背景:salary_records 從未有 monthly_salary 欄位(月基薪叫 base_salary),
// 歷史上加班 repo 誤用 monthly_salary 導致 POST 階段 calcHourlyRate throw、
// 全員加班 500。本檔測試鎖住 select 字串、防再 regress。

import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls = { from: [], select: [] };
let nextRow = null;

vi.mock('../lib/supabase.js', () => {
  function chain() {
    const c = {};
    c.select = vi.fn((cols) => { calls.select.push(cols); return c; });
    c.eq = vi.fn(() => c);
    c.order = vi.fn(() => c);
    c.limit = vi.fn(() => c);
    c.maybeSingle = vi.fn(() => Promise.resolve({ data: nextRow, error: null }));
    return c;
  }
  const client = { from: vi.fn((t) => { calls.from.push(t); return chain(); }) };
  return { supabase: client, supabaseAdmin: client };
});

const { makeOvertimeRepo } = await import('../api/overtime-requests/_repo.js');

beforeEach(() => {
  calls.from = []; calls.select = [];
  nextRow = null;
});

describe('overtime repo · findEmployeeMonthlySalary', () => {
  it('select 字串必須包含 base_salary、不得包含 monthly_salary', async () => {
    const repo = makeOvertimeRepo();
    await repo.findEmployeeMonthlySalary('E1');

    expect(calls.from).toContain('salary_records');
    const selectCols = calls.select.join('|');
    expect(selectCols).toMatch(/base_salary/);
    expect(selectCols).not.toMatch(/monthly_salary/);
  });

  it('有 base_salary row → 回 Number(base_salary)', async () => {
    nextRow = { base_salary: 60000, year: 2026, month: 5 };
    const repo = makeOvertimeRepo();
    const result = await repo.findEmployeeMonthlySalary('E1');
    expect(result).toBe(60000);
  });

  it('row 不存在(maybeSingle 回 null)→ 回 0', async () => {
    nextRow = null;
    const repo = makeOvertimeRepo();
    const result = await repo.findEmployeeMonthlySalary('E1');
    expect(result).toBe(0);
  });

  it('base_salary 為 null → 回 0', async () => {
    nextRow = { base_salary: null, year: 2026, month: 5 };
    const repo = makeOvertimeRepo();
    const result = await repo.findEmployeeMonthlySalary('E1');
    expect(result).toBe(0);
  });
});
