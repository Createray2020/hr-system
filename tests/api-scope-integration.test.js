// tests/api-scope-integration.test.js — Phase 2 endpoint auth gate + scope dispatch
//
// 重點:
// 1. 兩個曾經完全裸奔的 endpoint 必須回 401(regression、最嚴重的安全 bug)
// 2. 員工帶他人 employee_id 必須 403(canSeeEmployee 串接)
// 3. scope mode 對應正確 SQL chain(self → .eq、dept → .in、all → 不過濾)
//
// 策略:mock lib/supabase + lib/auth + lib/push、攔截 chain calls 驗 behavior。
// 不驗 PG 真的會 filter(supabase-js 細節、prod e2e 已驗)、只防 wiring 漏接。

import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls = { tables: [], eqs: [], ins: [] };
const overrides = { caller: null };  // null = mock requireAuth 回 null = 401

vi.mock('../lib/supabase.js', () => {
  function chain(table) {
    const c = {};
    c.select = vi.fn(() => c);
    c.eq = vi.fn((col, val) => { calls.eqs.push({ table, col, val }); return c; });
    c.neq = vi.fn(() => c);
    c.in = vi.fn((col, vals) => { calls.ins.push({ table, col, vals }); return c; });
    c.gte = vi.fn(() => c); c.lte = vi.fn(() => c);
    c.lt = vi.fn(() => c); c.gt = vi.fn(() => c);
    c.or = vi.fn(() => c); c.order = vi.fn(() => c); c.limit = vi.fn(() => c);
    // 預設成功(data=null + error=null)、scope 通過時 200;若特定 test 要 404、自己 override
    c.single = vi.fn(() => Promise.resolve({ data: null, error: null }));
    c.maybeSingle = vi.fn(() => Promise.resolve({ data: null, error: null }));
    // 所有的 dept emp ids fetch 預設回空 array(對 employees table)
    c.then = (onF, onR) => Promise.resolve({ data: [], error: null }).then(onF, onR);
    return c;
  }
  const client = {
    from: vi.fn((table) => { calls.tables.push(table); return chain(table); }),
  };
  return { supabase: client, supabaseAdmin: client };
});

vi.mock('../lib/auth.js', () => ({
  requireAuth: vi.fn(async (req, res) => {
    if (!overrides.caller) { res.status(401).json({ error: 'Unauthorized' }); return null; }
    return overrides.caller;
  }),
  requireRole: vi.fn(async (req, res) => {
    if (!overrides.caller) { res.status(401).json({ error: 'Unauthorized' }); return null; }
    return overrides.caller;
  }),
  getAuthUser: vi.fn(async () => null),
  getEmployee: vi.fn(async () => null),
}));

vi.mock('../lib/push.js', () => ({
  sendPushToEmployees: vi.fn(async () => ({ sent: 0 })),
  sendPushToRoles: vi.fn(async () => ({ sent: 0 })),
  createNotification: vi.fn(async () => undefined),
  createNotifications: vi.fn(async () => undefined),
  createNotificationsForRoles: vi.fn(async () => undefined),
}));

const { default: leavesHandler } = await import('../api/leaves/index.js');
const { default: leavesByIdHandler } = await import('../api/leaves/[id].js');
const { default: employeesHandler } = await import('../api/employees/index.js');
const { default: employeesByIdHandler } = await import('../api/employees/[id].js');
const { default: schedulesHandler } = await import('../api/schedules/index.js');

function makeReqRes({ method = 'GET', query = {}, body = null } = {}) {
  const res = {
    statusCode: 200, body: undefined,
    status(c) { this.statusCode = c; return this; },
    json(p) { this.body = p; return this; },
    end() { return this; },
  };
  return [{ method, query, body, headers: {} }, res];
}

beforeEach(() => {
  calls.tables = []; calls.eqs = []; calls.ins = [];
  overrides.caller = null;
});

const HR  = { id: 'HR1', role: 'hr',       is_manager: false, dept_id: 'D_HR' };
const MGR = { id: 'M1',  role: 'employee', is_manager: true,  dept_id: 'D1' };
const EMP = { id: 'E1',  role: 'employee', is_manager: false, dept_id: 'D1' };

// ════════════════════════════════════════════════════════════
// /api/leaves auth gate regression(最嚴重的修補)
// ════════════════════════════════════════════════════════════
describe('/api/leaves — auth gate regression(原本完全裸奔)', () => {
  it('handleGetAnnualBalance 未登入 → 401(原 bug)', async () => {
    const [req, res] = makeReqRes({ query: { annual_balance: 'true', employee_id: 'any' } });
    await leavesHandler(req, res);
    expect(res.statusCode).toBe(401);
  });

  it('handleNewGet 未登入 → 401(原 bug)', async () => {
    const [req, res] = makeReqRes({ query: { employee_id: 'any', year: '2026' } });
    await leavesHandler(req, res);
    expect(res.statusCode).toBe(401);
  });

  it('legacy GET ?id=X 未登入 → 401(原 bug)', async () => {
    const [req, res] = makeReqRes({ query: { id: 'L_any' } });
    await leavesHandler(req, res);
    expect(res.statusCode).toBe(401);
  });

  it('legacy GET ?stats=true 未登入 → 401(原 bug)', async () => {
    const [req, res] = makeReqRes({ query: { stats: 'true' } });
    await leavesHandler(req, res);
    expect(res.statusCode).toBe(401);
  });
});

// ════════════════════════════════════════════════════════════
// /api/leaves scope dispatch
// ════════════════════════════════════════════════════════════
describe('/api/leaves handleNewGet — scope dispatch', () => {
  it('員工查自己 → .eq employee_id=self', async () => {
    overrides.caller = EMP;
    const [req, res] = makeReqRes({ query: { employee_id: 'E1', year: '2026' } });
    await leavesHandler(req, res);
    const eq = calls.eqs.find(e => e.table === 'leave_requests' && e.col === 'employee_id');
    expect(eq?.val).toBe('E1');
  });

  it('員工查他人 → 403', async () => {
    overrides.caller = EMP;
    const [req, res] = makeReqRes({ query: { employee_id: 'E_other', year: '2026' } });
    await leavesHandler(req, res);
    expect(res.statusCode).toBe(403);
  });

  it('HR 查任何人 → 通過、.eq employee_id=查的人', async () => {
    overrides.caller = HR;
    const [req, res] = makeReqRes({ query: { employee_id: 'E_other', year: '2026' } });
    await leavesHandler(req, res);
    expect(res.statusCode).toBe(200);
    const eq = calls.eqs.find(e => e.table === 'leave_requests' && e.col === 'employee_id');
    expect(eq?.val).toBe('E_other');
  });

  it('HR 不帶 employee_id → 不加 employee_id filter(看全公司)', async () => {
    overrides.caller = HR;
    const [req, res] = makeReqRes({ query: { year: '2026' } });
    await leavesHandler(req, res);
    expect(res.statusCode).toBe(200);
    const eq = calls.eqs.find(e => e.table === 'leave_requests' && e.col === 'employee_id');
    expect(eq).toBeUndefined();
  });

  it('員工不帶 employee_id → 自動 .eq self', async () => {
    overrides.caller = EMP;
    const [req, res] = makeReqRes({ query: { year: '2026' } });
    await leavesHandler(req, res);
    const eq = calls.eqs.find(e => e.table === 'leave_requests' && e.col === 'employee_id');
    expect(eq?.val).toBe('E1');
  });
});

// ════════════════════════════════════════════════════════════
// /api/employees scope dispatch
// ════════════════════════════════════════════════════════════
describe('/api/employees 通用 GET — scope dispatch', () => {
  it('員工 → .eq id=self', async () => {
    overrides.caller = EMP;
    const [req, res] = makeReqRes({ query: {} });
    await employeesHandler(req, res);
    const eq = calls.eqs.find(e => e.table === 'employees' && e.col === 'id');
    expect(eq?.val).toBe('E1');
  });

  it('HR → 不加 id filter', async () => {
    overrides.caller = HR;
    const [req, res] = makeReqRes({ query: {} });
    await employeesHandler(req, res);
    const eq = calls.eqs.find(e => e.table === 'employees' && e.col === 'id');
    expect(eq).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════
// /api/employees/[id] GET — row-level scope filter
// ════════════════════════════════════════════════════════════
describe('/api/employees/[id] GET — row-level scope filter', () => {
  it('員工查自己 → 通過(200)', async () => {
    overrides.caller = EMP;
    const [req, res] = makeReqRes({ query: { id: 'E1' } });
    await employeesByIdHandler(req, res);
    expect(res.statusCode).toBe(200);
  });

  it('員工查他人 → 403', async () => {
    overrides.caller = EMP;
    const [req, res] = makeReqRes({ query: { id: 'E_other' } });
    await employeesByIdHandler(req, res);
    expect(res.statusCode).toBe(403);
  });

  it('主管查自己 → 200(scope.selfId 永遠通過)', async () => {
    overrides.caller = MGR;
    const [req, res] = makeReqRes({ query: { id: 'M1' } });
    await employeesByIdHandler(req, res);
    expect(res.statusCode).toBe(200);
  });

  it('主管查不在本部門的他人 → 403(mock deptEmpIds 為空)', async () => {
    overrides.caller = MGR;
    const [req, res] = makeReqRes({ query: { id: 'E_other_dept' } });
    await employeesByIdHandler(req, res);
    expect(res.statusCode).toBe(403);
  });

  it('HR 查任何人 → 200(scope.mode=all、永遠通過)', async () => {
    overrides.caller = HR;
    const [req, res] = makeReqRes({ query: { id: 'E_any' } });
    await employeesByIdHandler(req, res);
    expect(res.statusCode).toBe(200);
  });

  it('未登入查任何 id → 401(requireAuth 擋)', async () => {
    // overrides.caller = null(beforeEach 預設)
    const [req, res] = makeReqRes({ query: { id: 'E1' } });
    await employeesByIdHandler(req, res);
    expect(res.statusCode).toBe(401);
  });
});

// ════════════════════════════════════════════════════════════
// /api/schedules scope dispatch
// ════════════════════════════════════════════════════════════
describe('/api/schedules legacy GET — scope dispatch', () => {
  it('員工 → .eq employee_id=self', async () => {
    overrides.caller = EMP;
    const [req, res] = makeReqRes({ query: { start: '2026-05-01', end: '2026-05-07' } });
    await schedulesHandler(req, res);
    const eq = calls.eqs.find(e => e.table === 'schedules' && e.col === 'employee_id');
    expect(eq?.val).toBe('E1');
  });

  it('員工查他人 → 403', async () => {
    overrides.caller = EMP;
    const [req, res] = makeReqRes({ query: { employee_id: 'E_other', start: '2026-05-01', end: '2026-05-07' } });
    await schedulesHandler(req, res);
    expect(res.statusCode).toBe(403);
  });

  it('HR 不帶 employee_id → 不加 filter', async () => {
    overrides.caller = HR;
    const [req, res] = makeReqRes({ query: { start: '2026-05-01', end: '2026-05-07' } });
    await schedulesHandler(req, res);
    const eq = calls.eqs.find(e => e.table === 'schedules' && e.col === 'employee_id');
    expect(eq).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════
// Phase 1.6.1 regression — admin cancel hack 拔除守
// ════════════════════════════════════════════════════════════
describe('/api/leaves/[id] PUT decision=cancel — Phase 1.6.1 regression', () => {
  it('HR PUT decision=cancel → 400 BAD_REQUEST(死 code 已拔、白名單只剩 approve/reject/terminate)', async () => {
    overrides.caller = HR;
    const [req, res] = makeReqRes({
      method: 'PUT',
      query: { id: 'L_any' },
      body: { decision: 'cancel' },
    });
    await leavesByIdHandler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body?.error).toMatch(/decision must be approve \/ reject \/ terminate/);
  });
});
