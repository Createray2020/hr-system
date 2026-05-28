// tests/api-system-accounts-exclusion.test.js
//
// 階段 2.7.7 範圍擴大、抓 16 個 endpoint「列表結果不含 EMP_99999999」的行為。
//
// 測試策略:
//   - 用 in-memory supabase chain mock、攔截 .eq / .neq / .in 把 dataByTable filter
//     套用後回傳(模擬真實 PG behavior、含 .neq 真的過濾)
//   - 每個 endpoint 設 employees data 含 [真員工, EMP_99999999]
//   - 呼叫 handler / 直接函式、assert response 不含 EMP_99999999
//   - assert chain spy 有捕到 .neq('id','EMP_99999999')(防 helper 被誤改 / 漏接)
//
// 不做的:
//   - 不模擬 PG 完整 SQL behavior(.gte / .lte / .or 等只 passthrough、不真套用)
//   - 不打真實 DB
//   - 不驗 supabase 實際 query plan(那是供應商 contract)

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── 共用 chain spy ──────────────────────────────────────────
let dataByTable = {};
let neqSpyCalls = [];

function makeChain(table) {
  const filters = [];
  const c = {};
  c.select = vi.fn(() => c);
  c.eq = vi.fn((col, val) => { filters.push(['eq', col, val]); return c; });
  c.neq = vi.fn((col, val) => {
    if (table === 'employees') neqSpyCalls.push({ col, val });
    filters.push(['neq', col, val]);
    return c;
  });
  c.in = vi.fn((col, vals) => { filters.push(['in', col, vals]); return c; });
  // 對齊 8c44806 soft-delete 加的 .is('deleted_at', null) filter,實作 IS NULL 語意:
  // .is(col, null) → 該欄為 NULL / undefined / 缺欄位 → 視為符合(對齊 SQL `col IS NULL`)
  c.is = vi.fn((col, val) => { filters.push(['is', col, val]); return c; });
  c.or = vi.fn(() => c);
  c.gte = vi.fn(() => c); c.lte = vi.fn(() => c);
  c.gt = vi.fn(() => c); c.lt = vi.fn(() => c);
  c.order = vi.fn(() => c); c.limit = vi.fn(() => c); c.like = vi.fn(() => c);

  function applyFilters() {
    const rows = dataByTable[table] || [];
    return rows.filter(row => {
      for (const [op, col, val] of filters) {
        if (op === 'eq'  && row[col] !== val) return false;
        if (op === 'neq' && row[col] === val) return false;
        if (op === 'in'  && !val.includes(row[col])) return false;
        // .is(col, null):row[col] 必須是 null / undefined(對齊 SQL `col IS NULL`)
        if (op === 'is'  && val === null && row[col] != null) return false;
      }
      return true;
    });
  }

  c.maybeSingle = vi.fn(() => {
    const f = applyFilters();
    return Promise.resolve({ data: f[0] || null, error: null });
  });
  c.single = vi.fn(() => {
    const f = applyFilters();
    return Promise.resolve({ data: f[0] || null, error: null });
  });
  c.insert = vi.fn(() => Promise.resolve({ error: null, data: null }));
  c.update = vi.fn(() => ({
    eq: vi.fn(() => Promise.resolve({ error: null, data: null })),
  }));
  c.upsert = vi.fn(() => Promise.resolve({ error: null, data: null }));
  c.delete = vi.fn(() => ({
    eq: vi.fn(() => Promise.resolve({ error: null })),
  }));
  c.then = (onF, onR) => Promise.resolve({ data: applyFilters(), error: null }).then(onF, onR);
  return c;
}

const supabaseStub = { from: vi.fn((t) => makeChain(t)) };

vi.mock('../lib/supabase.js', () => ({
  supabase: supabaseStub,
  supabaseAdmin: supabaseStub,
}));

// ─── Auth / 其他 lib stubs ──────────────────────────────────
let mockCaller = { id: 'EMP_HR', role: 'hr', is_manager: false, dept_id: 'D1', email: 'hr@x.com' };

vi.mock('../lib/auth.js', () => ({
  requireAuth: vi.fn(async () => mockCaller),
  requireRole: vi.fn(async () => mockCaller),
  getAuthUser: vi.fn(async () => null),
  getEmployee: vi.fn(async () => null),
}));

vi.mock('../lib/cron-auth.js', () => ({
  requireCron: vi.fn(() => true),
}));

vi.mock('../lib/push.js', () => ({
  sendPushToEmployees: vi.fn(async () => {}),
  sendPushToRoles: vi.fn(async () => {}),
  createNotifications: vi.fn(async () => {}),
  createNotification: vi.fn(async () => {}),
  createNotificationsForRoles: vi.fn(async () => {}),
}));

vi.mock('../lib/dept-name-mapper.js', () => ({
  addDeptName: vi.fn(),
  addDeptNameNested: vi.fn(),
  addDeptNameSingle: vi.fn(),
  attachManagerNames: vi.fn(async (rows) => rows),
}));

vi.mock('../lib/dept-sync.js', () => ({
  syncDeptFields: vi.fn(),
}));

vi.mock('../lib/roles.js', () => ({
  BACKOFFICE_ROLES: ['hr', 'admin', 'ceo', 'chairman'],
  isBackofficeRole: (u) => ['hr', 'admin', 'ceo', 'chairman'].includes(u?.role),
  canAccessBackoffice: (u) => ['hr', 'admin', 'ceo', 'chairman'].includes(u?.role),
  skipAttendanceBonus: () => false,
  resolveApproverRoleToEmployeeIds: vi.fn(async () => []),
  resolveRoleSetToEmployeeIds: vi.fn(async () => []),
}));

beforeEach(() => {
  dataByTable = {};
  neqSpyCalls = [];
});

function makeRes() {
  return {
    statusCode: 200,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    end() { return this; },
  };
}

function expectFilterApplied() {
  expect(neqSpyCalls).toContainEqual({ col: 'id', val: 'EMP_99999999' });
}

const realEmp = { id: 'EMP_REAL', name: '真員工', status: 'active', dept_id: 'D1', role: 'employee', is_manager: false };
const sysEmp  = { id: 'EMP_99999999', name: '系統管理員', status: 'active', dept_id: 'D1', role: 'admin', is_manager: false };

// ─── B1.8: lib/auth-scope.js findActiveEmployeeIdsByDept ─────
describe('B1: lib/auth-scope.js findActiveEmployeeIdsByDept', () => {
  it('部門員工列表 → 不含 EMP_99999999', async () => {
    dataByTable.employees = [realEmp, sysEmp];
    const { makeDeptEmpIdsRepo } = await import('../lib/auth-scope.js');
    const repo = makeDeptEmpIdsRepo(supabaseStub);
    const ids = await repo.findActiveEmployeeIdsByDept('D1');
    expect(ids).toEqual(['EMP_REAL']);
    expectFilterApplied();
  });
});

// ─── B1.1~3: api/employees/index.js ──────────────────────────
describe('B1: api/employees/index.js', () => {
  it('orgchart (?_resource=orgchart) → 不含 EMP_99999999', async () => {
    dataByTable.employees = [realEmp, sysEmp];
    dataByTable.departments = [{ id: 'D1', name: 'Dept', color: '#000' }];
    mockCaller = { id: 'EMP_HR', role: 'hr', is_manager: false, dept_id: 'D1' };
    const { default: handler } = await import('../api/employees/index.js');
    const req = { method: 'GET', query: { _resource: 'orgchart' } };
    const res = makeRes();
    await handler(req, res);
    const ids = (res.body?.employees || []).map(e => e.id);
    expect(ids).not.toContain('EMP_99999999');
    expect(ids).toContain('EMP_REAL');
    expectFilterApplied();
  });

  it('dept stats (?_resource=departments GET) emp_count → EMP_99999999 不算', async () => {
    dataByTable.employees = [realEmp, sysEmp, { ...realEmp, id: 'EMP_R2' }];
    dataByTable.departments = [{ id: 'D1', name: 'Dept', manager_id: null }];
    mockCaller = { id: 'EMP_HR', role: 'hr', is_manager: false, dept_id: 'D1' };
    const { default: handler } = await import('../api/employees/index.js');
    const req = { method: 'GET', query: { _resource: 'departments' } };
    const res = makeRes();
    await handler(req, res);
    expect(res.body[0].emp_count).toBe(2);  // 2 個真員工、不含 EMP_99999999
    expectFilterApplied();
  });

  it('員工管理頁主列表 → 不含 EMP_99999999', async () => {
    dataByTable.employees = [realEmp, sysEmp];
    mockCaller = { id: 'EMP_HR', role: 'hr', is_manager: false, dept_id: 'D1' };
    const { default: handler } = await import('../api/employees/index.js');
    const req = { method: 'GET', query: {} };
    const res = makeRes();
    await handler(req, res);
    const ids = (Array.isArray(res.body) ? res.body : []).map(e => e.id);
    expect(ids).not.toContain('EMP_99999999');
    expectFilterApplied();
  });
});

// ─── B1.4: api/attendance/index.js ────────────────────────────
describe('B1: api/attendance/index.js', () => {
  it('GET ?all 出勤管理 enrichment → empMap 不含 EMP_99999999', async () => {
    dataByTable.employees = [realEmp, sysEmp];
    dataByTable.attendance = [];
    mockCaller = { id: 'EMP_HR', role: 'hr', is_manager: false };
    const { default: handler } = await import('../api/attendance/index.js');
    const req = { method: 'GET', query: { all: 'true', start: '2026-05-01', end: '2026-05-31' } };
    const res = makeRes();
    await handler(req, res);
    expectFilterApplied();
  });
});

// ─── B1.5 + B3.1: api/announcements.js (push target + author lookup) ──
describe('B1+B3: api/announcements.js', () => {
  it('GET 列表 author 補名稱 → 不撈 EMP_99999999', async () => {
    dataByTable.announcements = [{ id: 1, author_id: 'EMP_REAL', is_published: true }];
    dataByTable.employees = [realEmp, sysEmp];
    const { default: handler } = await import('../api/announcements.js');
    const req = { method: 'GET', query: {} };
    const res = makeRes();
    await handler(req, res);
    expectFilterApplied();
  });

  it('POST action=publish push target 列表 → 不含 EMP_99999999', async () => {
    dataByTable.employees = [realEmp, sysEmp];
    dataByTable.announcements = [{ id: 'A1', target_roles: ['all'], title: 't', content: 'c' }];
    const { default: handler } = await import('../api/announcements.js');
    const req = {
      method: 'POST',
      query: {},
      body: { action: 'publish', id: 'A1' },
    };
    const res = makeRes();
    await handler(req, res);
    expectFilterApplied();
  });
});

// ─── B1.6: api/cron-schedule-reminder.js ─────────────────────
describe('B1: api/cron-schedule-reminder.js', () => {
  it('cron 撈 active 員工 enum → 不含 EMP_99999999', async () => {
    dataByTable.employees = [realEmp, sysEmp];
    dataByTable.schedule_periods = [];
    const { default: handler } = await import('../api/cron-schedule-reminder.js');
    const req = { method: 'GET', query: { year: 2026, month: 5 } };
    const res = makeRes();
    await handler(req, res);
    expectFilterApplied();
  });
});

// ─── B1.7 + B3.8: api/salary/index.js ─────────────────────────
describe('B1+B3: api/salary/index.js', () => {
  it('legacy POST ?_action=batch enum → 不含 EMP_99999999', async () => {
    dataByTable.employees = [realEmp, sysEmp];
    mockCaller = { id: 'EMP_HR', role: 'hr', is_manager: false, dept_id: 'D1' };
    const { default: handler } = await import('../api/salary/index.js');
    const req = {
      method: 'POST',
      query: { _action: 'batch' },
      body: { year: 2026, month: 5 },
    };
    const res = makeRes();
    await handler(req, res);
    expectFilterApplied();
  });

  it('GET ?v=2 handleNewGet enrichment → 不含 EMP_99999999', async () => {
    dataByTable.salary_records = [{ id: 'S1', employee_id: 'EMP_REAL', year: 2026, month: 5 }];
    dataByTable.employees = [realEmp, sysEmp];
    mockCaller = { id: 'EMP_HR', role: 'hr', is_manager: false, dept_id: 'D1' };
    const { default: handler } = await import('../api/salary/index.js');
    const req = { method: 'GET', query: { v: '2', year: 2026, month: 5 } };
    const res = makeRes();
    await handler(req, res);
    expectFilterApplied();
  });
});

// ─── B3.2: api/comp-time/index.js ─────────────────────────────
describe('B3: api/comp-time/index.js', () => {
  it('HR list 補員工資料 → 不含 EMP_99999999', async () => {
    dataByTable.comp_time_balance = [{ id: 1, employee_id: 'EMP_REAL', earned_hours: 8, used_hours: 0, status: 'active' }];
    dataByTable.employees = [realEmp, sysEmp];
    mockCaller = { id: 'EMP_HR', role: 'hr', is_manager: false };
    const { default: handler } = await import('../api/comp-time/index.js');
    const req = { method: 'GET', query: {} };
    const res = makeRes();
    await handler(req, res);
    expectFilterApplied();
  });
});

// ─── B3.3: api/leaves/index.js ────────────────────────────────
describe('B3: api/leaves/index.js', () => {
  it('GET 列表 enrichment → 不含 EMP_99999999', async () => {
    dataByTable.leave_requests = [{ id: 'L1', employee_id: 'EMP_REAL', status: 'approved' }];
    dataByTable.employees = [realEmp, sysEmp];
    mockCaller = { id: 'EMP_HR', role: 'hr', is_manager: false, dept_id: 'D1' };
    const { default: handler } = await import('../api/leaves/index.js');
    const req = { method: 'GET', query: {} };
    const res = makeRes();
    await handler(req, res);
    expectFilterApplied();
  });
});

// ─── B3.4: api/annual-leaves/index.js ─────────────────────────
describe('B3: api/annual-leaves/index.js', () => {
  it('GET 列表 enrichment → 不含 EMP_99999999', async () => {
    dataByTable.annual_leave_records = [{ id: 1, employee_id: 'EMP_REAL', status: 'active' }];
    dataByTable.employees = [realEmp, sysEmp];
    mockCaller = { id: 'EMP_HR', role: 'hr', is_manager: false };
    const { default: handler } = await import('../api/annual-leaves/index.js');
    const req = { method: 'GET', query: {} };
    const res = makeRes();
    await handler(req, res);
    expectFilterApplied();
  });
});

// ─── B3.5: api/schedules/index.js ─────────────────────────────
describe('B3: api/schedules/index.js', () => {
  it('GET 列表 enrichment → 不含 EMP_99999999', async () => {
    dataByTable.schedules = [{ id: 'S1', employee_id: 'EMP_REAL', work_date: '2026-05-01', segment_no: 1 }];
    dataByTable.employees = [realEmp, sysEmp];
    mockCaller = { id: 'EMP_HR', role: 'hr', is_manager: false, dept_id: 'D1' };
    const { default: handler } = await import('../api/schedules/index.js');
    const req = { method: 'GET', query: { start: '2026-05-01', end: '2026-05-31' } };
    const res = makeRes();
    await handler(req, res);
    expectFilterApplied();
  });
});

// ─── B3.6: api/attendance-penalty-records/index.js ────────────
describe('B3: api/attendance-penalty-records/index.js', () => {
  it('GET 列表 enrichment → 不含 EMP_99999999', async () => {
    dataByTable.attendance_penalty_records = [{ id: 1, employee_id: 'EMP_REAL', applies_to_year: 2026, applies_to_month: 5 }];
    dataByTable.employees = [realEmp, sysEmp];
    mockCaller = { id: 'EMP_HR', role: 'hr', is_manager: false, dept_id: 'D1' };
    const { default: handler } = await import('../api/attendance-penalty-records/index.js');
    const req = { method: 'GET', query: { year: 2026, month: 5 } };
    const res = makeRes();
    await handler(req, res);
    expectFilterApplied();
  });
});

// ─── B3.7: api/overtime-requests/index.js ─────────────────────
describe('B3: api/overtime-requests/index.js', () => {
  it('GET 列表 attachEmployeeAndManager → 不含 EMP_99999999', async () => {
    dataByTable.overtime_requests = [{ id: 1, employee_id: 'EMP_REAL', status: 'approved' }];
    dataByTable.employees = [realEmp, sysEmp];
    mockCaller = { id: 'EMP_HR', role: 'hr', is_manager: false, dept_id: 'D1' };
    const { default: handler } = await import('../api/overtime-requests/index.js');
    const req = { method: 'GET', query: {} };
    const res = makeRes();
    await handler(req, res);
    expectFilterApplied();
  });
});
