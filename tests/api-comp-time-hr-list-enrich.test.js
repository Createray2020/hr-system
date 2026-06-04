// tests/api-comp-time-hr-list-enrich.test.js
// 2026-06-05:
//   1) HR-list 每筆 remaining_hours / total_remaining round2(浮點 69.5-25.13 = 44.37、非 44.370000000000005)
//   2) records[].source enrich:
//      - source_overtime_request_id 查得到 → { id, overtime_date, hours, reason, status }
//      - 有 id 但 overtime_requests 查不到 → { id }
//      - null → source=null
//   3) 無任何非 null id → 跳過 IN-query(觀察 supabase.from 是否被呼叫到 overtime_requests)

import { describe, it, expect, vi, beforeEach } from 'vitest';

const overrides = {
  caller: null,
  // comp_time_balance rows;by_table.tables 紀錄 from() 被呼叫的 table 名
  ctbRows: [],
  empRows: [],
  otRows: [],
};
const byTable = { tables: [], inCalls: [] };

vi.mock('../lib/supabase.js', () => {
  function chain(table) {
    const c = { _table: table };
    c.select = vi.fn(() => c);
    c.eq = vi.fn(() => c);
    c.in = vi.fn((col, vals) => { byTable.inCalls.push({ table, col, vals }); return c; });
    c.is = vi.fn(() => c);
    c.neq = vi.fn(() => c);
    c.gte = vi.fn(() => c); c.lte = vi.fn(() => c);
    c.lt = vi.fn(() => c); c.gt = vi.fn(() => c);
    c.or = vi.fn(() => c);
    c.order = vi.fn(() => c);
    c.limit = vi.fn(() => c);
    c.single = vi.fn(() => Promise.resolve({ data: null, error: null }));
    c.maybeSingle = vi.fn(() => Promise.resolve({ data: null, error: null }));
    c.then = (onF, onR) => {
      let data = [];
      if (table === 'comp_time_balance') data = overrides.ctbRows;
      else if (table === 'employees')   data = overrides.empRows;
      else if (table === 'overtime_requests') data = overrides.otRows;
      return Promise.resolve({ data, error: null }).then(onF, onR);
    };
    return c;
  }
  const client = { from: vi.fn((t) => { byTable.tables.push(t); return chain(t); }) };
  return { supabase: client, supabaseAdmin: client };
});

vi.mock('../lib/auth.js', () => ({
  requireAuth: vi.fn(async (req, res) => {
    if (!overrides.caller) { res.status(401).json({ error: 'Unauthorized' }); return null; }
    return overrides.caller;
  }),
  requireRole: vi.fn(async () => overrides.caller),
}));

// roles:isBackofficeRole 真實版,直接吃 caller.role
vi.mock('../lib/roles.js', () => ({
  isBackofficeRole: (emp) => !!emp && ['hr','ceo','chairman','admin'].includes(emp.role),
  BACKOFFICE_ROLES: ['hr','ceo','chairman','admin'],
  canAccessBackoffice: (emp) => !!emp && ['hr','ceo','chairman','admin'].includes(emp.role),
}));

vi.mock('../lib/dept-name-mapper.js', () => ({
  addDeptName: vi.fn(),
  addDeptNameSingle: vi.fn(),
  addDeptNameNested: vi.fn(),
  attachManagerNames: vi.fn(async (rows) => rows),
}));

vi.mock('../lib/salary/system-accounts.js', () => ({
  applyExcludeSystemAccountsQuery: (q) => q,
  isSystemAccount: () => false,
  excludeSystemAccounts: (rows) => rows,
}));

// 避免拉進真實 salaryRepo / leaveRepo(view=expiry 路徑用不到,但 import 時走 supabase env)
vi.mock('../api/leaves/_repo.js', () => ({ makeLeaveRepo: vi.fn(() => ({})) }));
vi.mock('../api/salary/_repo.js', () => ({ makeSalaryRepo: vi.fn(() => ({})) }));

// getCompBalance (lib/comp-time/balance.js) — single-emp branch 不在本檔測,nop
vi.mock('../lib/comp-time/balance.js', () => ({
  getCompBalance: vi.fn(async () => ({ total_remaining: 0, records: [] })),
}));

const { default: handler } = await import('../api/comp-time/index.js');

function makeReqRes({ query = {} } = {}) {
  const res = {
    statusCode: 200, body: undefined,
    status(c) { this.statusCode = c; return this; },
    json(p) { this.body = p; return this; },
    end() { return this; },
  };
  return [{ method: 'GET', query, body: null, headers: {} }, res];
}

beforeEach(() => {
  overrides.caller = { id: 'HR1', role: 'hr', is_manager: false, dept_id: null };
  overrides.ctbRows = [];
  overrides.empRows = [];
  overrides.otRows = [];
  byTable.tables = [];
  byTable.inCalls = [];
});

describe('GET /api/comp-time HR-list — round2 修浮點', () => {
  it('單員工單筆 earned=69.5 / used=25.13 → remaining 嚴格 === 44.37、total === 44.37', async () => {
    overrides.ctbRows = [{
      id: 1, employee_id: 'E001', source_overtime_request_id: null,
      earned_at: '2026-01-01T00:00:00Z', expires_at: '2027-01-01',
      earned_hours: 69.5, used_hours: 25.13, status: 'active', admin_audit_note: null,
    }];
    const [req, res] = makeReqRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    const emp = res.body.employees[0];
    expect(emp.records[0].remaining_hours).toBe(44.37);  // === ;不是 44.370000000000005
    expect(emp.total_remaining).toBe(44.37);
  });

  it('多筆累加 1.5 + 1.37 = 2.87(non-binary 浮點)→ total === 2.87', async () => {
    overrides.ctbRows = [
      { id: 1, employee_id: 'E1', source_overtime_request_id: null, earned_at: 'x', expires_at: '2026-09-30', earned_hours: 45.5, used_hours: 44,    status: 'active' },
      { id: 2, employee_id: 'E1', source_overtime_request_id: null, earned_at: 'x', expires_at: '2026-10-02', earned_hours: 7.5,  used_hours: 6.13,  status: 'active' },
    ];
    const [req, res] = makeReqRes();
    await handler(req, res);
    const emp = res.body.employees[0];
    expect(emp.records[0].remaining_hours).toBe(1.5);
    expect(emp.records[1].remaining_hours).toBe(1.37);
    expect(emp.total_remaining).toBe(2.87);
  });
});

describe('GET /api/comp-time HR-list — records[].source enrich', () => {
  it('有 source_overtime_request_id + overtime_requests 查得到 → source 含完整欄位', async () => {
    overrides.ctbRows = [
      { id: 10, employee_id: 'E1', source_overtime_request_id: 99, earned_at: 'x', expires_at: '2027-01-01', earned_hours: 8, used_hours: 0, status: 'active' },
    ];
    overrides.otRows = [
      { id: 99, overtime_date: '2025-12-01', hours: 8, reason: '系統 deploy', status: 'approved' },
    ];
    const [req, res] = makeReqRes();
    await handler(req, res);
    const rec = res.body.employees[0].records[0];
    expect(rec.source).toEqual({
      id: 99,
      overtime_date: '2025-12-01',
      hours: 8,
      reason: '系統 deploy',
      status: 'approved',
    });
  });

  it('有 source_overtime_request_id 但 overtime_requests 查不到 → source = { id } 保底', async () => {
    overrides.ctbRows = [
      { id: 11, employee_id: 'E2', source_overtime_request_id: 12345, earned_at: 'x', expires_at: '2027-01-01', earned_hours: 4, used_hours: 0, status: 'active' },
    ];
    overrides.otRows = [];  // 查不到
    const [req, res] = makeReqRes();
    await handler(req, res);
    const rec = res.body.employees[0].records[0];
    expect(rec.source).toEqual({ id: 12345 });
  });

  it('source_overtime_request_id 為 null → source = null', async () => {
    overrides.ctbRows = [
      { id: 12, employee_id: 'E3', source_overtime_request_id: null, earned_at: 'x', expires_at: '2027-01-01', earned_hours: 4, used_hours: 0, status: 'active' },
    ];
    const [req, res] = makeReqRes();
    await handler(req, res);
    const rec = res.body.employees[0].records[0];
    expect(rec.source).toBeNull();
  });

  it('無任何非 null source id → 不發 IN-query overtime_requests', async () => {
    overrides.ctbRows = [
      { id: 20, employee_id: 'E1', source_overtime_request_id: null, earned_at: 'x', expires_at: '2027-01-01', earned_hours: 4, used_hours: 0, status: 'active' },
      { id: 21, employee_id: 'E2', source_overtime_request_id: null, earned_at: 'x', expires_at: '2027-01-01', earned_hours: 4, used_hours: 0, status: 'active' },
    ];
    const [req, res] = makeReqRes();
    await handler(req, res);
    // tables 內不該出現 overtime_requests
    expect(byTable.tables).not.toContain('overtime_requests');
    // 兩筆 records 都 source=null
    const recs = res.body.employees.flatMap(e => e.records);
    expect(recs.every(r => r.source === null)).toBe(true);
  });

  it('混合(部分有 id 部分 null + 部分查不到):各別 source 正確、IN-query 只發一次', async () => {
    overrides.ctbRows = [
      { id: 30, employee_id: 'E1', source_overtime_request_id: 100,  earned_at: 'x', expires_at: '2027-01-01', earned_hours: 4, used_hours: 0, status: 'active' },
      { id: 31, employee_id: 'E1', source_overtime_request_id: 999,  earned_at: 'x', expires_at: '2027-01-01', earned_hours: 4, used_hours: 0, status: 'active' },
      { id: 32, employee_id: 'E2', source_overtime_request_id: null, earned_at: 'x', expires_at: '2027-01-01', earned_hours: 4, used_hours: 0, status: 'active' },
    ];
    overrides.otRows = [
      { id: 100, overtime_date: '2025-11-11', hours: 2, reason: 'r1', status: 'approved' },
      // id=999 查不到
    ];
    const [req, res] = makeReqRes();
    await handler(req, res);
    const recs = res.body.employees.flatMap(e => e.records);
    const byId = Object.fromEntries(recs.map(r => [r.id, r]));
    expect(byId[30].source).toEqual({ id: 100, overtime_date: '2025-11-11', hours: 2, reason: 'r1', status: 'approved' });
    expect(byId[31].source).toEqual({ id: 999 });
    expect(byId[32].source).toBeNull();
    // 應該只發一次 IN-query overtime_requests(id IN [100, 999])
    const otIn = byTable.inCalls.filter(c => c.table === 'overtime_requests');
    expect(otIn).toHaveLength(1);
    expect(otIn[0].vals.sort()).toEqual([100, 999]);
  });
});

// ─── quota_summary round2 整合驗證(對齊 f7d5403 contract)─────
// 直接 import handler(api/leaves/index.js)、mock supabase + repo,confirm comp.records 也 round2
describe('quota_summary comp.records — round2', () => {
  it('records[].remaining_hours 對 44.37 真正等值、total_remaining_hours 也是 round 後', async () => {
    // 重設模組快取 + 設 mock(quota_summary 已有自己的 test 檔但不測 round2 具體值)
    vi.resetModules();

    const compBalances = [
      { id: 1, earned_at: 'x', earned_hours: 69.5, expires_at: '2027-01-01', used_hours: 25.13, remaining_hours: 44.370000000000005, status: 'active' },
    ];

    vi.doMock('../lib/supabase.js', () => {
      const c = {
        select: vi.fn(()=>c), eq: vi.fn(()=>c), in: vi.fn(()=>c), is: vi.fn(()=>c),
        neq: vi.fn(()=>c), gte: vi.fn(()=>c), lte: vi.fn(()=>c), lt: vi.fn(()=>c), gt: vi.fn(()=>c),
        or: vi.fn(()=>c), order: vi.fn(()=>c), limit: vi.fn(()=>c),
        single: vi.fn(() => Promise.resolve({ data: null, error: null })),
        maybeSingle: vi.fn(() => Promise.resolve({ data: null, error: null })),
        then: (onF) => Promise.resolve({ data: [], error: null }).then(onF),
      };
      const client = { from: vi.fn(() => c) };
      return { supabase: client, supabaseAdmin: client };
    });
    vi.doMock('../lib/auth.js', () => ({
      requireAuth: vi.fn(async () => ({ id: 'HR1', role: 'hr' })),
      requireRole: vi.fn(async () => ({ id: 'HR1', role: 'hr' })),
    }));
    vi.doMock('../lib/auth-scope.js', () => ({
      resolveAuthScopeWithDeptIds: vi.fn(async () => ({ mode: 'all' })),
      makeDeptEmpIdsRepo: vi.fn(() => ({})),
      canSeeEmployee: vi.fn(() => true),
    }));
    vi.doMock('../lib/leave/balance.js', () => ({
      getAnnualBalance: vi.fn(async () => ({ has_record: false, legal_days: 0, granted_days: 0, used_days: 0, remaining_days: 0, period_start: null, period_end: null })),
    }));
    vi.doMock('../lib/leave/quota.js', () => ({
      ACCUMULATING_LEAVE_CODES: ['sick'],
      calculateAccumulatingUsage: vi.fn(async () => []),
      getCurrentYearInTaipei: vi.fn(() => 2026),
    }));
    vi.doMock('../lib/dept-name-mapper.js', () => ({
      addDeptName: vi.fn(), addDeptNameSingle: vi.fn(),
      addDeptNameNested: vi.fn(), attachManagerNames: vi.fn(async (rows) => rows),
    }));
    vi.doMock('../lib/push.js', () => ({
      sendPushToEmployees: vi.fn(), sendPushToRoles: vi.fn(),
      createNotification: vi.fn(), createNotifications: vi.fn(),
      createNotificationsForRoles: vi.fn(),
    }));
    vi.doMock('../api/leaves/_repo.js', () => ({
      makeLeaveRepo: vi.fn(() => ({
        findActiveCompBalances: vi.fn(async () => compBalances),
        findAnnualRecordCoveringDate: vi.fn(async () => null),
        sumLeaveDaysByTypeInYear: vi.fn(async () => []),
      })),
    }));

    const { default: leavesHandler } = await import('../api/leaves/index.js');
    const res = {
      statusCode: 200, body: undefined,
      status(c) { this.statusCode = c; return this; },
      json(p) { this.body = p; return this; },
      end() { return this; },
    };
    await leavesHandler({
      method: 'GET',
      query: { _resource: 'quota_summary', employee_id: 'EMP_X' },
      body: null, headers: {},
    }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.comp.records[0].remaining_hours).toBe(44.37);
    expect(res.body.comp.total_remaining_hours).toBe(44.37);
  });
});
