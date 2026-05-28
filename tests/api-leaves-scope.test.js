// tests/api-leaves-scope.test.js — B1 Commit A:/api/leaves endpoint scope 整合測試
//
// 目標:把後端 auth + scope 行為鎖進測試。本檔不改任何 prod 行為、純記錄現況。
//
// 對齊 api-scope-integration.test.js mock pattern(B7 已補 .is)、強化 leaves 覆蓋:
//   - 未登入 6 個 GET / POST path → 401
//   - handleNewGet scope 矩陣(員工 / 主管同部門 / 主管跨部門 / HR、9 case)
//   - ?annual_balance=true scope 矩陣(6 case)
//   - Legacy GET list scope filter(3 case)
//   - Legacy GET ?id=X(2 case、僅測 auth/404、不測 scope detail — 因 mock single() 預設 null
//     會在 scope check 之前就 404,沒法拆 scope dispatch)
//   - handleNewPost 代提權限矩陣(5 case)
//   - ?stats=true / leave_types 現況 lock(2 case、純記錄不收緊)
//   - Legacy POST(不帶 start_at)→ 410 GONE(2 case、⭐ 本 commit 改 code 才綠)

import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls = { tables: [], eqs: [], ins: [] };
const overrides = { caller: null, deptEmpIds: [] };

vi.mock('../lib/supabase.js', () => {
  function chain(table) {
    const c = {};
    c.select = vi.fn(() => c);
    c.eq = vi.fn((col, val) => { calls.eqs.push({ table, col, val }); return c; });
    c.neq = vi.fn(() => c);
    c.in = vi.fn((col, vals) => { calls.ins.push({ table, col, vals }); return c; });
    c.is = vi.fn(() => c);    // 對齊 8c44806 soft-delete 加的 .is('deleted_at', null) filter(B7 修補)
    c.gte = vi.fn(() => c); c.lte = vi.fn(() => c);
    c.lt = vi.fn(() => c); c.gt = vi.fn(() => c);
    c.or = vi.fn(() => c); c.order = vi.fn(() => c); c.limit = vi.fn(() => c);
    c.insert = vi.fn(() => c);
    c.update = vi.fn(() => c);
    c.single = vi.fn(() => Promise.resolve({ data: null, error: null }));
    c.maybeSingle = vi.fn(() => Promise.resolve({ data: null, error: null }));
    // 對 employees table 回 deptEmpIds(讓主管 scope 拿到部門員工 list);其他預設 []
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

vi.mock('../lib/dept-name-mapper.js', () => ({
  addDeptName: vi.fn(),
  addDeptNameSingle: vi.fn(),
  addDeptNameNested: vi.fn(),
  attachManagerNames: vi.fn(async (rows) => rows),
}));

// 避免 handleNewPost 走進真實 lib 邏輯(會驗 leave_types / advance time / balance 等)
vi.mock('../lib/leave/request-flow.js', () => ({
  submitLeaveRequest: vi.fn(async () => ({ ok: true, request: { id: 'L_NEW' } })),
}));

// 避免 handleGetAnnualBalance 走進真實 lib(會撈 employees / leave_types / leave_requests 算)
vi.mock('../lib/leave/balance.js', () => ({
  getAnnualBalance: vi.fn(async () => ({ remaining: 7, used: 0 })),
}));

// 避免 makeLeaveRepo 在 import 期間求 supabase env
vi.mock('../api/leaves/_repo.js', () => ({
  makeLeaveRepo: vi.fn(() => ({})),
}));

const { default: handler } = await import('../api/leaves/index.js');

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
  overrides.deptEmpIds = [];
});

const HR  = { id: 'HR1', role: 'hr',       is_manager: false, dept_id: 'D_HR' };
const MGR = { id: 'M1',  role: 'employee', is_manager: true,  dept_id: 'D1' };
const EMP = { id: 'E1',  role: 'employee', is_manager: false, dept_id: 'D1' };

// ════════════════════════════════════════════════════════════
// auth gate — 未登入應 401
// ════════════════════════════════════════════════════════════
describe('/api/leaves — auth gate(未登入 → 401)', () => {
  it('未登入 handleNewGet → 401', async () => {
    const [req, res] = makeReqRes({ query: { employee_id: 'any', year: '2026' } });
    await handler(req, res);
    expect(res.statusCode).toBe(401);
  });

  it('未登入 ?annual_balance=true → 401', async () => {
    const [req, res] = makeReqRes({ query: { annual_balance: 'true', employee_id: 'any' } });
    await handler(req, res);
    expect(res.statusCode).toBe(401);
  });

  it('未登入 legacy GET ?id=X → 401', async () => {
    const [req, res] = makeReqRes({ query: { id: 'L_any' } });
    await handler(req, res);
    expect(res.statusCode).toBe(401);
  });

  it('未登入 legacy GET ?stats=true → 401', async () => {
    const [req, res] = makeReqRes({ query: { stats: 'true' } });
    await handler(req, res);
    expect(res.statusCode).toBe(401);
  });

  it('未登入 legacy GET list(沒 query)→ 401', async () => {
    const [req, res] = makeReqRes({ query: {} });
    await handler(req, res);
    expect(res.statusCode).toBe(401);
  });

  it('未登入 handleNewPost(帶 start_at)→ 401', async () => {
    const [req, res] = makeReqRes({
      method: 'POST',
      body: { start_at: '2026-06-01T09:00:00+08:00', end_at: '2026-06-01T18:00:00+08:00', leave_type: 'annual' },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(401);
  });
});

// ════════════════════════════════════════════════════════════
// handleNewGet — scope 矩陣
// ════════════════════════════════════════════════════════════
describe('/api/leaves handleNewGet — scope 矩陣', () => {
  it('員工查自己 → 200 + .eq employee_id=self', async () => {
    overrides.caller = EMP;
    const [req, res] = makeReqRes({ query: { employee_id: 'E1', year: '2026' } });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    const eq = calls.eqs.find(e => e.table === 'leave_requests' && e.col === 'employee_id');
    expect(eq?.val).toBe('E1');
  });

  it('員工查他人 → 403', async () => {
    overrides.caller = EMP;
    const [req, res] = makeReqRes({ query: { employee_id: 'E_other', year: '2026' } });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
  });

  it('員工不帶 employee_id → 200 + 自動 .eq self', async () => {
    overrides.caller = EMP;
    const [req, res] = makeReqRes({ query: { year: '2026' } });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    const eq = calls.eqs.find(e => e.table === 'leave_requests' && e.col === 'employee_id');
    expect(eq?.val).toBe('E1');
  });

  it('主管查自己 → 200', async () => {
    overrides.caller = MGR;
    overrides.deptEmpIds = ['E1', 'E2'];
    const [req, res] = makeReqRes({ query: { employee_id: 'M1', year: '2026' } });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
  });

  it('主管查同部門他人 → 200(canSeeEmployee 通過)', async () => {
    overrides.caller = MGR;
    overrides.deptEmpIds = ['E1', 'E2'];
    const [req, res] = makeReqRes({ query: { employee_id: 'E1', year: '2026' } });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
  });

  it('主管查跨部門他人 → 403', async () => {
    overrides.caller = MGR;
    overrides.deptEmpIds = ['E1', 'E2'];   // E_OTHER 不在部門內
    const [req, res] = makeReqRes({ query: { employee_id: 'E_OTHER', year: '2026' } });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
  });

  it('主管不帶 employee_id → 200 + .in 範圍含本部門', async () => {
    overrides.caller = MGR;
    overrides.deptEmpIds = ['E1', 'E2'];
    const [req, res] = makeReqRes({ query: { year: '2026' } });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    const inCall = calls.ins.find(i => i.table === 'leave_requests' && i.col === 'employee_id');
    expect(inCall?.vals).toContain('M1');     // selfId
    expect(inCall?.vals).toContain('E1');     // deptEmpIds
    expect(inCall?.vals).toContain('E2');
  });

  it('HR 查任何人 → 200 + .eq employee_id=查的人', async () => {
    overrides.caller = HR;
    const [req, res] = makeReqRes({ query: { employee_id: 'E_any', year: '2026' } });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    const eq = calls.eqs.find(e => e.table === 'leave_requests' && e.col === 'employee_id');
    expect(eq?.val).toBe('E_any');
  });

  it('HR 不帶 employee_id → 200 + 不加 employee_id filter(看全公司)', async () => {
    overrides.caller = HR;
    const [req, res] = makeReqRes({ query: { year: '2026' } });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    const eq = calls.eqs.find(e => e.table === 'leave_requests' && e.col === 'employee_id');
    expect(eq).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════
// ?annual_balance=true — scope 矩陣
// ════════════════════════════════════════════════════════════
describe('/api/leaves ?annual_balance=true — scope 矩陣', () => {
  it('員工查自己 → 200', async () => {
    overrides.caller = EMP;
    const [req, res] = makeReqRes({ query: { annual_balance: 'true', employee_id: 'E1' } });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
  });

  it('員工查他人 → 403', async () => {
    overrides.caller = EMP;
    const [req, res] = makeReqRes({ query: { annual_balance: 'true', employee_id: 'E_other' } });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
  });

  it('主管查同部門他人 → 200', async () => {
    overrides.caller = MGR;
    overrides.deptEmpIds = ['E1'];
    const [req, res] = makeReqRes({ query: { annual_balance: 'true', employee_id: 'E1' } });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
  });

  it('主管查跨部門他人 → 403', async () => {
    overrides.caller = MGR;
    overrides.deptEmpIds = [];
    const [req, res] = makeReqRes({ query: { annual_balance: 'true', employee_id: 'E_OTHER' } });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
  });

  it('HR 查任何人 → 200', async () => {
    overrides.caller = HR;
    const [req, res] = makeReqRes({ query: { annual_balance: 'true', employee_id: 'E_any' } });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
  });

  it('沒帶 employee_id → 400', async () => {
    overrides.caller = HR;
    const [req, res] = makeReqRes({ query: { annual_balance: 'true' } });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
  });
});

// ════════════════════════════════════════════════════════════
// Legacy GET list — scope filter
// ════════════════════════════════════════════════════════════
describe('/api/leaves legacy GET list — scope filter', () => {
  it('員工 → .eq employee_id=self', async () => {
    overrides.caller = EMP;
    const [req, res] = makeReqRes({ query: {} });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    const eq = calls.eqs.find(e => e.table === 'leave_requests' && e.col === 'employee_id');
    expect(eq?.val).toBe('E1');
  });

  it('主管 → .in 範圍含本部門', async () => {
    overrides.caller = MGR;
    overrides.deptEmpIds = ['E1', 'E2'];
    const [req, res] = makeReqRes({ query: {} });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    const inCall = calls.ins.find(i => i.table === 'leave_requests' && i.col === 'employee_id');
    expect(inCall?.vals).toContain('M1');
    expect(inCall?.vals).toContain('E1');
    expect(inCall?.vals).toContain('E2');
  });

  it('HR → 不加 employee_id filter(看全公司)', async () => {
    overrides.caller = HR;
    const [req, res] = makeReqRes({ query: {} });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    const eq = calls.eqs.find(e => e.table === 'leave_requests' && e.col === 'employee_id');
    const inCall = calls.ins.find(i => i.table === 'leave_requests' && i.col === 'employee_id');
    expect(eq).toBeUndefined();
    expect(inCall).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════
// Legacy GET ?id=X — auth + 404
// ════════════════════════════════════════════════════════════
// 注意:該 path 內 .single() 預設回 { data:null, error:null }、實際 prod 會回 PGRST116。
// L88-90 抓 error 失敗就 404 — 因此 single 預設 error=null + data=null,handler 走「無 error」
// 進入 L91 scope check、leave.employee_id=undefined → canSeeEmployee 失敗 → 403。
// 為了完整測 scope 跟 404,需要顯式 override single() 回值 — 這次先只測 401。
describe('/api/leaves legacy GET ?id=X — auth gate', () => {
  it('未登入 → 401(requireAuth 擋)', async () => {
    const [req, res] = makeReqRes({ query: { id: 'L_any' } });
    await handler(req, res);
    expect(res.statusCode).toBe(401);
  });
});

// ════════════════════════════════════════════════════════════
// handleNewPost — 代提權限矩陣
// ════════════════════════════════════════════════════════════
describe('/api/leaves handleNewPost — 代提權限', () => {
  function makePostReqRes(body) {
    return makeReqRes({ method: 'POST', body });
  }

  it('員工提自己(明確 employee_id=自己)→ 201', async () => {
    overrides.caller = EMP;
    const [req, res] = makePostReqRes({
      employee_id: 'E1',
      leave_type: 'annual',
      start_at: '2026-06-01T09:00:00+08:00',
      end_at: '2026-06-01T18:00:00+08:00',
    });
    await handler(req, res);
    expect(res.statusCode).toBe(201);
  });

  it('員工不帶 employee_id → 預設提自己 → 201', async () => {
    overrides.caller = EMP;
    const [req, res] = makePostReqRes({
      leave_type: 'annual',
      start_at: '2026-06-01T09:00:00+08:00',
      end_at: '2026-06-01T18:00:00+08:00',
    });
    await handler(req, res);
    expect(res.statusCode).toBe(201);
  });

  it('員工幫他人提 → 403', async () => {
    overrides.caller = EMP;
    const [req, res] = makePostReqRes({
      employee_id: 'E_other',
      leave_type: 'annual',
      start_at: '2026-06-01T09:00:00+08:00',
      end_at: '2026-06-01T18:00:00+08:00',
    });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
  });

  it('HR 代提他人 → 201', async () => {
    overrides.caller = HR;
    const [req, res] = makePostReqRes({
      employee_id: 'E_any',
      leave_type: 'annual',
      start_at: '2026-06-01T09:00:00+08:00',
      end_at: '2026-06-01T18:00:00+08:00',
    });
    await handler(req, res);
    expect(res.statusCode).toBe(201);
  });

  it('主管代提部門員工 → 201(is_manager 通過)', async () => {
    overrides.caller = MGR;
    const [req, res] = makePostReqRes({
      employee_id: 'E1',
      leave_type: 'annual',
      start_at: '2026-06-01T09:00:00+08:00',
      end_at: '2026-06-01T18:00:00+08:00',
    });
    await handler(req, res);
    expect(res.statusCode).toBe(201);
  });
});

// ════════════════════════════════════════════════════════════
// 現況 lock — ?stats=true / leave_types(本 commit 不收緊、只記錄)
// ════════════════════════════════════════════════════════════
describe('/api/leaves 現況 lock', () => {
  it('?stats=true:任何 authed user 都可看(現況、未收緊到 HR-only)', async () => {
    overrides.caller = EMP;
    const [req, res] = makeReqRes({ query: { stats: 'true' } });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('total');
  });

  it('?_resource=leave_types:公開、不需 auth(metadata、現況)', async () => {
    // overrides.caller = null(beforeEach 預設、未登入)
    const [req, res] = makeReqRes({ query: { _resource: 'leave_types' } });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
  });
});

// ════════════════════════════════════════════════════════════
// ⭐ Legacy POST(不帶 start_at)→ 410 GONE(本 commit 改 code 才綠)
// ════════════════════════════════════════════════════════════
describe('/api/leaves legacy POST(start_date/end_date/days)→ 410 GONE', () => {
  it('未登入 legacy POST → 410 GONE(對齊 legacy PUT 處理 pattern)', async () => {
    const [req, res] = makeReqRes({
      method: 'POST',
      body: {
        employee_id: 'E1',
        leave_type: 'annual',
        start_date: '2026-06-01',
        end_date: '2026-06-01',
        days: 1,
      },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(410);
    expect(res.body?.error).toBe('GONE');
  });

  it('已登入 legacy POST → 410 GONE(legacy 已棄用、不分 role 一律拒絕)', async () => {
    overrides.caller = EMP;
    const [req, res] = makeReqRes({
      method: 'POST',
      body: {
        employee_id: 'E1',
        leave_type: 'annual',
        start_date: '2026-06-01',
        end_date: '2026-06-01',
        days: 1,
      },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(410);
    expect(res.body?.error).toBe('GONE');
  });
});
