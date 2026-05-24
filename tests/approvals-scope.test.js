// tests/approvals-scope.test.js — B13:approvals GET 5 個 path 的 dept-scope + 守門
//
// 對齊 leaves / employees / pending-approvals Phase 2 收緊邏輯。
//   - ?id=X         本人 OR scope 看得到 → OK,否則 403
//   - ?type=list    applicant_id 本人 OR scope 看得到 → OK,否則 403
//   - ?type=pending role='manager' 時 JS-side dept filter,其他 role 不 filter
//   - fallthrough   HR-only

import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls = { tables: [] };
const dataByQuery = {};
const overrides = { caller: null, scope: null };

vi.mock('../lib/supabase.js', () => {
  function chain(table) {
    const c = {};
    c.select = vi.fn(() => c);
    c.eq = vi.fn(() => c);
    c.neq = vi.fn(() => c);
    c.in = vi.fn(() => c);
    c.gte = vi.fn(() => c); c.lte = vi.fn(() => c);
    c.order = vi.fn(() => c); c.limit = vi.fn(() => c);
    c.update = vi.fn(() => c);
    c.insert = vi.fn(() => c);
    c.single = vi.fn(() => Promise.resolve({
      data: dataByQuery[`${table}:single`] ?? null,
      error: dataByQuery[`${table}:single`] ? null : { code: 'PGRST116' },
    }));
    c.maybeSingle = vi.fn(() => Promise.resolve({
      data: dataByQuery[`${table}:maybeSingle`] ?? null, error: null,
    }));
    c.then = (onF, onR) => Promise.resolve({
      data: dataByQuery[`${table}:then`] ?? [], error: null,
    }).then(onF, onR);
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
}));

// B13 重點 mock:resolveAuthScopeWithDeptIds 直接回 overrides.scope。
// canSeeEmployee 用 actual impl(純函式、跟 prod 一致)。
vi.mock('../lib/auth-scope.js', async (importActual) => {
  const actual = await importActual();
  return {
    ...actual,
    resolveAuthScopeWithDeptIds: vi.fn(async () => overrides.scope || { mode: 'all' }),
    makeDeptEmpIdsRepo: vi.fn(() => ({})),
  };
});

// roles.js 不 mock(isBackofficeRole 是純 array.includes、用 actual 更接近 prod)

vi.mock('../lib/push.js', () => ({
  sendPushToEmployees: vi.fn(async () => ({ sent: 0 })),
  sendPushToRoles:     vi.fn(async () => ({ sent: 0 })),
  createNotifications: vi.fn(async () => undefined),
  createNotificationsForRoles: vi.fn(async () => undefined),
}));

vi.mock('../lib/dept-name-mapper.js', () => ({
  addDeptName: vi.fn(),
  addDeptNameSingle: vi.fn(),
  addDeptNameNested: vi.fn(),
}));

const { default: handler } = await import('../api/approvals.js');

function makeReqRes({ method = 'GET', query = {}, body = {} } = {}) {
  const res = {
    statusCode: 200, body: undefined,
    status(c) { this.statusCode = c; return this; },
    json(p)   { this.body = p; return this; },
    end()     { return this; },
  };
  return [{ method, query, body, headers: {} }, res];
}

beforeEach(() => {
  calls.tables = [];
  for (const k of Object.keys(dataByQuery)) delete dataByQuery[k];
  overrides.caller = null;
  overrides.scope  = null;
});

// ─── caller fixtures ────────────────────────────────────────────
const E1   = { id: 'E1', role: 'employee', is_manager: false, dept_id: 'D1' };
const MGR  = { id: 'M1', role: 'employee', is_manager: true,  dept_id: 'D1' };
const HR   = { id: 'HR1', role: 'hr', is_manager: false, dept_id: 'D_HR' };

// ─── scope fixtures(模擬 resolveAuthScopeWithDeptIds 算出來的)──
const SCOPE_ALL  = { mode: 'all' };                                          // HR / CEO / chairman / admin
const SCOPE_SELF = (id) => ({ mode: 'self', selfId: id });                   // 純員工 / 主管無 dept_id
const SCOPE_DEPT = (id, deptEmpIds) => ({                                    // 純主管 + 有 dept_id
  mode: 'dept', selfId: id, deptId: 'D1', deptEmpIds,
});

// ════════════════════════════════════════════════════════════
// B13.1 — ?type=pending&role=X (dept filter)
// ════════════════════════════════════════════════════════════
describe('B13:?type=pending&role=manager — JS-side dept filter', () => {
  // 模擬全公司有 3 筆 manager-step pending:E1(D1)、E2(D1)、E3(D2)
  function setupPendingSteps() {
    dataByQuery['approval_steps:then'] = [
      { request_id: 'APR1', step_number: 1, approver_role: 'manager', status: 'in_progress',
        approval_requests: { id: 'APR1', applicant_id: 'E1', employees: { dept_id: 'D1' } } },
      { request_id: 'APR2', step_number: 1, approver_role: 'manager', status: 'in_progress',
        approval_requests: { id: 'APR2', applicant_id: 'E2', employees: { dept_id: 'D1' } } },
      { request_id: 'APR3', step_number: 1, approver_role: 'manager', status: 'in_progress',
        approval_requests: { id: 'APR3', applicant_id: 'E3', employees: { dept_id: 'D2' } } },
    ];
  }

  it('manager(D1)看 ?type=pending&role=manager → 只看到 E1+E2(D1)、不看 E3(D2)', async () => {
    overrides.caller = MGR;
    overrides.scope = SCOPE_DEPT('M1', ['E1', 'E2']); // dept D1 active emp = E1+E2
    setupPendingSteps();
    const [req, res] = makeReqRes({ query: { type: 'pending', role: 'manager' } });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveLength(2);
    const ids = res.body.map(s => s.request_id).sort();
    expect(ids).toEqual(['APR1', 'APR2']);
  });

  it('HR 看 ?type=pending&role=manager → 看全公司 3 筆(不被 dept filter)', async () => {
    overrides.caller = HR;
    overrides.scope = SCOPE_ALL;
    setupPendingSteps();
    const [req, res] = makeReqRes({ query: { type: 'pending', role: 'manager' } });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveLength(3);
  });

  it('is_manager 但無 dept_id(資料異常)→ steps = []', async () => {
    overrides.caller = { id: 'M_NODEPT', role: 'employee', is_manager: true, dept_id: null };
    overrides.scope = SCOPE_SELF('M_NODEPT');
    setupPendingSteps();
    const [req, res] = makeReqRes({ query: { type: 'pending', role: 'manager' } });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════
// B13.2 — ?id=X 守門
// ════════════════════════════════════════════════════════════
describe('B13:?id=X — 申請人本人 / scope 內 / 403', () => {
  function setupRequest(applicantId) {
    dataByQuery['approval_requests:single'] = {
      id: 'APR1', applicant_id: applicantId,
      title: 'X', request_type: 'punch_correction',
      employees: { name: 'Test', dept_id: applicantId === 'E1' ? 'D1' : 'D2' },
    };
    dataByQuery['approval_steps:then'] = [];
  }

  it('員工打 ?id= 自己的申請 → OK', async () => {
    overrides.caller = E1;
    overrides.scope = SCOPE_SELF('E1');
    setupRequest('E1');
    const [req, res] = makeReqRes({ query: { id: 'APR1' } });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
  });

  it('員工打 ?id= 別人的申請 → 403', async () => {
    overrides.caller = E1;
    overrides.scope = SCOPE_SELF('E1');
    setupRequest('E_OTHER');
    const [req, res] = makeReqRes({ query: { id: 'APR1' } });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
    expect(res.body?.error).toMatch(/無權看此申請/);
  });

  it('manager(D1)打 ?id= 別部門(D2)申請 → 403', async () => {
    overrides.caller = MGR;
    overrides.scope = SCOPE_DEPT('M1', ['E1', 'E2']); // 本部門 E1, E2、不含 E3
    setupRequest('E3'); // E3 是 D2
    const [req, res] = makeReqRes({ query: { id: 'APR1' } });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
  });

  it('manager(D1)打 ?id= 同部門(D1)員工申請 → OK', async () => {
    overrides.caller = MGR;
    overrides.scope = SCOPE_DEPT('M1', ['E1', 'E2']);
    setupRequest('E1');
    const [req, res] = makeReqRes({ query: { id: 'APR1' } });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
  });

  it('HR 打 ?id= 任何人申請 → OK', async () => {
    overrides.caller = HR;
    overrides.scope = SCOPE_ALL;
    setupRequest('E_RANDOM');
    const [req, res] = makeReqRes({ query: { id: 'APR1' } });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
  });
});

// ════════════════════════════════════════════════════════════
// B13.3 — ?type=list&applicant_id=X 守門
// ════════════════════════════════════════════════════════════
describe('B13:?type=list&applicant_id=X — 本人 / scope 內 / 403', () => {
  it('員工本人「我的申請」→ OK', async () => {
    overrides.caller = E1;
    overrides.scope = SCOPE_SELF('E1');
    dataByQuery['approval_requests:then'] = [];
    const [req, res] = makeReqRes({ query: { type: 'list', applicant_id: 'E1' } });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
  });

  it('員工亂猜別人 applicant_id → 403', async () => {
    overrides.caller = E1;
    overrides.scope = SCOPE_SELF('E1');
    const [req, res] = makeReqRes({ query: { type: 'list', applicant_id: 'E_OTHER' } });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
    expect(res.body?.error).toMatch(/無權看此員工/);
  });

  it('manager 跨 dept 打 ?type=list&applicant_id=別部門員工 → 403', async () => {
    overrides.caller = MGR;
    overrides.scope = SCOPE_DEPT('M1', ['E1', 'E2']);
    const [req, res] = makeReqRes({ query: { type: 'list', applicant_id: 'E3' } });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
  });

  it('manager 打 ?type=list&applicant_id=同部門員工 → OK', async () => {
    overrides.caller = MGR;
    overrides.scope = SCOPE_DEPT('M1', ['E1', 'E2']);
    dataByQuery['approval_requests:then'] = [];
    const [req, res] = makeReqRes({ query: { type: 'list', applicant_id: 'E1' } });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
  });

  it('HR 打 ?type=list&applicant_id=任何 → OK', async () => {
    overrides.caller = HR;
    overrides.scope = SCOPE_ALL;
    dataByQuery['approval_requests:then'] = [];
    const [req, res] = makeReqRes({ query: { type: 'list', applicant_id: 'E_RANDOM' } });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
  });
});

// ════════════════════════════════════════════════════════════
// B13.4 — fallthrough(全部申請)HR-only
// ════════════════════════════════════════════════════════════
describe('B13:GET fallthrough — HR-only', () => {
  it('員工打 fallthrough(無 query)→ 403', async () => {
    overrides.caller = E1;
    overrides.scope = SCOPE_SELF('E1');
    const [req, res] = makeReqRes({ query: {} });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
    expect(res.body?.error).toMatch(/無權看全部申請/);
  });

  it('manager 打 fallthrough → 403(不對齊 backoffice、即便 dept-scope 也擋)', async () => {
    overrides.caller = MGR;
    overrides.scope = SCOPE_DEPT('M1', ['E1', 'E2']);
    const [req, res] = makeReqRes({ query: {} });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
  });

  it('HR 打 fallthrough → 200(看全公司)', async () => {
    overrides.caller = HR;
    overrides.scope = SCOPE_ALL;
    dataByQuery['approval_requests:then'] = [
      { id: 'APR1', applicant_id: 'E1' },
      { id: 'APR2', applicant_id: 'E2' },
    ];
    const [req, res] = makeReqRes({ query: {} });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveLength(2);
  });
});
