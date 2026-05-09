// tests/api-salary-periods.test.js — 階段 1.4 payroll_periods endpoint
//
// 涵蓋:
//   - GET list / detail
//   - POST 開新期間 + 驗證 + 重複(23505)
//   - PUT 走狀態機(canExecuteTransition)、跳階 / FORBIDDEN_ROLE / 自動 audit 欄位
//   - DELETE 只能刪 draft
//   - role gate(非 BACKOFFICE → 403)

import { describe, it, expect, vi, beforeEach } from 'vitest';

const responses = {
  list: [],
  detail: null,
  detailError: null,
  insertError: null,
  updateError: null,
  deleteError: null,
};
const calls = {
  tables: [], selects: [], eqs: [], orders: [],
  insertedRows: null, updatedPatch: null, deletedTable: null,
};
const overrides = { caller: null };

vi.mock('../lib/supabase.js', () => {
  function chain(table) {
    const c = {};
    c.select = vi.fn((str) => { calls.selects.push({ table, str }); return c; });
    c.eq = vi.fn((col, val) => { calls.eqs.push({ table, col, val }); return c; });
    c.order = vi.fn((col, opts) => { calls.orders.push({ table, col, opts }); return c; });
    c.maybeSingle = vi.fn(() => Promise.resolve({
      data: responses.detail, error: responses.detailError,
    }));
    c.insert = vi.fn((rows) => {
      calls.insertedRows = rows;
      return Promise.resolve({ error: responses.insertError });
    });
    c.update = vi.fn((patch) => {
      calls.updatedPatch = patch;
      return {
        eq: vi.fn((col, val) => Promise.resolve({ error: responses.updateError })),
      };
    });
    c.delete = vi.fn(() => {
      calls.deletedTable = table;
      return {
        eq: vi.fn((col, val) => Promise.resolve({ error: responses.deleteError })),
      };
    });
    // terminal awaitable for GET list (after .order chain)
    c.then = (onF, onR) => Promise.resolve({
      data: responses.list, error: null,
    }).then(onF, onR);
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
  requireRole: vi.fn(async (req, res, allowedRoles) => {
    if (!overrides.caller) { res.status(401).json({ error: 'Unauthorized' }); return null; }
    if (!allowedRoles.includes(overrides.caller.role)) {
      res.status(403).json({ error: 'Forbidden' });
      return null;
    }
    return overrides.caller;
  }),
}));

vi.mock('../lib/dept-name-mapper.js', () => ({
  addDeptName: vi.fn(),
  addDeptNameNested: vi.fn(),
  addDeptNameSingle: vi.fn(),
}));

const { default: handler } = await import('../api/salary/index.js');

function makeReqRes({ method = 'GET', query = {}, body = null } = {}) {
  const res = {
    statusCode: 200, body: undefined,
    status(c) { this.statusCode = c; return this; },
    json(p)   { this.body = p; return this; },
    end()     { return this; },
  };
  return [{ method, query: { _resource: 'periods', ...query }, body, headers: {} }, res];
}

beforeEach(() => {
  responses.list = []; responses.detail = null;
  responses.detailError = null; responses.insertError = null;
  responses.updateError = null; responses.deleteError = null;
  calls.tables = []; calls.selects = []; calls.eqs = []; calls.orders = [];
  calls.insertedRows = null; calls.updatedPatch = null; calls.deletedTable = null;
  overrides.caller = { id: 'HR1', role: 'hr' }; // default backoffice
});

const HR    = { id: 'HR1', role: 'hr' };
const ADMIN = { id: 'A1',  role: 'admin' };
const CEO   = { id: 'C1',  role: 'ceo' };
const EMP   = { id: 'E1',  role: 'employee' };

// ════════════════════════════════════════════════════════════
// GET
// ════════════════════════════════════════════════════════════
describe('GET /api/salary/periods (list)', () => {
  it('回 array、按 (year DESC, month DESC) 排序', async () => {
    responses.list = [
      { id: 'PP_2026_05', year: 2026, month: 5, status: 'draft' },
      { id: 'PP_2026_04', year: 2026, month: 4, status: 'paid' },
    ];
    const [req, res] = makeReqRes({ method: 'GET' });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(responses.list);
    const orderCols = calls.orders.filter(o => o.table === 'payroll_periods').map(o => o.col);
    expect(orderCols).toContain('year');
    expect(orderCols).toContain('month');
    const yearOrder = calls.orders.find(o => o.col === 'year');
    expect(yearOrder.opts).toEqual({ ascending: false });
  });

  it('帶 ?status=draft → query 加 .eq(status, draft)', async () => {
    responses.list = [];
    const [req, res] = makeReqRes({ method: 'GET', query: { status: 'draft' } });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    const statusEq = calls.eqs.find(e => e.col === 'status');
    expect(statusEq).toEqual({ table: 'payroll_periods', col: 'status', val: 'draft' });
  });
});

describe('GET /api/salary/periods?id=...', () => {
  it('找到 → 回單一 row', async () => {
    responses.detail = { id: 'PP_2026_05', year: 2026, month: 5, status: 'draft' };
    const [req, res] = makeReqRes({ method: 'GET', query: { id: 'PP_2026_05' } });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.id).toBe('PP_2026_05');
  });

  it('不存在 → 404', async () => {
    responses.detail = null;
    const [req, res] = makeReqRes({ method: 'GET', query: { id: 'PP_9999_99' } });
    await handler(req, res);
    expect(res.statusCode).toBe(404);
  });
});

// ════════════════════════════════════════════════════════════
// POST
// ════════════════════════════════════════════════════════════
describe('POST /api/salary/periods', () => {
  it('缺 year → 400', async () => {
    const [req, res] = makeReqRes({
      method: 'POST',
      body: { month: 5, period_start: '2026-05-01', period_end: '2026-05-31' },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
  });

  it('缺 period_start → 400', async () => {
    const [req, res] = makeReqRes({
      method: 'POST',
      body: { year: 2026, month: 5, period_end: '2026-05-31' },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
  });

  it('month=13 → 400', async () => {
    const [req, res] = makeReqRes({
      method: 'POST',
      body: { year: 2026, month: 13, period_start: '2026-05-01', period_end: '2026-05-31' },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
  });

  it('正常 → 201、id=PP_2026_05、created_by=caller.id', async () => {
    overrides.caller = HR;
    const [req, res] = makeReqRes({
      method: 'POST',
      body: { year: 2026, month: 5, period_start: '2026-05-01', period_end: '2026-05-31',
              attendance_cutoff_date: '2026-05-31', pay_date: '2026-06-10', note: 'May payroll' },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(201);
    expect(res.body.id).toBe('PP_2026_05');
    expect(calls.insertedRows).toBeTruthy();
    const row = calls.insertedRows[0];
    expect(row.id).toBe('PP_2026_05');
    expect(row.year).toBe(2026);
    expect(row.month).toBe(5);
    expect(row.status).toBe('draft');
    expect(row.created_by).toBe('HR1');
    expect(row.note).toBe('May payroll');
  });

  it('重複(23505)→ 409', async () => {
    responses.insertError = { code: '23505', message: 'duplicate key' };
    const [req, res] = makeReqRes({
      method: 'POST',
      body: { year: 2026, month: 5, period_start: '2026-05-01', period_end: '2026-05-31' },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(409);
  });
});

// ════════════════════════════════════════════════════════════
// PUT(狀態機)
// ════════════════════════════════════════════════════════════
describe('PUT /api/salary/periods/:id', () => {
  it('跳階 draft→paid → 403 INVALID_TRANSITION', async () => {
    overrides.caller = HR;
    responses.detail = { status: 'draft' };
    const [req, res] = makeReqRes({
      method: 'PUT', query: { id: 'PP_2026_05' }, body: { status: 'paid' },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
    expect(res.body.reason).toBe('INVALID_TRANSITION');
  });

  it('pending_review→approved 由 ceo → 200、approved_by=caller.id、approved_at 有寫', async () => {
    overrides.caller = CEO;
    responses.detail = { status: 'pending_review' };
    const [req, res] = makeReqRes({
      method: 'PUT', query: { id: 'PP_2026_05' }, body: { status: 'approved' },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(calls.updatedPatch).toBeTruthy();
    expect(calls.updatedPatch.status).toBe('approved');
    expect(calls.updatedPatch.approved_by).toBe('C1');
    expect(calls.updatedPatch.approved_at).toBeTruthy();
  });

  it('pending_review→approved 由 hr → 403 FORBIDDEN_ROLE', async () => {
    overrides.caller = HR;
    responses.detail = { status: 'pending_review' };
    const [req, res] = makeReqRes({
      method: 'PUT', query: { id: 'PP_2026_05' }, body: { status: 'approved' },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
    expect(res.body.reason).toBe('FORBIDDEN_ROLE');
  });

  it('paid→locked 由 admin → 200、locked_at 有寫', async () => {
    overrides.caller = ADMIN;
    responses.detail = { status: 'paid' };
    const [req, res] = makeReqRes({
      method: 'PUT', query: { id: 'PP_2026_05' }, body: { status: 'locked' },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(calls.updatedPatch.status).toBe('locked');
    expect(calls.updatedPatch.locked_at).toBeTruthy();
  });
});

// ════════════════════════════════════════════════════════════
// DELETE
// ════════════════════════════════════════════════════════════
describe('DELETE /api/salary/periods/:id', () => {
  it('status=draft → 200', async () => {
    responses.detail = { status: 'draft' };
    const [req, res] = makeReqRes({ method: 'DELETE', query: { id: 'PP_2026_05' } });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(calls.deletedTable).toBe('payroll_periods');
  });

  it('status=approved → 409', async () => {
    responses.detail = { status: 'approved' };
    const [req, res] = makeReqRes({ method: 'DELETE', query: { id: 'PP_2026_05' } });
    await handler(req, res);
    expect(res.statusCode).toBe(409);
    expect(calls.deletedTable).toBe(null);
  });
});

// ════════════════════════════════════════════════════════════
// role gate
// ════════════════════════════════════════════════════════════
describe('role gate', () => {
  it('caller=employee → 403', async () => {
    overrides.caller = EMP;
    const [req, res] = makeReqRes({ method: 'GET' });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
  });
});
