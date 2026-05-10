// tests/api-salary-annual-summary.test.js
//
// 階段 C2:GET /api/salary?_resource=annual_summary&year=Y endpoint 行為:
//   - HR-only 角色 gate (非 HR 401/403)
//   - status='paid'/'locked' filter (draft / pending_review 不應出現)
//   - year query 必填 + 範圍驗證
//   - EMP_99999999 / 系統帳號排除 (依賴 applyExcludeSystemAccountsQuery)

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── In-memory data + spies ──────────────────────────────
let dataByTable = {};
let salaryStatusFilter = [];   // 攔到的 .in('status', [...]) 值
let salaryYearFilter   = null;

function makeChain(table) {
  const filters = [];
  const c = {};
  c.select = vi.fn(() => c);
  c.eq = vi.fn((col, val) => {
    if (table === 'salary_records' && col === 'year') salaryYearFilter = val;
    filters.push(['eq', col, val]);
    return c;
  });
  c.neq = vi.fn(() => c);
  c.in = vi.fn((col, vals) => {
    if (table === 'salary_records' && col === 'status') salaryStatusFilter = vals;
    filters.push(['in', col, vals]);
    return c;
  });
  c.order = vi.fn(() => c);
  c.limit = vi.fn(() => c);
  c.maybeSingle = vi.fn(() => Promise.resolve({ data: null, error: null }));
  c.then = (onF, onR) => Promise.resolve({
    data: applyFilters(dataByTable[table] || [], filters),
    error: null,
  }).then(onF, onR);
  return c;
}

function applyFilters(rows, filters) {
  return rows.filter(row => {
    for (const [op, col, val] of filters) {
      if (op === 'eq' && row[col] !== val) return false;
      if (op === 'in' && !val.includes(row[col])) return false;
      if (op === 'neq' && row[col] === val) return false;
    }
    return true;
  });
}

const supabaseStub = { from: vi.fn((t) => makeChain(t)) };
vi.mock('../lib/supabase.js', () => ({
  supabase: supabaseStub, supabaseAdmin: supabaseStub,
}));

let mockCaller = null;
vi.mock('../lib/auth.js', () => ({
  requireAuth: vi.fn(async (req, res) => mockCaller || (res.status(401).json({ error: 'Unauthorized' }), null)),
  requireRole: vi.fn(async (req, res, allowedRoles) => {
    if (!mockCaller) { res.status(401).json({ error: 'Unauthorized' }); return null; }
    if (!allowedRoles.includes(mockCaller.role)) { res.status(403).json({ error: 'Forbidden' }); return null; }
    return mockCaller;
  }),
  getAuthUser: vi.fn(async () => null),
  getEmployee: vi.fn(async () => null),
}));

vi.mock('../lib/dept-name-mapper.js', () => ({
  addDeptName: vi.fn((rows) => { (rows || []).forEach(r => { r.dept_name = r.departments?.name || ''; }); }),
  addDeptNameNested: vi.fn(),
  addDeptNameSingle: vi.fn(),
  attachManagerNames: vi.fn(async (r) => r),
}));

vi.mock('../lib/roles.js', () => ({
  BACKOFFICE_ROLES: ['hr','admin','ceo','chairman'],
  isBackofficeRole: (u) => ['hr','admin','ceo','chairman'].includes(u?.role),
  canAccessBackoffice: (u) => ['hr','admin','ceo','chairman'].includes(u?.role),
  skipAttendanceBonus: () => false,
}));

vi.mock('../lib/push.js', () => ({
  sendPushToEmployees: vi.fn(async () => {}),
  sendPushToRoles: vi.fn(async () => {}),
  createNotifications: vi.fn(async () => {}),
  createNotification: vi.fn(async () => {}),
  createNotificationsForRoles: vi.fn(async () => {}),
}));

beforeEach(() => {
  dataByTable = {};
  salaryStatusFilter = [];
  salaryYearFilter = null;
});

function makeRes() {
  return {
    statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    end() { return this; },
  };
}

// ─── Tests ───────────────────────────────────────────────
describe('GET /api/salary?_resource=annual_summary - 角色 gate + filter', () => {
  it('未登入 → 401', async () => {
    mockCaller = null;
    const { default: handler } = await import('../api/salary/index.js');
    const res = makeRes();
    await handler({ method: 'GET', query: { _resource: 'annual_summary', year: '2025' } }, res);
    expect(res.statusCode).toBe(401);
  });

  it('員工 role → 403 (HR-only)', async () => {
    mockCaller = { id: 'EMP_X', role: 'employee' };
    const { default: handler } = await import('../api/salary/index.js');
    const res = makeRes();
    await handler({ method: 'GET', query: { _resource: 'annual_summary', year: '2025' } }, res);
    expect(res.statusCode).toBe(403);
  });

  it('manager (沒 HR role) → 403 (HR-only、不認 is_manager)', async () => {
    mockCaller = { id: 'EMP_M', role: 'employee', is_manager: true };
    const { default: handler } = await import('../api/salary/index.js');
    const res = makeRes();
    await handler({ method: 'GET', query: { _resource: 'annual_summary', year: '2025' } }, res);
    expect(res.statusCode).toBe(403);
  });

  it('hr role → 200 + 通過', async () => {
    mockCaller = { id: 'EMP_HR', role: 'hr' };
    dataByTable.salary_records = [];
    dataByTable.employees = [];
    const { default: handler } = await import('../api/salary/index.js');
    const res = makeRes();
    await handler({ method: 'GET', query: { _resource: 'annual_summary', year: '2025' } }, res);
    expect(res.statusCode).toBe(200);
  });

  it('year 缺 → 400', async () => {
    mockCaller = { id: 'EMP_HR', role: 'hr' };
    const { default: handler } = await import('../api/salary/index.js');
    const res = makeRes();
    await handler({ method: 'GET', query: { _resource: 'annual_summary' } }, res);
    expect(res.statusCode).toBe(400);
  });

  it('year 範圍外 → 400', async () => {
    mockCaller = { id: 'EMP_HR', role: 'hr' };
    const { default: handler } = await import('../api/salary/index.js');
    const res = makeRes();
    await handler({ method: 'GET', query: { _resource: 'annual_summary', year: '1999' } }, res);
    expect(res.statusCode).toBe(400);
  });

  it('query 套 year + status IN [paid, locked] (draft/pending_review 不應出現)', async () => {
    mockCaller = { id: 'EMP_HR', role: 'hr' };
    dataByTable.salary_records = [
      { employee_id: 'EMP_01', year: 2025, month: 1, status: 'paid',           gross_salary: 50000, net_salary: 45000 },
      { employee_id: 'EMP_01', year: 2025, month: 2, status: 'locked',         gross_salary: 50000, net_salary: 45000 },
      { employee_id: 'EMP_01', year: 2025, month: 3, status: 'draft',          gross_salary: 50000, net_salary: 45000 },
      { employee_id: 'EMP_01', year: 2025, month: 4, status: 'pending_review', gross_salary: 50000, net_salary: 45000 },
      { employee_id: 'EMP_01', year: 2024, month: 1, status: 'paid',           gross_salary: 50000, net_salary: 45000 }, // 別年
    ];
    dataByTable.employees = [{ id: 'EMP_01', name: '張三', dept_id: 'D1', departments: { name: 'IT' } }];
    const { default: handler } = await import('../api/salary/index.js');
    const res = makeRes();
    await handler({ method: 'GET', query: { _resource: 'annual_summary', year: '2025' } }, res);
    expect(res.statusCode).toBe(200);
    expect(salaryYearFilter).toBe(2025);
    expect(salaryStatusFilter).toEqual(['paid', 'locked']);
    // Mock chain 套 filter 後、records 只剩 2025 年 paid+locked = 2 筆
    expect(res.body.records).toHaveLength(2);
    expect(res.body.records.every(r => ['paid','locked'].includes(r.status))).toBe(true);
    expect(res.body.records.every(r => r.year === 2025)).toBe(true);
  });

  it('回 employees map: empId → {name, dept_name}', async () => {
    mockCaller = { id: 'EMP_HR', role: 'hr' };
    dataByTable.salary_records = [
      { employee_id: 'EMP_01', year: 2025, month: 1, status: 'paid', gross_salary: 50000, net_salary: 45000 },
    ];
    dataByTable.employees = [{ id: 'EMP_01', name: '張三', dept_id: 'D1', departments: { name: 'IT' } }];
    const { default: handler } = await import('../api/salary/index.js');
    const res = makeRes();
    await handler({ method: 'GET', query: { _resource: 'annual_summary', year: '2025' } }, res);
    expect(res.body.employees).toEqual({
      EMP_01: { name: '張三', dept_name: 'IT' },
    });
  });

  it('records 裡 empId 不在 empMap 的 row 應被 filter 掉 (例:EMP_99999999 系統帳號排除後)', async () => {
    mockCaller = { id: 'EMP_HR', role: 'hr' };
    dataByTable.salary_records = [
      { employee_id: 'EMP_01',       year: 2025, month: 1, status: 'paid', gross_salary: 50000, net_salary: 45000 },
      { employee_id: 'EMP_99999999', year: 2025, month: 1, status: 'paid', gross_salary: 99999, net_salary: 99999 },
    ];
    // EMP_99999999 被 applyExcludeSystemAccountsQuery 過濾掉、不在 employees mock 裡
    dataByTable.employees = [{ id: 'EMP_01', name: '張三', dept_id: 'D1', departments: { name: 'IT' } }];
    const { default: handler } = await import('../api/salary/index.js');
    const res = makeRes();
    await handler({ method: 'GET', query: { _resource: 'annual_summary', year: '2025' } }, res);
    // records 應只剩 EMP_01、EMP_99999999 被 filter 掉
    expect(res.body.records).toHaveLength(1);
    expect(res.body.records[0].employee_id).toBe('EMP_01');
    expect(Object.keys(res.body.employees)).toEqual(['EMP_01']);
  });
});
