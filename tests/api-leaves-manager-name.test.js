// tests/api-leaves-manager-name.test.js — Phase 2.x:列表 row attach employee_manager_name
//
// 重點:
//   1. /api/leaves 列表 row 含 employee_manager_name(同部門 is_manager=true active 員工 name 串)
//   2. 同部門多 manager → string-join ', '
//   3. 同部門 0 manager → null(frontend 顯示 '—')
//   4. employee_dept_id alias 一定 flatten(對齊 canReview reviewable shape)
//
// 策略:mock supabase chain、攔 .from('leave_requests')/'employees' 兩次撈、回控制 data。

import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls = { tables: [], selects: [], eqs: [], ins: [] };
// 控制每次 SELECT 回的 data:第 N 次 from('table_X') 拿 dataByTable[`table_X:${callIndex}`]
// 簡化:每個 table 有「list 用」的 array(then chain)+ single 用(.single())
const tableState = {
  leave_requests: [],          // GET list 回的 leaves
  leave_request_single: null,  // GET ?id=X 回的 leave
  employees_by_id: [],         // employees JOIN(by leave.employee_id 撈 emp)
  employee_single: null,       // GET ?id=X 撈員工
  managers: [],                // attachManagerNames 撈的 managers
};
const overrides = { caller: null };

vi.mock('../../lib/supabase.js', () => ({}), { virtual: true });
// 真正用的 import 路徑
vi.mock('../lib/supabase.js', () => {
  // 計次第幾次撈 employees(第 1 次是 by id 列表、第 2 次是 attachManagerNames 撈 managers)
  function chain(table) {
    const c = {};
    let isManagerLookup = false;
    c.select = vi.fn((str) => { calls.selects.push({ table, str }); return c; });
    c.eq = vi.fn((col, val) => {
      calls.eqs.push({ table, col, val });
      // 攔到 .eq('is_manager', true) → 標記為 manager lookup,後續 then 回 managers
      if (table === 'employees' && col === 'is_manager' && val === true) isManagerLookup = true;
      return c;
    });
    c.in = vi.fn((col, vals) => { calls.ins.push({ table, col, vals }); return c; });
    c.gte = vi.fn(() => c); c.lte = vi.fn(() => c); c.lt = vi.fn(() => c);
    c.order = vi.fn(() => c); c.limit = vi.fn(() => c);
    c.single = vi.fn(() => {
      if (table === 'leave_requests') {
        return Promise.resolve({ data: tableState.leave_request_single, error: tableState.leave_request_single ? null : { code: 'PGRST116' } });
      }
      if (table === 'employees') {
        return Promise.resolve({ data: tableState.employee_single, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    });
    c.maybeSingle = vi.fn(() => Promise.resolve({ data: null, error: null }));
    c.then = (onF, onR) => {
      let data;
      if (table === 'leave_requests') data = tableState.leave_requests;
      else if (table === 'employees') data = isManagerLookup ? tableState.managers : tableState.employees_by_id;
      else data = [];
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
  requireRole: vi.fn(async (req, res) => {
    if (!overrides.caller) { res.status(401).json({ error: 'Unauthorized' }); return null; }
    return overrides.caller;
  }),
}));

// 只 mock 名字 mapper、attachManagerNames 走真實實作(已抽 lib)
vi.mock('../lib/dept-name-mapper.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    addDeptName: vi.fn(),
    addDeptNameSingle: vi.fn(),
    addDeptNameNested: vi.fn(),
  };
});

vi.mock('../lib/auth-scope.js', () => ({
  resolveAuthScopeWithDeptIds: vi.fn(async () => ({ mode: 'all', selfId: 'HR1', deptEmpIds: [] })),
  makeDeptEmpIdsRepo: vi.fn(() => ({})),
  canSeeEmployee: vi.fn(() => true),
}));

const { default: handler } = await import('../api/leaves/index.js');

function makeReqRes({ method = 'GET', query = {}, body = null } = {}) {
  const res = {
    statusCode: 200, body: undefined,
    status(c) { this.statusCode = c; return this; },
    json(p)   { this.body = p; return this; },
    end()     { return this; },
  };
  return [{ method, query, body, headers: {} }, res];
}

beforeEach(() => {
  calls.tables = []; calls.selects = []; calls.eqs = []; calls.ins = [];
  tableState.leave_requests = [];
  tableState.leave_request_single = null;
  tableState.employees_by_id = [];
  tableState.employee_single = null;
  tableState.managers = [];
  overrides.caller = { id: 'HR1', role: 'hr', is_manager: false, dept_id: 'D_HR' };
});

describe('/api/leaves GET list — attach employee_manager_name', () => {
  it('同部門多 manager → string-join \', \'', async () => {
    tableState.leave_requests = [
      { id: 'L1', employee_id: 'E1', leave_type: 'sick', status: 'pending_mgr' },
    ];
    tableState.employees_by_id = [
      { id: 'E1', name: '洪千雅', dept_id: 'D1', position: '工程師', avatar: null, departments: { name: '工程部' } },
    ];
    tableState.managers = [
      { id: 'M1', name: '盧嘉凌', dept_id: 'D1' },
      { id: 'M2', name: '劉嘉昕', dept_id: 'D1' },
    ];
    const [req, res] = makeReqRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body[0].employee_manager_name).toBe('盧嘉凌, 劉嘉昕');
    expect(res.body[0].employee_dept_id).toBe('D1');
  });

  it('同部門 0 manager → null', async () => {
    tableState.leave_requests = [
      { id: 'L_C', employee_id: 'E_C', leave_type: 'sick', status: 'pending_mgr' },
    ];
    tableState.employees_by_id = [
      { id: 'E_C', name: 'Chairman 員工', dept_id: 'DEPT001', position: 'something', avatar: null, departments: { name: '董事長室' } },
    ];
    tableState.managers = [];   // 該部門無 active is_manager
    const [req, res] = makeReqRes();
    await handler(req, res);
    expect(res.body[0].employee_manager_name).toBeNull();
    expect(res.body[0].employee_dept_id).toBe('DEPT001');
  });

  it('employee_dept_id 一定 flatten(對齊 canReview reviewable shape)', async () => {
    tableState.leave_requests = [
      { id: 'L2', employee_id: 'E2', leave_type: 'sick', status: 'pending_mgr' },
    ];
    tableState.employees_by_id = [
      { id: 'E2', name: 'Bob', dept_id: 'D2', position: '', avatar: null, departments: { name: '行銷部' } },
    ];
    tableState.managers = [{ id: 'M3', name: 'Alice', dept_id: 'D2' }];
    const [req, res] = makeReqRes();
    await handler(req, res);
    expect(res.body[0].employee_dept_id).toBe('D2');
    expect(res.body[0].employee_manager_name).toBe('Alice');
  });

  it('attachManagerNames 撈 employees 用 .in(dept_id) + .eq(is_manager,true) + .eq(status,active)', async () => {
    tableState.leave_requests = [
      { id: 'L1', employee_id: 'E1', status: 'pending_mgr' },
      { id: 'L2', employee_id: 'E2', status: 'pending_mgr' },
    ];
    tableState.employees_by_id = [
      { id: 'E1', name: 'A', dept_id: 'D1', departments: { name: 'Dept1' } },
      { id: 'E2', name: 'B', dept_id: 'D2', departments: { name: 'Dept2' } },
    ];
    tableState.managers = [];
    const [req, res] = makeReqRes();
    await handler(req, res);

    // 第二次撈 employees(attachManagerNames):.in('dept_id', ['D1','D2'])
    const deptIn = calls.ins.find(c => c.table === 'employees' && c.col === 'dept_id');
    expect(deptIn).toBeDefined();
    expect(new Set(deptIn.vals)).toEqual(new Set(['D1', 'D2']));

    // .eq('is_manager', true) 守
    const isMgrEq = calls.eqs.find(c => c.table === 'employees' && c.col === 'is_manager' && c.val === true);
    expect(isMgrEq).toBeDefined();

    // .eq('status', 'active') 守
    const statusEq = calls.eqs.find(c => c.table === 'employees' && c.col === 'status' && c.val === 'active');
    expect(statusEq).toBeDefined();
  });

  it('空列表 → 不撈 managers、回空 array(無 N+1)', async () => {
    tableState.leave_requests = [];
    const [req, res] = makeReqRes();
    await handler(req, res);
    expect(res.body).toEqual([]);
    // 不該撈 employees(空 list 直接 return)
    expect(calls.tables.filter(t => t === 'employees').length).toBe(0);
  });
});

describe('/api/leaves GET ?id=X single — attach employee_manager_name', () => {
  it('single row 也補 employee_manager_name + employee_dept_id', async () => {
    tableState.leave_request_single = {
      id: 'L1', employee_id: 'E1', leave_type: 'sick', status: 'pending_mgr',
    };
    tableState.employee_single = {
      name: '洪千雅', dept_id: 'D1', position: '工程師', avatar: null, departments: { name: '工程部' },
    };
    tableState.managers = [
      { id: 'M1', name: '盧嘉凌', dept_id: 'D1' },
    ];
    const [req, res] = makeReqRes({ query: { id: 'L1' } });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.employee_manager_name).toBe('盧嘉凌');
    expect(res.body.employee_dept_id).toBe('D1');
  });
});
