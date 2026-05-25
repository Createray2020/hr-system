// tests/final-month-settlement.test.js — B26 批次 3+
//
// B26.7 listEmployeesForPayroll(repo helper test、不走 handler)
// B26 後續批次(4-5):calculator pro-rata 整鏈路 / regression / etc 加進此檔
//
// Test 範圍:salary repo / calculator 等離職月結算相關純函式、不走 HTTP handler。
// Cascade flow test 在 tests/approvals-cascade.test.js(走 POST /api/approvals)。

import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls = { tables: [], queries: [] };
const overrides = { activeEmployees: [], resignedEmployees: [] };

// 用 closure 區分 query — chain 內依 where.status 決定回 active 或 resigned
vi.mock('../lib/supabase.js', () => {
  function chain(table) {
    const c = {};
    let where = {};
    c.select = vi.fn(() => c);
    c.eq = vi.fn((col, val) => { where[col] = val; return c; });
    c.neq = vi.fn((col, val) => { where[`${col}_neq`] = val; return c; });
    c.gte = vi.fn((col, val) => { where[`${col}_gte`] = val; return c; });
    c.lt = vi.fn((col, val) => { where[`${col}_lt`] = val; return c; });
    c.order = vi.fn(() => c);
    c.then = (onF, onR) => {
      // 記下 query for assert
      calls.queries.push({ table, where: { ...where } });
      let data = [];
      if (table === 'employees') {
        if (where.status === 'active') data = overrides.activeEmployees;
        else if (where.status === 'resigned') data = overrides.resignedEmployees;
      }
      return Promise.resolve({ data, error: null }).then(onF, onR);
    };
    return c;
  }
  const client = { from: vi.fn((table) => { calls.tables.push(table); return chain(table); }) };
  return { supabase: client, supabaseAdmin: client };
});

// mock applyExcludeSystemAccountsQuery 為 passthrough(對 unit test 不擋系統帳號、簡化)
// 真正排除靠 client-side excludeSystemAccounts in handler、不在 repo helper 內
vi.mock('../lib/salary/system-accounts.js', () => ({
  applyExcludeSystemAccountsQuery: (q) => q,
  excludeSystemAccounts: (arr) => arr,
  isSystemAccount: () => false,
}));

const { makeSalaryRepo } = await import('../api/salary/_repo.js');

beforeEach(() => {
  calls.tables = []; calls.queries = [];
  overrides.activeEmployees = [];
  overrides.resignedEmployees = [];
});

describe('B26.7 listEmployeesForPayroll', () => {
  it('撈 active 5 人 + 該月離職 2 人(5/13 / 4/30)→ 結果含 active 5 + 5/13 1 人 = 6 人', async () => {
    const repo = makeSalaryRepo();
    overrides.activeEmployees = [
      { id: 'E1', name: 'A', base_salary: 30000 },
      { id: 'E2', name: 'B', base_salary: 35000 },
      { id: 'E3', name: 'C', base_salary: 40000 },
      { id: 'E4', name: 'D', base_salary: 32000 },
      { id: 'E5', name: 'E', base_salary: 28000 },
    ];
    overrides.resignedEmployees = [
      // 5/13 離職:在 query period(2026-05)內 → 撈到
      { id: 'EMP_01251101', name: '柯郁含', base_salary: 30000, resigned_at: '2026-05-13T00:00:00+08:00' },
      // (4/30 離職的不會被 query 撈到、因 .lt('resigned_at','2026-06-01')AND .gte('resigned_at','2026-05-01')
      //  filter 由 supabase 端做、mock 模擬:resigned 陣列只放「假設 query 撈到的」結果)
    ];

    const result = await repo.listEmployeesForPayroll(2026, 5);
    expect(result).toHaveLength(6);
    expect(result.map(e => e.id).sort()).toEqual(
      ['E1', 'E2', 'E3', 'E4', 'E5', 'EMP_01251101'].sort()
    );

    // 驗 2 條獨立 query 都跑(active + resigned 各 1 條)
    const employeeQueries = calls.queries.filter(q => q.table === 'employees');
    expect(employeeQueries).toHaveLength(2);

    // 驗 active query:status='active'、無 resigned_at filter
    const activeQ = employeeQueries.find(q => q.where.status === 'active');
    expect(activeQ).toBeDefined();
    expect(activeQ.where.resigned_at_gte).toBeUndefined();

    // 驗 resigned query:status='resigned' + resigned_at gte/lt 期間
    const resignedQ = employeeQueries.find(q => q.where.status === 'resigned');
    expect(resignedQ).toBeDefined();
    expect(resignedQ.where.resigned_at_gte).toBe('2026-05-01T00:00:00+08:00');
    expect(resignedQ.where.resigned_at_lt).toBe('2026-06-01T00:00:00+08:00');
  });

  it('12 月特殊 case:periodEnd 跨年到 2027-01', async () => {
    const repo = makeSalaryRepo();
    overrides.activeEmployees = [];
    overrides.resignedEmployees = [];

    await repo.listEmployeesForPayroll(2026, 12);

    const resignedQ = calls.queries.find(q =>
      q.table === 'employees' && q.where.status === 'resigned');
    expect(resignedQ.where.resigned_at_gte).toBe('2026-12-01T00:00:00+08:00');
    expect(resignedQ.where.resigned_at_lt).toBe('2027-01-01T00:00:00+08:00');
  });

  it('active + resigned 都空 → return []', async () => {
    const repo = makeSalaryRepo();
    overrides.activeEmployees = [];
    overrides.resignedEmployees = [];
    const result = await repo.listEmployeesForPayroll(2026, 5);
    expect(result).toEqual([]);
  });
});
