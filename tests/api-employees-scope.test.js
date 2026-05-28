// tests/api-employees-scope.test.js — B1 Commit C:/api/employees endpoint scope 整合測試
//
// 目標:把後端 auth + scope + 欄位白名單 行為鎖進測試。本檔不改任何 prod 行為、純記錄現況。
//
// 對齊 Commit A/B mock pattern(B7 已補 .is),加 calls.selects 攔 chain.select 參數
// 驗欄位白名單(employees 特有維度 — 員工/主管看到的是 PUBLIC_FIELDS 16 欄、HR 看 *)。
//
// 範圍涵蓋 index.js + [id].js 兩個 handler、含 _resource= 多個子路徑。

import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls = { tables: [], eqs: [], ins: [], selects: [], updates: [], inserts: [] };
const overrides = {
  caller: null,
  deptEmpIds: [],
  // index.js 員工列表 GET 預設 chain.then 對 employees 回 deptEmpIds objects
  // 主列表 select 的回值控制(若需要某 row 物件、再加 override)
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
    c.like = vi.fn(() => c);
    c.or = vi.fn(() => c); c.order = vi.fn(() => c); c.limit = vi.fn(() => c);
    c.insert = vi.fn((rows) => { calls.inserts.push({ table, rows }); return c; });
    c.update = vi.fn((patch) => { calls.updates.push({ table, patch }); return c; });
    c.upsert = vi.fn((rows) => { calls.inserts.push({ table, rows, upsert: true }); return c; });
    c.delete = vi.fn(() => c);
    c.single = vi.fn(() => Promise.resolve({ data: null, error: null }));
    c.maybeSingle = vi.fn(() => Promise.resolve({ data: null, error: null }));
    // employees table 預設回 deptEmpIds objects(讓主管 scope 拿到部門員工 list)
    c.then = (onF, onR) => {
      const data = (table === 'employees')
        ? overrides.deptEmpIds.map(id => ({ id }))
        : [];
      return Promise.resolve({ data, error: null }).then(onF, onR);
    };
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

vi.mock('../lib/dept-sync.js', () => ({
  syncDeptFields: vi.fn(async () => undefined),
}));

vi.mock('../lib/employee/change-logger.js', () => ({
  logEmployeeChanges: vi.fn(async () => undefined),
}));

const { default: handler } = await import('../api/employees/index.js');
const { default: handlerById } = await import('../api/employees/[id].js');

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
  overrides.deptEmpIds = [];
});

const HR       = { id: 'HR1',  role: 'hr',       is_manager: false, dept_id: 'D_HR' };
const ADMIN    = { id: 'A1',   role: 'admin',    is_manager: false, dept_id: 'D_X' };
const CEO      = { id: 'C1',   role: 'ceo',      is_manager: false, dept_id: 'D_EXEC' };
const CHAIRMAN = { id: 'CH1',  role: 'chairman', is_manager: false, dept_id: 'D_EXEC' };
const MGR      = { id: 'M1',   role: 'employee', is_manager: true,  dept_id: 'D1' };
const EMP      = { id: 'E1',   role: 'employee', is_manager: false, dept_id: 'D1' };

// 取主員工列表 select(過濾掉 resolveAuthScopeWithDeptIds 內部 .select('id'))
function findMainEmployeesSelect() {
  return calls.selects.find(s => s.table === 'employees' && s.cols && s.cols.includes('name'));
}

// ════════════════════════════════════════════════════════════
// auth gate — 未登入應 401(所有 path)
// ════════════════════════════════════════════════════════════
describe('/api/employees — auth gate(未登入 → 401)', () => {
  it('未登入 員工列表 GET → 401', async () => {
    const [req, res] = makeReqRes({ query: {} });
    await handler(req, res);
    expect(res.statusCode).toBe(401);
  });

  it('未登入 POST 新員工 → 401', async () => {
    const [req, res] = makeReqRes({ method: 'POST', body: { name: 'X' } });
    await handler(req, res);
    expect(res.statusCode).toBe(401);
  });

  it('未登入 ?_resource=orgchart GET → 401', async () => {
    const [req, res] = makeReqRes({ query: { _resource: 'orgchart' } });
    await handler(req, res);
    expect(res.statusCode).toBe(401);
  });

  it('未登入 ?_resource=push POST → 401', async () => {
    const [req, res] = makeReqRes({
      method: 'POST', query: { _resource: 'push' },
      body: { action: 'subscribe', employee_id: 'E1', subscription: '{}' },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(401);
  });

  it('未登入 ?_resource=departments GET → 401', async () => {
    const [req, res] = makeReqRes({ query: { _resource: 'departments' } });
    await handler(req, res);
    expect(res.statusCode).toBe(401);
  });

  it('未登入 ?_resource=departments POST → 401', async () => {
    const [req, res] = makeReqRes({
      method: 'POST', query: { _resource: 'departments' },
      body: { name: 'D_X' },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(401);
  });

  it('未登入 [id].js GET (id ≠ "me") → 401', async () => {
    const [req, res] = makeReqRes({ query: { id: 'E1' } });
    await handlerById(req, res);
    expect(res.statusCode).toBe(401);
  });

  it('未登入 [id].js PUT → 401', async () => {
    const [req, res] = makeReqRes({ method: 'PUT', query: { id: 'E1' }, body: {} });
    await handlerById(req, res);
    expect(res.statusCode).toBe(401);
  });

  it('未登入 [id].js DELETE → 401', async () => {
    const [req, res] = makeReqRes({ method: 'DELETE', query: { id: 'E1' } });
    await handlerById(req, res);
    expect(res.statusCode).toBe(401);
  });
});

// ════════════════════════════════════════════════════════════
// 員工列表 GET — scope 矩陣
// ════════════════════════════════════════════════════════════
describe('/api/employees 員工列表 GET — scope 矩陣', () => {
  it('員工 → .eq id=self(只看自己 1 筆)', async () => {
    overrides.caller = EMP;
    const [req, res] = makeReqRes({ query: {} });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    const eq = calls.eqs.find(e => e.table === 'employees' && e.col === 'id');
    expect(eq?.val).toBe('E1');
  });

  it('主管 → .in 範圍含本部門(self + deptEmpIds)', async () => {
    overrides.caller = MGR;
    overrides.deptEmpIds = ['E1', 'E2'];
    const [req, res] = makeReqRes({ query: {} });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    const inCall = calls.ins.find(i => i.table === 'employees' && i.col === 'id');
    expect(inCall?.vals).toContain('M1');
    expect(inCall?.vals).toContain('E1');
    expect(inCall?.vals).toContain('E2');
  });

  it('HR → 不加 id filter(看全公司)', async () => {
    overrides.caller = HR;
    const [req, res] = makeReqRes({ query: {} });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    const eq = calls.eqs.find(e => e.table === 'employees' && e.col === 'id');
    const inCall = calls.ins.find(i => i.table === 'employees' && i.col === 'id');
    expect(eq).toBeUndefined();
    expect(inCall).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════
// ⭐ 員工列表 GET — 欄位白名單(employees 特有維度、隱私關鍵)
// ════════════════════════════════════════════════════════════
describe('/api/employees 員工列表 GET — 欄位白名單(敏感欄位防洩)', () => {
  it('員工看 → PUBLIC_FIELDS(含 emp_no/name、不含 base_salary)', async () => {
    overrides.caller = EMP;
    const [req, res] = makeReqRes({ query: {} });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    const sel = findMainEmployeesSelect();
    expect(sel).toBeDefined();
    expect(sel.cols).toContain('emp_no');         // 16 欄白名單含 emp_no
    expect(sel.cols).toContain('name');
    expect(sel.cols).toContain('phone');          // phone 在 16 欄內(現況、不是 base_salary)
    expect(sel.cols).not.toMatch(/^\*/);          // 不是 '*' 開頭
    expect(sel.cols).not.toContain('base_salary');// 不含 base_salary 等敏感
    expect(sel.cols).not.toContain('hourly_rate');
    expect(sel.cols).not.toContain('id_number');
    expect(sel.cols).not.toContain('bank_account');
  });

  it('主管看 → PUBLIC_FIELDS(主管也不該看部門員工薪資、由 isBackofficeRole 判定)', async () => {
    overrides.caller = MGR;
    overrides.deptEmpIds = ['E1', 'E2'];
    const [req, res] = makeReqRes({ query: {} });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    const sel = findMainEmployeesSelect();
    expect(sel).toBeDefined();
    expect(sel.cols).toContain('emp_no');
    expect(sel.cols).not.toContain('base_salary');// 重要:主管不該看薪資
    expect(sel.cols).not.toContain('hourly_rate');
  });

  it('HR 看 → * 全欄位', async () => {
    overrides.caller = HR;
    const [req, res] = makeReqRes({ query: {} });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    const sel = findMainEmployeesSelect();
    expect(sel).toBeDefined();
    expect(sel.cols.startsWith('*')).toBe(true);  // '*, departments(name)' 開頭是 *
  });

  it('admin 看 → * 全欄位', async () => {
    overrides.caller = ADMIN;
    const [req, res] = makeReqRes({ query: {} });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    const sel = findMainEmployeesSelect();
    expect(sel.cols.startsWith('*')).toBe(true);
  });

  it('ceo 看 → * 全欄位', async () => {
    overrides.caller = CEO;
    const [req, res] = makeReqRes({ query: {} });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    const sel = findMainEmployeesSelect();
    expect(sel.cols.startsWith('*')).toBe(true);
  });

  it('chairman 看 → * 全欄位', async () => {
    overrides.caller = CHAIRMAN;
    const [req, res] = makeReqRes({ query: {} });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    const sel = findMainEmployeesSelect();
    expect(sel.cols.startsWith('*')).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════
// POST 新員工 — role gate(嚴格 BACKOFFICE、不 allowManager)
// ════════════════════════════════════════════════════════════
describe('/api/employees POST 新員工 — role gate', () => {
  it('員工 → 403', async () => {
    overrides.caller = EMP;
    const [req, res] = makeReqRes({ method: 'POST', body: { name: 'X' } });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
  });

  it('主管 → 403(POST 用嚴格 BACKOFFICE、不 allowManager)', async () => {
    overrides.caller = MGR;
    const [req, res] = makeReqRes({ method: 'POST', body: { name: 'X' } });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
  });

  it('HR → 201', async () => {
    overrides.caller = HR;
    const [req, res] = makeReqRes({ method: 'POST', body: { name: 'X' } });
    await handler(req, res);
    expect(res.statusCode).toBe(201);
  });
});

// ════════════════════════════════════════════════════════════
// ?_resource=orgchart — role gate
// ════════════════════════════════════════════════════════════
describe('/api/employees ?_resource=orgchart GET — role gate', () => {
  it('員工 → 403', async () => {
    overrides.caller = EMP;
    const [req, res] = makeReqRes({ query: { _resource: 'orgchart' } });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
  });

  it('主管 → 200(is_manager 通過)', async () => {
    overrides.caller = MGR;
    const [req, res] = makeReqRes({ query: { _resource: 'orgchart' } });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
  });

  it('HR → 200', async () => {
    overrides.caller = HR;
    const [req, res] = makeReqRes({ query: { _resource: 'orgchart' } });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
  });

  it('POST method → 405', async () => {
    overrides.caller = HR;
    const [req, res] = makeReqRes({ method: 'POST', query: { _resource: 'orgchart' } });
    await handler(req, res);
    expect(res.statusCode).toBe(405);
  });
});

// ════════════════════════════════════════════════════════════
// ?_resource=push POST — 本人 guard
// ════════════════════════════════════════════════════════════
describe('/api/employees ?_resource=push POST — 本人 guard', () => {
  it('本人訂閱 → 200', async () => {
    overrides.caller = EMP;
    const [req, res] = makeReqRes({
      method: 'POST', query: { _resource: 'push' },
      body: { action: 'subscribe', employee_id: 'E1', subscription: '{"endpoint":"x"}' },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
  });

  it('代訂閱(employee_id !== caller.id)→ 403', async () => {
    overrides.caller = EMP;
    const [req, res] = makeReqRes({
      method: 'POST', query: { _resource: 'push' },
      body: { action: 'subscribe', employee_id: 'E_OTHER', subscription: '{"endpoint":"x"}' },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
  });

  it('HR 也不能代訂閱別人 → 403(本人 guard 嚴格、不分 role)', async () => {
    overrides.caller = HR;
    const [req, res] = makeReqRes({
      method: 'POST', query: { _resource: 'push' },
      body: { action: 'subscribe', employee_id: 'E_OTHER', subscription: '{"endpoint":"x"}' },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
  });

  it('GET method → 405', async () => {
    overrides.caller = EMP;
    const [req, res] = makeReqRes({ method: 'GET', query: { _resource: 'push' } });
    await handler(req, res);
    expect(res.statusCode).toBe(405);
  });

  it('action 非 subscribe → 400', async () => {
    overrides.caller = EMP;
    const [req, res] = makeReqRes({
      method: 'POST', query: { _resource: 'push' },
      body: { action: 'unsubscribe', employee_id: 'E1' },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
  });
});

// ════════════════════════════════════════════════════════════
// ?_resource=departments — role gate
// ════════════════════════════════════════════════════════════
describe('/api/employees ?_resource=departments', () => {
  it('GET 員工 → 200(任何 authed 可看部門列表)', async () => {
    overrides.caller = EMP;
    const [req, res] = makeReqRes({ query: { _resource: 'departments' } });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
  });

  it('GET HR → 200', async () => {
    overrides.caller = HR;
    const [req, res] = makeReqRes({ query: { _resource: 'departments' } });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
  });

  it('POST 員工 → 403', async () => {
    overrides.caller = EMP;
    const [req, res] = makeReqRes({
      method: 'POST', query: { _resource: 'departments' },
      body: { name: 'D_X' },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
  });

  it('POST 主管 → 403(寫操作 BACKOFFICE only)', async () => {
    overrides.caller = MGR;
    const [req, res] = makeReqRes({
      method: 'POST', query: { _resource: 'departments' },
      body: { name: 'D_X' },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
  });

  it('POST HR → 201', async () => {
    overrides.caller = HR;
    const [req, res] = makeReqRes({
      method: 'POST', query: { _resource: 'departments' },
      body: { name: 'D_X' },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(201);
  });

  it('PUT 員工 → 403', async () => {
    overrides.caller = EMP;
    const [req, res] = makeReqRes({
      method: 'PUT', query: { _resource: 'departments', id: 'D1' },
      body: { name: 'X' },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
  });

  it('DELETE 員工 → 403', async () => {
    overrides.caller = EMP;
    const [req, res] = makeReqRes({
      method: 'DELETE', query: { _resource: 'departments', id: 'D1' },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
  });
});

// ════════════════════════════════════════════════════════════
// [id].js GET — scope + 欄位白名單
// ════════════════════════════════════════════════════════════
describe('/api/employees/[id] GET — scope + 欄位白名單', () => {
  it('員工查自己 → 200 + cols 含 *(看自己用全欄位)', async () => {
    overrides.caller = EMP;
    const [req, res] = makeReqRes({ query: { id: 'E1' } });
    await handlerById(req, res);
    expect(res.statusCode).toBe(200);
    const sel = calls.selects.find(s => s.table === 'employees' && s.cols && s.cols.includes('departments'));
    expect(sel?.cols.startsWith('*')).toBe(true);
  });

  it('員工查他人 → 403', async () => {
    overrides.caller = EMP;
    const [req, res] = makeReqRes({ query: { id: 'E_OTHER' } });
    await handlerById(req, res);
    expect(res.statusCode).toBe(403);
  });

  it('主管查同部門他人 → 200 + cols 是 PUBLIC_FIELDS(不含 base_salary)', async () => {
    overrides.caller = MGR;
    overrides.deptEmpIds = ['E1', 'E2'];
    const [req, res] = makeReqRes({ query: { id: 'E1' } });
    await handlerById(req, res);
    expect(res.statusCode).toBe(200);
    const sel = calls.selects.find(s => s.table === 'employees' && s.cols && s.cols.includes('emp_no'));
    expect(sel).toBeDefined();
    expect(sel.cols).not.toContain('base_salary');
    expect(sel.cols).not.toContain('hourly_rate');
  });

  it('主管查跨部門他人 → 403', async () => {
    overrides.caller = MGR;
    overrides.deptEmpIds = ['E1', 'E2'];
    const [req, res] = makeReqRes({ query: { id: 'E_OTHER_DEPT' } });
    await handlerById(req, res);
    expect(res.statusCode).toBe(403);
  });

  it('HR 查任何人 → 200 + cols 含 *(全欄位)', async () => {
    overrides.caller = HR;
    const [req, res] = makeReqRes({ query: { id: 'E_ANY' } });
    await handlerById(req, res);
    expect(res.statusCode).toBe(200);
    const sel = calls.selects.find(s => s.table === 'employees' && s.cols && s.cols.includes('departments'));
    expect(sel?.cols.startsWith('*')).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════
// [id].js PUT — role gate(BACKOFFICE + allowManager)
// ════════════════════════════════════════════════════════════
describe('/api/employees/[id] PUT — role gate', () => {
  it('員工 → 403', async () => {
    overrides.caller = EMP;
    const [req, res] = makeReqRes({ method: 'PUT', query: { id: 'E1' }, body: {} });
    await handlerById(req, res);
    expect(res.statusCode).toBe(403);
  });

  it('主管 → 200(allowManager=true 通過)', async () => {
    overrides.caller = MGR;
    const [req, res] = makeReqRes({ method: 'PUT', query: { id: 'E1' }, body: {} });
    await handlerById(req, res);
    expect(res.statusCode).toBe(200);
  });

  it('HR → 200', async () => {
    overrides.caller = HR;
    const [req, res] = makeReqRes({ method: 'PUT', query: { id: 'E1' }, body: {} });
    await handlerById(req, res);
    expect(res.statusCode).toBe(200);
  });
});

// ════════════════════════════════════════════════════════════
// [id].js DELETE — role gate(嚴格 BACKOFFICE、不 allowManager)
// ════════════════════════════════════════════════════════════
describe('/api/employees/[id] DELETE — role gate', () => {
  it('員工 → 403', async () => {
    overrides.caller = EMP;
    const [req, res] = makeReqRes({ method: 'DELETE', query: { id: 'E1' } });
    await handlerById(req, res);
    expect(res.statusCode).toBe(403);
  });

  it('主管 → 403(DELETE 嚴格 BACKOFFICE、不 allowManager)', async () => {
    overrides.caller = MGR;
    const [req, res] = makeReqRes({ method: 'DELETE', query: { id: 'E1' } });
    await handlerById(req, res);
    expect(res.statusCode).toBe(403);
  });

  it('HR → 200', async () => {
    overrides.caller = HR;
    const [req, res] = makeReqRes({ method: 'DELETE', query: { id: 'E1' } });
    await handlerById(req, res);
    expect(res.statusCode).toBe(200);
  });
});
