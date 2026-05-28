// tests/api-schedules-scope.test.js — B1 Commit B:/api/schedules endpoint scope 整合測試
//
// 目標:把後端 auth + scope 行為鎖進測試。本檔不改任何 prod 行為、純記錄現況。
//
// 對齊 api-leaves-scope.test.js mock pattern(B7 已補 .is)、強化 schedules 覆蓋:
//   - 未登入 3 個 path → 401
//   - 新 GET(period_id / year)scope 矩陣(8 case)
//   - Legacy GET(dept/start/end/month)scope 矩陣(7 case)
//   - ?_resource=shift_types GET 公開 + POST role gate(6 case)
//   - ?_resource=shift_types_item PATCH/DELETE role gate(4 case)
//   - 新 POST(period_id in body)員工/主管建他人 / 自己 schedule(3 case)

import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls = { tables: [], eqs: [], ins: [] };
const overrides = {
  caller: null,
  deptEmpIds: [],
  scheduleperiodRow: null,
  employeeDeptId: null,
  managerPermResult: { ok: false, reason: 'NOT_MANAGER' },
  employeePermResult: { ok: false, reason: 'NOT_ALLOWED' },
};

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
    c.not = vi.fn(() => c);
    c.or = vi.fn(() => c); c.order = vi.fn(() => c); c.limit = vi.fn(() => c);
    c.insert = vi.fn(() => c);
    c.update = vi.fn(() => c);
    c.upsert = vi.fn(() => c);
    c.single = vi.fn(() => Promise.resolve({ data: null, error: null }));
    c.maybeSingle = vi.fn(() => {
      // schedule_periods:控制 period 撈到的 row(新 POST 流程用)
      if (table === 'schedule_periods') {
        return Promise.resolve({ data: overrides.scheduleperiodRow, error: null });
      }
      // employees:控制「被改 schedule 的員工的 dept_id」(新 POST inSameDept 檢查用)
      if (table === 'employees' && overrides.employeeDeptId !== null) {
        return Promise.resolve({ data: { dept_id: overrides.employeeDeptId }, error: null });
      }
      // schedules:upsert().select().maybeSingle() 回有效 row 讓 handler 走完
      if (table === 'schedules') {
        return Promise.resolve({ data: { id: 'S_MOCK' }, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    });
    // chain thenable:對 employees table 回 deptEmpIds(讓主管 scope 拿到部門員工 list)
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

vi.mock('../lib/push.js', () => ({
  sendPushToEmployees: vi.fn(async () => ({ sent: 0 })),
  sendPushToRoles: vi.fn(async () => ({ sent: 0 })),
  createNotification: vi.fn(async () => undefined),
  createNotifications: vi.fn(async () => undefined),
  createNotificationsForRoles: vi.fn(async () => undefined),
}));

vi.mock('../lib/dept-name-mapper.js', () => ({
  addDeptName: vi.fn(),
  addDeptNameNested: vi.fn(),
  addDeptNameSingle: vi.fn(),
}));

vi.mock('../lib/leave/overlay.js', () => ({
  applyLeaveOverlay: vi.fn((rows) => rows),
  markPostHocFromAttendance: vi.fn((rows) => rows),
}));

vi.mock('../lib/schedule/work-hours.js', () => ({
  calculateScheduleWorkMinutes: vi.fn(() => 480),
}));

vi.mock('../lib/schedule/change-logger.js', () => ({
  logScheduleChange: vi.fn(async () => undefined),
}));

vi.mock('../lib/schedule/permissions.js', () => ({
  canEmployeeEditSchedule: vi.fn(() => overrides.employeePermResult),
  canManagerEditSchedule: vi.fn(() => overrides.managerPermResult),
  // G1:測 inline 邏輯、本檔 scope 測試的 body 沒帶 shift_type_id → 一律 ok
  checkEmployeeShiftRestricted: (body) => {
    const stid = body?.shift_type_id;
    if (!stid) return { ok: true };
    if (stid === 'ST003' && body.note === '__OFF__') return { ok: true };
    return { ok: false, reason: 'EMPLOYEE_SHIFT_RESTRICTED' };
  },
}));

vi.mock('../lib/shift-types/handler.js', () => ({
  listShiftTypes: vi.fn(async () => ({ status: 200, body: [] })),
  createShiftType: vi.fn(async () => ({ status: 201, body: { id: 'ST_NEW' } })),
  updateShiftType: vi.fn(async () => ({ status: 200, body: { id: 'ST_X' } })),
  deleteShiftType: vi.fn(async () => ({ status: 200, body: { ok: true } })),
}));

const { default: handler } = await import('../api/schedules/index.js');

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
  overrides.scheduleperiodRow = null;
  overrides.employeeDeptId = null;
  overrides.managerPermResult = { ok: false, reason: 'NOT_MANAGER' };
  overrides.employeePermResult = { ok: false, reason: 'NOT_ALLOWED' };
});

const HR  = { id: 'HR1', role: 'hr',       is_manager: false, dept_id: 'D_HR' };
const MGR = { id: 'M1',  role: 'employee', is_manager: true,  dept_id: 'D1' };
const EMP = { id: 'E1',  role: 'employee', is_manager: false, dept_id: 'D1' };

// ════════════════════════════════════════════════════════════
// auth gate — 未登入應 401
// ════════════════════════════════════════════════════════════
describe('/api/schedules — auth gate(未登入 → 401)', () => {
  it('未登入 legacy GET → 401', async () => {
    const [req, res] = makeReqRes({ query: { start: '2026-05-01', end: '2026-05-07' } });
    await handler(req, res);
    expect(res.statusCode).toBe(401);
  });

  it('未登入 新 GET(period_id) → 401', async () => {
    const [req, res] = makeReqRes({ query: { period_id: 'P1' } });
    await handler(req, res);
    expect(res.statusCode).toBe(401);
  });

  it('未登入 新 POST → 401', async () => {
    const [req, res] = makeReqRes({
      method: 'POST',
      body: { period_id: 'P1', employee_id: 'E1', work_date: '2026-06-01' },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(401);
  });
});

// ════════════════════════════════════════════════════════════
// 新 GET — scope 矩陣(?period_id 或 ?year)
// ════════════════════════════════════════════════════════════
describe('/api/schedules 新 GET — scope 矩陣', () => {
  it('員工查自己 → 200 + .eq employee_id=self', async () => {
    overrides.caller = EMP;
    const [req, res] = makeReqRes({ query: { period_id: 'P1', employee_id: 'E1' } });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    const eq = calls.eqs.find(e => e.table === 'schedules' && e.col === 'employee_id');
    expect(eq?.val).toBe('E1');
  });

  it('員工查他人 → 403', async () => {
    overrides.caller = EMP;
    const [req, res] = makeReqRes({ query: { period_id: 'P1', employee_id: 'E_other' } });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
  });

  it('員工不帶 employee_id → 自動 .eq self', async () => {
    overrides.caller = EMP;
    const [req, res] = makeReqRes({ query: { period_id: 'P1' } });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    const eq = calls.eqs.find(e => e.table === 'schedules' && e.col === 'employee_id');
    expect(eq?.val).toBe('E1');
  });

  it('主管查同部門他人 → 200', async () => {
    overrides.caller = MGR;
    overrides.deptEmpIds = ['E1', 'E2'];
    const [req, res] = makeReqRes({ query: { period_id: 'P1', employee_id: 'E1' } });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
  });

  it('主管查跨部門他人 → 403', async () => {
    overrides.caller = MGR;
    overrides.deptEmpIds = ['E1', 'E2'];   // E_OTHER 不在
    const [req, res] = makeReqRes({ query: { period_id: 'P1', employee_id: 'E_OTHER' } });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
  });

  it('主管不帶 employee_id → 200 + .in 範圍含本部門', async () => {
    overrides.caller = MGR;
    overrides.deptEmpIds = ['E1', 'E2'];
    const [req, res] = makeReqRes({ query: { period_id: 'P1' } });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    const inCall = calls.ins.find(i => i.table === 'schedules' && i.col === 'employee_id');
    expect(inCall?.vals).toContain('M1');
    expect(inCall?.vals).toContain('E1');
    expect(inCall?.vals).toContain('E2');
  });

  it('HR 查任何人 → 200 + .eq employee_id=查的人', async () => {
    overrides.caller = HR;
    const [req, res] = makeReqRes({ query: { period_id: 'P1', employee_id: 'E_any' } });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    const eq = calls.eqs.find(e => e.table === 'schedules' && e.col === 'employee_id');
    expect(eq?.val).toBe('E_any');
  });

  it('HR 不帶 employee_id → 200 + 不加 employee_id filter', async () => {
    overrides.caller = HR;
    const [req, res] = makeReqRes({ query: { period_id: 'P1' } });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    const eq = calls.eqs.find(e => e.table === 'schedules' && e.col === 'employee_id');
    expect(eq).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════
// Legacy GET — scope 矩陣(?dept/start/end/month)
// ════════════════════════════════════════════════════════════
describe('/api/schedules legacy GET — scope 矩陣', () => {
  it('員工查自己 → .eq employee_id=self', async () => {
    overrides.caller = EMP;
    const [req, res] = makeReqRes({ query: { employee_id: 'E1', start: '2026-05-01', end: '2026-05-07' } });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    const eq = calls.eqs.find(e => e.table === 'schedules' && e.col === 'employee_id');
    expect(eq?.val).toBe('E1');
  });

  it('員工查他人 → 403', async () => {
    overrides.caller = EMP;
    const [req, res] = makeReqRes({ query: { employee_id: 'E_other', start: '2026-05-01', end: '2026-05-07' } });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
  });

  it('員工不帶 employee_id → 自動 .eq self', async () => {
    overrides.caller = EMP;
    const [req, res] = makeReqRes({ query: { start: '2026-05-01', end: '2026-05-07' } });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    const eq = calls.eqs.find(e => e.table === 'schedules' && e.col === 'employee_id');
    expect(eq?.val).toBe('E1');
  });

  it('主管查同部門他人 → 200', async () => {
    overrides.caller = MGR;
    overrides.deptEmpIds = ['E1', 'E2'];
    const [req, res] = makeReqRes({ query: { employee_id: 'E1', start: '2026-05-01', end: '2026-05-07' } });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
  });

  it('主管查跨部門 → 403', async () => {
    overrides.caller = MGR;
    overrides.deptEmpIds = ['E1', 'E2'];
    const [req, res] = makeReqRes({ query: { employee_id: 'E_OTHER', start: '2026-05-01', end: '2026-05-07' } });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
  });

  it('主管不帶 emp_id → 200 + .in 範圍含本部門', async () => {
    overrides.caller = MGR;
    overrides.deptEmpIds = ['E1', 'E2'];
    const [req, res] = makeReqRes({ query: { start: '2026-05-01', end: '2026-05-07' } });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    const inCall = calls.ins.find(i => i.table === 'schedules' && i.col === 'employee_id');
    expect(inCall?.vals).toContain('M1');
    expect(inCall?.vals).toContain('E1');
    expect(inCall?.vals).toContain('E2');
  });

  it('HR 不帶 emp_id → 不加 employee_id filter', async () => {
    overrides.caller = HR;
    const [req, res] = makeReqRes({ query: { start: '2026-05-01', end: '2026-05-07' } });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    const eq = calls.eqs.find(e => e.table === 'schedules' && e.col === 'employee_id');
    expect(eq).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════
// ?_resource=shift_types(現況 lock + role gate)
// ════════════════════════════════════════════════════════════
describe('/api/schedules ?_resource=shift_types', () => {
  it('GET 未登入 → 200(公開 metadata 不需 auth、現況 lock)', async () => {
    const [req, res] = makeReqRes({ query: { _resource: 'shift_types' } });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
  });

  it('GET 員工 → 200', async () => {
    overrides.caller = EMP;
    const [req, res] = makeReqRes({ query: { _resource: 'shift_types' } });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
  });

  it('POST 未登入 → 401', async () => {
    const [req, res] = makeReqRes({ method: 'POST', query: { _resource: 'shift_types' }, body: { name: 'X' } });
    await handler(req, res);
    expect(res.statusCode).toBe(401);
  });

  it('POST 員工(非 manager、非 BACKOFFICE)→ 403', async () => {
    overrides.caller = EMP;
    const [req, res] = makeReqRes({ method: 'POST', query: { _resource: 'shift_types' }, body: { name: 'X' } });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
  });

  it('POST HR → 201', async () => {
    overrides.caller = HR;
    const [req, res] = makeReqRes({ method: 'POST', query: { _resource: 'shift_types' }, body: { name: 'X' } });
    await handler(req, res);
    expect(res.statusCode).toBe(201);
  });

  it('POST 主管(allowManager=true 通過)→ 201', async () => {
    overrides.caller = MGR;
    const [req, res] = makeReqRes({ method: 'POST', query: { _resource: 'shift_types' }, body: { name: 'X' } });
    await handler(req, res);
    expect(res.statusCode).toBe(201);
  });
});

// ════════════════════════════════════════════════════════════
// ?_resource=shift_types_item PATCH/DELETE — role gate
// ════════════════════════════════════════════════════════════
describe('/api/schedules ?_resource=shift_types_item', () => {
  it('PATCH 員工 → 403', async () => {
    overrides.caller = EMP;
    const [req, res] = makeReqRes({ method: 'PATCH', query: { _resource: 'shift_types_item', id: 'ST_X' } });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
  });

  it('PATCH HR → 200', async () => {
    overrides.caller = HR;
    const [req, res] = makeReqRes({ method: 'PATCH', query: { _resource: 'shift_types_item', id: 'ST_X' } });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
  });

  it('DELETE 員工 → 403', async () => {
    overrides.caller = EMP;
    const [req, res] = makeReqRes({ method: 'DELETE', query: { _resource: 'shift_types_item', id: 'ST_X' } });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
  });

  it('DELETE 主管 → 200(allowManager=true 通過)', async () => {
    overrides.caller = MGR;
    const [req, res] = makeReqRes({ method: 'DELETE', query: { _resource: 'shift_types_item', id: 'ST_X' } });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
  });
});

// ════════════════════════════════════════════════════════════
// 新 POST(period_id in body)— inline 員工/主管權限
// ════════════════════════════════════════════════════════════
describe('/api/schedules 新 POST — inline 員工/主管權限', () => {
  it('員工建他人 schedule → 403(canManagerEditSchedule 擋)', async () => {
    overrides.caller = EMP;
    overrides.scheduleperiodRow = { id: 'P1', status: 'draft' };
    overrides.employeeDeptId = 'D2';   // 他人在 D2 部門、跟 EMP 不同
    overrides.managerPermResult = { ok: false, reason: 'NOT_MANAGER' };
    const [req, res] = makeReqRes({
      method: 'POST',
      body: { period_id: 'P1', employee_id: 'E_OTHER', work_date: '2026-06-01' },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
  });

  it('員工建自己 schedule → 201(canEmployeeEditSchedule.ok=true)', async () => {
    overrides.caller = EMP;
    overrides.scheduleperiodRow = { id: 'P1', status: 'draft' };
    overrides.employeePermResult = { ok: true };
    const [req, res] = makeReqRes({
      method: 'POST',
      body: { period_id: 'P1', employee_id: 'E1', work_date: '2026-06-01' },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(201);
  });

  it('主管建同部門員工 schedule → 201(canManagerEditSchedule.ok=true)', async () => {
    overrides.caller = MGR;
    overrides.scheduleperiodRow = { id: 'P1', status: 'draft' };
    overrides.employeeDeptId = 'D1';   // 同部門
    overrides.managerPermResult = { ok: true, isLateChange: false };
    const [req, res] = makeReqRes({
      method: 'POST',
      body: { period_id: 'P1', employee_id: 'E1', work_date: '2026-06-01' },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(201);
  });

  it('新 POST period 找不到 → 404', async () => {
    overrides.caller = EMP;
    overrides.scheduleperiodRow = null;   // 不 set
    const [req, res] = makeReqRes({
      method: 'POST',
      body: { period_id: 'P_NOT_EXIST', employee_id: 'E1', work_date: '2026-06-01' },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(404);
  });

  it('新 POST 缺必填欄位 → 400', async () => {
    overrides.caller = EMP;
    const [req, res] = makeReqRes({
      method: 'POST',
      body: { period_id: 'P1' },  // 缺 employee_id / work_date
    });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
  });
});
