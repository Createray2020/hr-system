// tests/api-employees-by-ids.test.js
//
// 階段 C1:GET /api/employees?_resource=by_ids&ids=A,B,C
// 取代 frontend 直接 query supabase (overtime-review.html / overtime-admin.html)。
//
// 抓:
//   - HR 全員可見、ids 直接回 (filter EMP_99999999)
//   - 主管 dept-scope (跨部門 ids 被擋)
//   - 員工 only self
//   - ids 缺 / 空字串 → []
//   - 系統帳號 EMP_99999999 自動排除

import { describe, it, expect, vi, beforeEach } from 'vitest';

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
  c.or = vi.fn(() => c);
  c.order = vi.fn(() => c);
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
vi.mock('../lib/supabase.js', () => ({ supabase: supabaseStub, supabaseAdmin: supabaseStub }));

let mockCaller = null;
vi.mock('../lib/auth.js', () => ({
  requireAuth: vi.fn(async (req, res) => mockCaller || (res.status(401).json({ error:'Unauthorized' }), null)),
  requireRole: vi.fn(async (req, res, allowedRoles) => {
    if (!mockCaller) { res.status(401).json({ error:'Unauthorized' }); return null; }
    if (!allowedRoles.includes(mockCaller.role)) { res.status(403).json({ error:'Forbidden' }); return null; }
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
vi.mock('../lib/dept-sync.js', () => ({ syncDeptFields: vi.fn() }));
vi.mock('../lib/roles.js', () => ({
  BACKOFFICE_ROLES: ['hr','admin','ceo','chairman'],
  isBackofficeRole: (u) => ['hr','admin','ceo','chairman'].includes(u?.role),
  canAccessBackoffice: (u) => ['hr','admin','ceo','chairman'].includes(u?.role) || u?.is_manager === true,
  skipAttendanceBonus: () => false,
}));

beforeEach(() => {
  dataByTable = {};
  neqSpyCalls = [];
  mockCaller = null;
});

function makeRes() {
  return {
    statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    end() { return this; },
  };
}

const empA = { id:'EMP_01', name:'張三', dept_id:'D1', avatar:'A', departments:{ name:'IT' } };
const empB = { id:'EMP_02', name:'李四', dept_id:'D2', avatar:'B', departments:{ name:'HR' } };
const empC = { id:'EMP_03', name:'王五', dept_id:'D1', avatar:'C', departments:{ name:'IT' } };
const sysEmp = { id:'EMP_99999999', name:'系統', dept_id:'D1', avatar:'S', departments:{ name:'IT' }, status: 'active' };

describe('GET /api/employees?_resource=by_ids', () => {
  it('未登入 → 401', async () => {
    mockCaller = null;
    const { default: handler } = await import('../api/employees/index.js');
    const res = makeRes();
    await handler({ method:'GET', query:{ _resource:'by_ids', ids:'EMP_01' } }, res);
    expect(res.statusCode).toBe(401);
  });

  it('ids 缺 → []', async () => {
    mockCaller = { id:'EMP_HR', role:'hr' };
    const { default: handler } = await import('../api/employees/index.js');
    const res = makeRes();
    await handler({ method:'GET', query:{ _resource:'by_ids' } }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('HR → 給定 ids 全部回 + EMP_99999999 排除', async () => {
    mockCaller = { id:'EMP_HR', role:'hr' };
    dataByTable.employees = [empA, empB, sysEmp];
    const { default: handler } = await import('../api/employees/index.js');
    const res = makeRes();
    await handler({ method:'GET', query:{ _resource:'by_ids', ids:'EMP_01,EMP_02,EMP_99999999' } }, res);
    expect(res.statusCode).toBe(200);
    const ids = res.body.map(e => e.id);
    expect(ids).toContain('EMP_01');
    expect(ids).toContain('EMP_02');
    expect(ids).not.toContain('EMP_99999999');
    expect(neqSpyCalls).toContainEqual({ col:'id', val:'EMP_99999999' });
  });

  it('addDeptName 把 departments.name flatten 成 dept_name', async () => {
    mockCaller = { id:'EMP_HR', role:'hr' };
    dataByTable.employees = [empA];
    const { default: handler } = await import('../api/employees/index.js');
    const res = makeRes();
    await handler({ method:'GET', query:{ _resource:'by_ids', ids:'EMP_01' } }, res);
    expect(res.body[0].dept_name).toBe('IT');
  });

  it('員工 (非主管) → 只能看自己、其他 ids 被 filter', async () => {
    mockCaller = { id:'EMP_01', role:'employee', is_manager:false, dept_id:'D1' };
    dataByTable.employees = [empA, empB, empC];
    const { default: handler } = await import('../api/employees/index.js');
    const res = makeRes();
    await handler({ method:'GET', query:{ _resource:'by_ids', ids:'EMP_01,EMP_02,EMP_03' } }, res);
    expect(res.body.map(e => e.id)).toEqual(['EMP_01']);
  });

  it('主管 → 同部門 ids 才回 (跨部門被 filter)', async () => {
    // EMP_M 是 D1 主管、D1 員工只有 EMP_01 EMP_03、EMP_02 在 D2
    mockCaller = { id:'EMP_M', role:'employee', is_manager:true, dept_id:'D1' };
    dataByTable.employees = [
      { id:'EMP_01', dept_id:'D1', status:'active' },
      { id:'EMP_03', dept_id:'D1', status:'active' },
      { id:'EMP_02', dept_id:'D2', status:'active' },
      empA, empC,
    ];
    const { default: handler } = await import('../api/employees/index.js');
    const res = makeRes();
    await handler({ method:'GET', query:{ _resource:'by_ids', ids:'EMP_01,EMP_02,EMP_03' } }, res);
    const returnedIds = res.body.map(e => e.id);
    expect(returnedIds).toContain('EMP_01');
    expect(returnedIds).toContain('EMP_03');
    expect(returnedIds).not.toContain('EMP_02');  // 跨部門 filter 掉
  });

  it('全員 (一般員工) 給空 ids list → []、不查 DB', async () => {
    mockCaller = { id:'EMP_01', role:'employee' };
    const { default: handler } = await import('../api/employees/index.js');
    const res = makeRes();
    await handler({ method:'GET', query:{ _resource:'by_ids', ids:'' } }, res);
    expect(res.body).toEqual([]);
  });

  it('POST → 405', async () => {
    mockCaller = { id:'EMP_HR', role:'hr' };
    const { default: handler } = await import('../api/employees/index.js');
    const res = makeRes();
    await handler({ method:'POST', query:{ _resource:'by_ids', ids:'EMP_01' } }, res);
    expect(res.statusCode).toBe(405);
  });
});
