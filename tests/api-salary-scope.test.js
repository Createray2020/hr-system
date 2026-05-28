// tests/api-salary-scope.test.js — B1 Commit D:/api/salary endpoint scope 整合測試(B1 最後)
//
// 目標:把後端 auth + role gate 行為鎖進測試。本檔不改任何 prod 行為、純記錄現況。
//
// salary 設計上比其他端點嚴格 — **沒有主管中間層**(by-design、薪資隱私):
//   - 員工只看自己薪資(新 GET ?v=2)
//   - 主管(role=employee, is_manager=true)→ isBackofficeRole=false → 跟員工同層、
//     主管查部門員工薪資會被擋 403
//   - HR / admin / ceo / chairman 看全公司
//
// 本檔特別 lock「主管查部門薪資 → 403」這條 invariant,防未來誤開「主管看薪資」。
//
// 涵蓋 api/salary/index.js + [id].js + recalculate.js 三個 handler。

import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls = { tables: [], eqs: [], ins: [], selects: [], updates: [], inserts: [] };
const overrides = {
  caller: null,
  salaryRecordRow: null,    // [id].js fetch existing 用
  payrollPeriodRow: null,   // assertPeriodNotLocked 用
};

vi.mock('../lib/supabase.js', () => {
  function chain(table) {
    const c = {};
    c.select = vi.fn((cols) => { calls.selects.push({ table, cols }); return c; });
    c.eq = vi.fn((col, val) => { calls.eqs.push({ table, col, val }); return c; });
    c.neq = vi.fn(() => c);
    c.in = vi.fn((col, vals) => { calls.ins.push({ table, col, vals }); return c; });
    c.is = vi.fn(() => c);    // B7 修補
    c.gte = vi.fn(() => c); c.lte = vi.fn(() => c);
    c.lt = vi.fn(() => c); c.gt = vi.fn(() => c);
    c.or = vi.fn(() => c); c.order = vi.fn(() => c); c.limit = vi.fn(() => c);
    c.insert = vi.fn((rows) => { calls.inserts.push({ table, rows }); return c; });
    c.update = vi.fn((patch) => { calls.updates.push({ table, patch }); return c; });
    c.upsert = vi.fn((rows) => { calls.inserts.push({ table, rows, upsert: true }); return c; });
    c.delete = vi.fn(() => c);
    c.single = vi.fn(() => Promise.resolve({ data: null, error: null }));
    c.maybeSingle = vi.fn(() => {
      if (table === 'salary_records') return Promise.resolve({ data: overrides.salaryRecordRow, error: null });
      if (table === 'payroll_periods') return Promise.resolve({ data: overrides.payrollPeriodRow, error: null });
      return Promise.resolve({ data: null, error: null });
    });
    c.then = (onF, onR) => Promise.resolve({ data: [], error: null }).then(onF, onR);
    return c;
  }
  const client = { from: vi.fn((table) => { calls.tables.push(table); return chain(table); }) };
  return { supabase: client, supabaseAdmin: client };
});

vi.mock('../lib/auth.js', () => ({
  requireAuth: vi.fn(async (req, res) => {
    if (!overrides.caller) { res.status(401).json({ error: 'Unauthorized' }); return null; }
    return overrides.caller;
  }),
  requireRole: vi.fn(async (req, res, allowedRoles, opts) => {
    if (!overrides.caller) { res.status(401).json({ error: 'Unauthorized' }); return null; }
    const passRole = allowedRoles.includes(overrides.caller.role);
    const passMgr = opts?.allowManager === true && overrides.caller.is_manager === true;
    if (!passRole && !passMgr) {
      res.status(403).json({ error: 'Forbidden' });
      return null;
    }
    return overrides.caller;
  }),
  getAuthUser: vi.fn(async () => null),
  getEmployee: vi.fn(async () => null),
}));

vi.mock('../lib/dept-name-mapper.js', () => ({
  addDeptName: vi.fn(),
  addDeptNameNested: vi.fn(),
  addDeptNameSingle: vi.fn(),
}));

// salary_calculator / period-state / period-stats mock,避免進真實 lib 運算
vi.mock('../lib/salary/calculator.js', () => ({
  calculateMonthlySalary: vi.fn(async () => ({
    record: { id: 'S_NEW', employee_id: 'E1', year: 2026, month: 5 },
    breakdown: {},
  })),
}));

vi.mock('../lib/salary/period-state.js', () => ({
  canExecuteTransition: vi.fn(() => ({ ok: true })),
}));

vi.mock('../lib/salary/period-stats.js', () => ({
  reconcilePeriodStats: vi.fn(async () => ({
    employee_count: 0, gross_total: 0, net_total: 0, employer_cost_total: 0,
  })),
}));

// system-accounts:passthrough 避免 .neq 干擾 calls assertion
vi.mock('../lib/salary/system-accounts.js', () => ({
  isSystemAccount: vi.fn((id) => id === 'EMP_99999999'),
  excludeSystemAccounts: vi.fn((arr) => arr),
  applyExcludeSystemAccountsQuery: vi.fn((q) => q),
}));

// _repo:stub 全部方法、避免 import 時 supabase env 要求
vi.mock('../api/salary/_repo.js', () => ({
  makeSalaryRepo: vi.fn(() => ({
    listEmployeesForPayroll: vi.fn(async () => []),
    findActivePayrollPeriod: vi.fn(async () => null),
    updatePayrollPeriod: vi.fn(async () => undefined),
    listSalaryRecords: vi.fn(async () => []),
  })),
}));

const { default: salaryHandler } = await import('../api/salary/index.js');
const { default: salaryByIdHandler } = await import('../api/salary/[id].js');
const { default: recalcHandler } = await import('../api/salary/recalculate.js');

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
  calls.selects = []; calls.updates = []; calls.inserts = [];
  overrides.caller = null;
  overrides.salaryRecordRow = null;
  overrides.payrollPeriodRow = null;
});

const HR       = { id: 'HR1',  role: 'hr',       is_manager: false, dept_id: 'D_HR' };
const ADMIN    = { id: 'A1',   role: 'admin',    is_manager: false, dept_id: 'D_X' };
const CEO      = { id: 'C1',   role: 'ceo',      is_manager: false, dept_id: 'D_EXEC' };
const CHAIRMAN = { id: 'CH1',  role: 'chairman', is_manager: false, dept_id: 'D_EXEC' };
const MGR      = { id: 'M1',   role: 'employee', is_manager: true,  dept_id: 'D1' };
const EMP      = { id: 'E1',   role: 'employee', is_manager: false, dept_id: 'D1' };

// ════════════════════════════════════════════════════════════
// auth gate — 未登入應 401(各需 auth path)
// ════════════════════════════════════════════════════════════
describe('/api/salary — auth gate(未登入 → 401)', () => {
  it('未登入 新 GET ?v=2 → 401', async () => {
    const [req, res] = makeReqRes({ query: { v: '2' } });
    await salaryHandler(req, res);
    expect(res.statusCode).toBe(401);
  });

  it('未登入 legacy GET → 401', async () => {
    const [req, res] = makeReqRes({ query: {} });
    await salaryHandler(req, res);
    expect(res.statusCode).toBe(401);
  });

  it('未登入 POST batch_v2 → 401', async () => {
    const [req, res] = makeReqRes({ method: 'POST', body: { action: 'batch_v2', year: 2026, month: 5 } });
    await salaryHandler(req, res);
    expect(res.statusCode).toBe(401);
  });

  it('未登入 POST ?_action=batch(legacy)→ 401', async () => {
    const [req, res] = makeReqRes({ method: 'POST', query: { _action: 'batch' }, body: { year: 2026, month: 5 } });
    await salaryHandler(req, res);
    expect(res.statusCode).toBe(401);
  });

  it('未登入 _resource=periods GET → 401', async () => {
    const [req, res] = makeReqRes({ query: { _resource: 'periods' } });
    await salaryHandler(req, res);
    expect(res.statusCode).toBe(401);
  });

  it('未登入 _resource=periods POST → 401', async () => {
    const [req, res] = makeReqRes({
      method: 'POST', query: { _resource: 'periods' },
      body: { year: 2026, month: 5, period_start: '2026-05-01', period_end: '2026-05-31' },
    });
    await salaryHandler(req, res);
    expect(res.statusCode).toBe(401);
  });

  it('未登入 _resource=annual_summary GET → 401', async () => {
    const [req, res] = makeReqRes({ query: { _resource: 'annual_summary', year: '2026' } });
    await salaryHandler(req, res);
    expect(res.statusCode).toBe(401);
  });

  it('未登入 [id].js PUT → 401', async () => {
    const [req, res] = makeReqRes({ method: 'PUT', query: { id: 'S1' }, body: {} });
    await salaryByIdHandler(req, res);
    expect(res.statusCode).toBe(401);
  });

  it('未登入 recalculate.js POST → 401', async () => {
    const [req, res] = makeReqRes({ method: 'POST', body: { employee_id: 'E1', year: 2026, month: 5 } });
    await recalcHandler(req, res);
    expect(res.statusCode).toBe(401);
  });
});

// ════════════════════════════════════════════════════════════
// 新 GET ?v=2 — scope 矩陣(by-design 嚴格、無主管中間層)
// ════════════════════════════════════════════════════════════
describe('/api/salary 新 GET ?v=2 — scope 矩陣', () => {
  it('員工查自己 → 200', async () => {
    overrides.caller = EMP;
    const [req, res] = makeReqRes({ query: { v: '2', employee_id: 'E1' } });
    await salaryHandler(req, res);
    expect(res.statusCode).toBe(200);
  });

  it('員工查他人 → 403', async () => {
    overrides.caller = EMP;
    const [req, res] = makeReqRes({ query: { v: '2', employee_id: 'E_OTHER' } });
    await salaryHandler(req, res);
    expect(res.statusCode).toBe(403);
    expect(res.body?.error).toMatch(/employee can only see own/);
  });

  it('員工不帶 employee_id → 200(自動 queryEmpId=self)', async () => {
    overrides.caller = EMP;
    const [req, res] = makeReqRes({ query: { v: '2' } });
    await salaryHandler(req, res);
    expect(res.statusCode).toBe(200);
  });

  it('⭐ 主管查同部門他人薪資 → 403(by-design 嚴格、薪資隱私、無主管中間層)', async () => {
    // 主管 role='employee' + is_manager=true → isBackofficeRole=false →
    // 走員工路徑、!isHR + employee_id !== caller.id → 403
    overrides.caller = MGR;
    const [req, res] = makeReqRes({ query: { v: '2', employee_id: 'E1' } });
    await salaryHandler(req, res);
    expect(res.statusCode).toBe(403);
    expect(res.body?.error).toMatch(/employee can only see own/);
  });

  it('⭐ 主管查自己薪資 → 200(主管查自己仍可)', async () => {
    overrides.caller = MGR;
    const [req, res] = makeReqRes({ query: { v: '2', employee_id: 'M1' } });
    await salaryHandler(req, res);
    expect(res.statusCode).toBe(200);
  });

  it('HR 查任何人 → 200', async () => {
    overrides.caller = HR;
    const [req, res] = makeReqRes({ query: { v: '2', employee_id: 'E_any' } });
    await salaryHandler(req, res);
    expect(res.statusCode).toBe(200);
  });

  it('HR 不帶 employee_id → 200(看全公司)', async () => {
    overrides.caller = HR;
    const [req, res] = makeReqRes({ query: { v: '2' } });
    await salaryHandler(req, res);
    expect(res.statusCode).toBe(200);
  });
});

// ════════════════════════════════════════════════════════════
// Legacy GET — role gate(BACKOFFICE only、不開 manager)
// ════════════════════════════════════════════════════════════
describe('/api/salary legacy GET — role gate', () => {
  it('員工 → 403', async () => {
    overrides.caller = EMP;
    const [req, res] = makeReqRes({ query: {} });
    await salaryHandler(req, res);
    expect(res.statusCode).toBe(403);
  });

  it('主管 → 403(嚴格 BACKOFFICE、不 allowManager)', async () => {
    overrides.caller = MGR;
    const [req, res] = makeReqRes({ query: {} });
    await salaryHandler(req, res);
    expect(res.statusCode).toBe(403);
  });

  it('HR → 200', async () => {
    overrides.caller = HR;
    const [req, res] = makeReqRes({ query: {} });
    await salaryHandler(req, res);
    expect(res.statusCode).toBe(200);
  });

  it('admin → 200', async () => {
    overrides.caller = ADMIN;
    const [req, res] = makeReqRes({ query: {} });
    await salaryHandler(req, res);
    expect(res.statusCode).toBe(200);
  });

  it('ceo → 200', async () => {
    overrides.caller = CEO;
    const [req, res] = makeReqRes({ query: {} });
    await salaryHandler(req, res);
    expect(res.statusCode).toBe(200);
  });

  it('chairman → 200', async () => {
    overrides.caller = CHAIRMAN;
    const [req, res] = makeReqRes({ query: {} });
    await salaryHandler(req, res);
    expect(res.statusCode).toBe(200);
  });
});

// ════════════════════════════════════════════════════════════
// POST batch_v2 — role gate
// ════════════════════════════════════════════════════════════
describe('/api/salary POST batch_v2 — role gate', () => {
  it('員工 → 403', async () => {
    overrides.caller = EMP;
    const [req, res] = makeReqRes({ method: 'POST', body: { action: 'batch_v2', year: 2026, month: 5 } });
    await salaryHandler(req, res);
    expect(res.statusCode).toBe(403);
  });

  it('主管 → 403(嚴格、不 allowManager)', async () => {
    overrides.caller = MGR;
    const [req, res] = makeReqRes({ method: 'POST', body: { action: 'batch_v2', year: 2026, month: 5 } });
    await salaryHandler(req, res);
    expect(res.statusCode).toBe(403);
  });

  it('HR → 200', async () => {
    overrides.caller = HR;
    const [req, res] = makeReqRes({ method: 'POST', body: { action: 'batch_v2', year: 2026, month: 5 } });
    await salaryHandler(req, res);
    expect(res.statusCode).toBe(200);
  });
});

// ════════════════════════════════════════════════════════════
// POST legacy ?_action=batch — role gate
// ════════════════════════════════════════════════════════════
describe('/api/salary POST ?_action=batch(legacy)— role gate', () => {
  it('員工 → 403', async () => {
    overrides.caller = EMP;
    const [req, res] = makeReqRes({ method: 'POST', query: { _action: 'batch' }, body: { year: 2026, month: 5 } });
    await salaryHandler(req, res);
    expect(res.statusCode).toBe(403);
  });

  it('主管 → 403', async () => {
    overrides.caller = MGR;
    const [req, res] = makeReqRes({ method: 'POST', query: { _action: 'batch' }, body: { year: 2026, month: 5 } });
    await salaryHandler(req, res);
    expect(res.statusCode).toBe(403);
  });

  it('HR → 200', async () => {
    overrides.caller = HR;
    const [req, res] = makeReqRes({ method: 'POST', query: { _action: 'batch' }, body: { year: 2026, month: 5 } });
    await salaryHandler(req, res);
    expect(res.statusCode).toBe(200);
  });
});

// ════════════════════════════════════════════════════════════
// _resource=periods — role gate(BACKOFFICE only)
// ════════════════════════════════════════════════════════════
describe('/api/salary _resource=periods — role gate', () => {
  it('GET 員工 → 403', async () => {
    overrides.caller = EMP;
    const [req, res] = makeReqRes({ query: { _resource: 'periods' } });
    await salaryHandler(req, res);
    expect(res.statusCode).toBe(403);
  });

  it('GET 主管 → 403(嚴格、不 allowManager)', async () => {
    overrides.caller = MGR;
    const [req, res] = makeReqRes({ query: { _resource: 'periods' } });
    await salaryHandler(req, res);
    expect(res.statusCode).toBe(403);
  });

  it('GET HR → 200', async () => {
    overrides.caller = HR;
    const [req, res] = makeReqRes({ query: { _resource: 'periods' } });
    await salaryHandler(req, res);
    expect(res.statusCode).toBe(200);
  });

  it('POST 員工 → 403', async () => {
    overrides.caller = EMP;
    const [req, res] = makeReqRes({
      method: 'POST', query: { _resource: 'periods' },
      body: { year: 2026, month: 5, period_start: '2026-05-01', period_end: '2026-05-31' },
    });
    await salaryHandler(req, res);
    expect(res.statusCode).toBe(403);
  });

  it('POST HR + 完整 body → 201', async () => {
    overrides.caller = HR;
    const [req, res] = makeReqRes({
      method: 'POST', query: { _resource: 'periods' },
      body: { year: 2026, month: 5, period_start: '2026-05-01', period_end: '2026-05-31' },
    });
    await salaryHandler(req, res);
    expect(res.statusCode).toBe(201);
  });

  it('POST HR 缺欄位 → 400', async () => {
    overrides.caller = HR;
    const [req, res] = makeReqRes({
      method: 'POST', query: { _resource: 'periods' },
      body: { year: 2026 },   // 缺 month / period_start / period_end
    });
    await salaryHandler(req, res);
    expect(res.statusCode).toBe(400);
  });

  it('PUT 員工 → 403', async () => {
    overrides.caller = EMP;
    const [req, res] = makeReqRes({
      method: 'PUT', query: { _resource: 'periods', id: 'PP_2026_05' },
      body: { note: 'x' },
    });
    await salaryHandler(req, res);
    expect(res.statusCode).toBe(403);
  });

  it('DELETE 員工 → 403', async () => {
    overrides.caller = EMP;
    const [req, res] = makeReqRes({
      method: 'DELETE', query: { _resource: 'periods', id: 'PP_2026_05' },
    });
    await salaryHandler(req, res);
    expect(res.statusCode).toBe(403);
  });
});

// ════════════════════════════════════════════════════════════
// _resource=annual_summary GET — role gate
// ════════════════════════════════════════════════════════════
describe('/api/salary _resource=annual_summary GET — role gate', () => {
  it('員工 → 403', async () => {
    overrides.caller = EMP;
    const [req, res] = makeReqRes({ query: { _resource: 'annual_summary', year: '2026' } });
    await salaryHandler(req, res);
    expect(res.statusCode).toBe(403);
  });

  it('主管 → 403', async () => {
    overrides.caller = MGR;
    const [req, res] = makeReqRes({ query: { _resource: 'annual_summary', year: '2026' } });
    await salaryHandler(req, res);
    expect(res.statusCode).toBe(403);
  });

  it('HR + 有效 year → 200', async () => {
    overrides.caller = HR;
    const [req, res] = makeReqRes({ query: { _resource: 'annual_summary', year: '2026' } });
    await salaryHandler(req, res);
    expect(res.statusCode).toBe(200);
  });

  it('HR + 缺 year → 400', async () => {
    overrides.caller = HR;
    const [req, res] = makeReqRes({ query: { _resource: 'annual_summary' } });
    await salaryHandler(req, res);
    expect(res.statusCode).toBe(400);
  });

  it('HR + invalid year(超出 2000-2100)→ 400', async () => {
    overrides.caller = HR;
    const [req, res] = makeReqRes({ query: { _resource: 'annual_summary', year: '1999' } });
    await salaryHandler(req, res);
    expect(res.statusCode).toBe(400);
  });

  it('annual_summary POST method → 405', async () => {
    overrides.caller = HR;
    const [req, res] = makeReqRes({ method: 'POST', query: { _resource: 'annual_summary' } });
    await salaryHandler(req, res);
    expect(res.statusCode).toBe(405);
  });
});

// ════════════════════════════════════════════════════════════
// [id].js PUT — role gate(嚴格 BACKOFFICE、不 allowManager)
// ════════════════════════════════════════════════════════════
describe('/api/salary/[id] PUT — role gate', () => {
  it('PUT 員工 → 403', async () => {
    overrides.caller = EMP;
    const [req, res] = makeReqRes({ method: 'PUT', query: { id: 'S1' }, body: { note: 'x' } });
    await salaryByIdHandler(req, res);
    expect(res.statusCode).toBe(403);
  });

  it('PUT 主管 → 403(嚴格、不 allowManager)', async () => {
    overrides.caller = MGR;
    const [req, res] = makeReqRes({ method: 'PUT', query: { id: 'S1' }, body: { note: 'x' } });
    await salaryByIdHandler(req, res);
    expect(res.statusCode).toBe(403);
  });

  it('PUT HR + row 不存在 → 404(過 requireRole 後續邏輯)', async () => {
    overrides.caller = HR;
    overrides.salaryRecordRow = null;
    const [req, res] = makeReqRes({ method: 'PUT', query: { id: 'S1' }, body: { note: 'x' } });
    await salaryByIdHandler(req, res);
    expect(res.statusCode).toBe(404);
  });

  it('PUT action=confirm 員工 → 403', async () => {
    overrides.caller = EMP;
    const [req, res] = makeReqRes({ method: 'PUT', query: { id: 'S1', action: 'confirm' } });
    await salaryByIdHandler(req, res);
    expect(res.statusCode).toBe(403);
  });

  it('PUT action=confirm HR → 200(過 lock check)', async () => {
    overrides.caller = HR;
    const [req, res] = makeReqRes({ method: 'PUT', query: { id: 'S1', action: 'confirm' } });
    await salaryByIdHandler(req, res);
    expect(res.statusCode).toBe(200);
  });

  it('PUT action=pay 員工 → 403', async () => {
    overrides.caller = EMP;
    const [req, res] = makeReqRes({ method: 'PUT', query: { id: 'S1', action: 'pay' } });
    await salaryByIdHandler(req, res);
    expect(res.statusCode).toBe(403);
  });

  it('PUT action=pay HR → 200', async () => {
    overrides.caller = HR;
    const [req, res] = makeReqRes({ method: 'PUT', query: { id: 'S1', action: 'pay' } });
    await salaryByIdHandler(req, res);
    expect(res.statusCode).toBe(200);
  });

  it('GET method → 405(handler 只接 PUT)', async () => {
    const [req, res] = makeReqRes({ method: 'GET', query: { id: 'S1' } });
    await salaryByIdHandler(req, res);
    expect(res.statusCode).toBe(405);
  });

  it('DELETE method → 405(handler 只接 PUT)', async () => {
    const [req, res] = makeReqRes({ method: 'DELETE', query: { id: 'S1' } });
    await salaryByIdHandler(req, res);
    expect(res.statusCode).toBe(405);
  });

  it('PUT 缺 id → 400', async () => {
    overrides.caller = HR;
    const [req, res] = makeReqRes({ method: 'PUT', query: {}, body: {} });
    await salaryByIdHandler(req, res);
    expect(res.statusCode).toBe(400);
  });
});

// ════════════════════════════════════════════════════════════
// recalculate.js POST — role gate
// ════════════════════════════════════════════════════════════
describe('/api/salary/recalculate POST — role gate', () => {
  it('員工 → 403', async () => {
    overrides.caller = EMP;
    const [req, res] = makeReqRes({
      method: 'POST', body: { employee_id: 'E1', year: 2026, month: 5 },
    });
    await recalcHandler(req, res);
    expect(res.statusCode).toBe(403);
  });

  it('主管 → 403', async () => {
    overrides.caller = MGR;
    const [req, res] = makeReqRes({
      method: 'POST', body: { employee_id: 'E1', year: 2026, month: 5 },
    });
    await recalcHandler(req, res);
    expect(res.statusCode).toBe(403);
  });

  it('HR + 完整 body → 200', async () => {
    overrides.caller = HR;
    const [req, res] = makeReqRes({
      method: 'POST', body: { employee_id: 'E1', year: 2026, month: 5 },
    });
    await recalcHandler(req, res);
    expect(res.statusCode).toBe(200);
  });

  it('HR + 系統帳號 → 400(EMP_99999999 擋下)', async () => {
    overrides.caller = HR;
    const [req, res] = makeReqRes({
      method: 'POST', body: { employee_id: 'EMP_99999999', year: 2026, month: 5 },
    });
    await recalcHandler(req, res);
    expect(res.statusCode).toBe(400);
  });

  it('HR + 缺 employee_id → 400', async () => {
    overrides.caller = HR;
    const [req, res] = makeReqRes({
      method: 'POST', body: { year: 2026, month: 5 },
    });
    await recalcHandler(req, res);
    expect(res.statusCode).toBe(400);
  });

  it('GET method → 405', async () => {
    const [req, res] = makeReqRes({ method: 'GET' });
    await recalcHandler(req, res);
    expect(res.statusCode).toBe(405);
  });
});
