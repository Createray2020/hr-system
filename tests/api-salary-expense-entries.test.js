// tests/api-salary-expense-entries.test.js
// Phase 6b:salary-expense-entries CRUD endpoint 測試。
// 只驗 endpoint 的 route/snapshot/rollback/HTTP code,不重測 reflect 內部
// (reflect 邏輯在 tests/salary-expense-cascade.test.js)。

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── repo + reflect mocks ─────────────────────────────────────
const repoState = {
  entries: [],          // by id → row
  categories: {},       // by id → row
  insertedEntries: [],  // 順序 audit
  updates: [],          // 順序 audit({ id, patch })
  hardDeletes: [],      // 順序 audit
};

const overrides = {
  caller: null,
  reflectResult: { ok: true, action: 'recomputed' },
  reflectThrow: null,   // Error instance
};

const mockReflect = vi.fn(async (args) => {
  if (overrides.reflectThrow) throw overrides.reflectThrow;
  return overrides.reflectResult;
});

vi.mock('../lib/supabase.js', () => {
  // thin chain mock(repo 被 mock 攔截、實際不走;留著只為 import 通過)
  const c = {
    select: vi.fn(() => c), eq: vi.fn(() => c),
    update: vi.fn(() => c), insert: vi.fn(() => c),
    delete: vi.fn(() => c),
    is: vi.fn(() => c), order: vi.fn(() => c),
    maybeSingle: vi.fn(() => Promise.resolve({ data: null, error: null })),
    single: vi.fn(() => Promise.resolve({ data: null, error: null })),
  };
  const client = { from: vi.fn(() => c) };
  return { supabase: client, supabaseAdmin: client };
});

vi.mock('../lib/auth.js', () => ({
  requireRole: vi.fn(async (req, res, allowedRoles) => {
    if (!overrides.caller) { res.status(401).json({ error: 'Unauthorized' }); return null; }
    if (!allowedRoles.includes(overrides.caller.role)) {
      res.status(403).json({ error: 'Forbidden: insufficient role' });
      return null;
    }
    return overrides.caller;
  }),
}));

vi.mock('../lib/salary/expense-cascade.js', () => ({
  reflectExpenseEntriesToSalary: mockReflect,
}));

const mockMakeRepo = vi.fn(() => ({
  nowIso() { return new Date().toISOString(); },
  list: vi.fn(async ({ employee_id, year, month }) => {
    return Object.values(repoState.entries).filter(e =>
      e.employee_id === employee_id &&
      e.target_year === year && e.target_month === month &&
      e.deleted_at == null,
    );
  }),
  getById: vi.fn(async (id) => {
    const e = repoState.entries[id];
    return (e && e.deleted_at == null) ? e : null;
  }),
  getCategoryById: vi.fn(async (id) => repoState.categories[id] || null),
  insert: vi.fn(async (row) => {
    repoState.entries[row.id] = { ...row };
    repoState.insertedEntries.push(row);
    return { ...row };
  }),
  update: vi.fn(async (id, patch) => {
    repoState.updates.push({ id, patch });
    if (repoState.entries[id]) {
      Object.assign(repoState.entries[id], patch);
      return { ...repoState.entries[id] };
    }
    return null;
  }),
  hardDelete: vi.fn(async (id) => {
    repoState.hardDeletes.push(id);
    delete repoState.entries[id];
  }),
}));
vi.mock('../api/salary-expense-entries/_repo.js', () => ({
  makeSalaryExpenseEntryRepo: mockMakeRepo,
}));

const { default: indexHandler } = await import('../api/salary-expense-entries/index.js');
const { default: idHandler }    = await import('../api/salary-expense-entries/[id].js');

function makeReqRes({ method = 'GET', query = {}, body = {} } = {}) {
  const res = {
    statusCode: 200, body: undefined,
    status(c) { this.statusCode = c; return this; },
    json(p)   { this.body = p; return this; },
    end()     { return this; },
  };
  return [{ method, query, body, headers: {} }, res];
}

const HR  = { id: 'HR1', role: 'hr',       is_manager: false };
const CEO = { id: 'CEO1', role: 'ceo',     is_manager: false };
const EMP = { id: 'E1',  role: 'employee', is_manager: false };

beforeEach(() => {
  repoState.entries = {};
  repoState.categories = {};
  repoState.insertedEntries = [];
  repoState.updates = [];
  repoState.hardDeletes = [];
  overrides.caller = HR;
  overrides.reflectResult = { ok: true, action: 'recomputed' };
  overrides.reflectThrow = null;
  mockReflect.mockClear();
  mockMakeRepo.mockClear();
});

function seedCategory(id, over = {}) {
  repoState.categories[id] = {
    id, name: '交通', is_wage: false, is_taxable: true, is_active: true, ...over,
  };
}

function seedEntry(over = {}) {
  const id = over.id || `SEE_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
  const row = {
    id, employee_id: 'E_X', target_year: 2026, target_month: 7,
    category_id: 'EC1', category_name_snapshot: '交通',
    is_wage_snapshot: false, is_taxable_snapshot: true,
    amount: 500, expense_date: null, description: null,
    settlement_mode: 'defer', deferred_from: null,
    status: 'active', note: null,
    approval_request_id: null, salary_record_id: null,
    created_by: 'HR1', created_at: '2026-07-01T00:00:00Z',
    deleted_at: null,
    ...over,
  };
  repoState.entries[id] = row;
  return row;
}

// ════════════════════════════════════════════════════════════
describe('GET /api/salary-expense-entries', () => {
  it('缺 query → 400', async () => {
    const [req, res] = makeReqRes({ method: 'GET', query: {} });
    await indexHandler(req, res);
    expect(res.statusCode).toBe(400);
  });

  it('backoffice 取回 list', async () => {
    seedEntry({ id: 'SEE_1', employee_id: 'E_X', target_year: 2026, target_month: 7, amount: 500 });
    seedEntry({ id: 'SEE_2', employee_id: 'E_X', target_year: 2026, target_month: 7, amount: 300 });
    seedEntry({ id: 'SEE_3', employee_id: 'E_Y', target_year: 2026, target_month: 7, amount: 999 });
    const [req, res] = makeReqRes({ method: 'GET', query: { employee_id: 'E_X', year: '2026', month: '7' } });
    await indexHandler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.entries).toHaveLength(2);
    expect(res.body.entries.map(e => e.id).sort()).toEqual(['SEE_1', 'SEE_2']);
  });

  it('非 backoffice → 403', async () => {
    overrides.caller = EMP;
    const [req, res] = makeReqRes({ method: 'GET', query: { employee_id: 'E_X', year: '2026', month: '7' } });
    await indexHandler(req, res);
    expect(res.statusCode).toBe(403);
  });

  it('無 auth → 401', async () => {
    overrides.caller = null;
    const [req, res] = makeReqRes({ method: 'GET', query: { employee_id: 'E_X', year: '2026', month: '7' } });
    await indexHandler(req, res);
    expect(res.statusCode).toBe(401);
  });
});

// ════════════════════════════════════════════════════════════
describe('POST /api/salary-expense-entries', () => {
  beforeEach(() => seedCategory('EC1', { name: '交通', is_wage: false, is_taxable: true, is_active: true }));

  function validBody(over = {}) {
    return {
      employee_id: 'E_X',
      target_year: 2026, target_month: 7,
      category_id: 'EC1',
      amount: 1500,
      ...over,
    };
  }

  it('POST 成功(reflect=recomputed)→ 201、entryRow snapshot 正確', async () => {
    const [req, res] = makeReqRes({ method: 'POST', body: validBody() });
    await indexHandler(req, res);

    expect(res.statusCode).toBe(201);
    expect(res.body).toHaveProperty('entry');
    expect(res.body.reflect).toBe('recomputed');

    const e = res.body.entry;
    expect(e.id).toMatch(/^SEE_/);
    expect(e.approval_request_id).toBe(null);       // 手動非走簽核
    expect(e.salary_record_id).toBe(null);
    expect(e.settlement_mode).toBe('defer');
    expect(e.deferred_from).toBe(null);
    expect(e.status).toBe('active');
    expect(e.employee_id).toBe('E_X');
    expect(e.target_year).toBe(2026);
    expect(e.target_month).toBe(7);
    expect(e.amount).toBe(1500);
    // snapshot 從 getCategoryById 來
    expect(e.category_id).toBe('EC1');
    expect(e.category_name_snapshot).toBe('交通');
    expect(e.is_wage_snapshot).toBe(false);
    expect(e.is_taxable_snapshot).toBe(true);
    expect(e.created_by).toBe('HR1');
    expect(e.note).toMatch(/手動新增/);

    expect(repoState.insertedEntries).toHaveLength(1);
    expect(repoState.hardDeletes).toHaveLength(0);
    expect(mockReflect).toHaveBeenCalledTimes(1);
    expect(mockReflect.mock.calls[0][0]).toMatchObject({
      employee_id: 'E_X', year: 2026, month: 7, force: false,
      callerId: 'HR1', callerRole: 'hr',
    });
    expect(mockReflect.mock.calls[0][0].auditLabel).toMatch(/手動新增/);
  });

  it('reflect=entry_only(未結算無 record)→ 201、entry 保留(不回滾)', async () => {
    overrides.reflectResult = { ok: true, action: 'entry_only' };
    const [req, res] = makeReqRes({ method: 'POST', body: validBody() });
    await indexHandler(req, res);
    expect(res.statusCode).toBe(201);
    expect(res.body.reflect).toBe('entry_only');
    expect(repoState.hardDeletes).toHaveLength(0);
  });

  it('reflect=surgical(approved+force+exec)→ 201;force 旗標傳給 reflect', async () => {
    overrides.caller = CEO;
    overrides.reflectResult = { ok: true, action: 'surgical' };
    const [req, res] = makeReqRes({ method: 'POST', body: validBody({ force: true }) });
    await indexHandler(req, res);
    expect(res.statusCode).toBe(201);
    expect(mockReflect.mock.calls[0][0].force).toBe(true);
    expect(repoState.hardDeletes).toHaveLength(0);
  });

  it('類別不存在 → 400、未 insert、未 reflect', async () => {
    const [req, res] = makeReqRes({ method: 'POST', body: validBody({ category_id: 'NOPE' }) });
    await indexHandler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/類別不存在/);
    expect(repoState.insertedEntries).toHaveLength(0);
    expect(mockReflect).not.toHaveBeenCalled();
  });

  it('類別已停用 → 400、未 insert', async () => {
    seedCategory('EC_INACTIVE', { is_active: false });
    const [req, res] = makeReqRes({ method: 'POST', body: validBody({ category_id: 'EC_INACTIVE' }) });
    await indexHandler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/已停用/);
  });

  it('reflect=NEEDS_FORCE → 硬刪 entry + 409', async () => {
    overrides.reflectResult = { ok: false, reason: 'NEEDS_FORCE' };
    const [req, res] = makeReqRes({ method: 'POST', body: validBody() });
    await indexHandler(req, res);
    expect(res.statusCode).toBe(409);
    expect(res.body.reason).toBe('NEEDS_FORCE');
    expect(repoState.insertedEntries).toHaveLength(1);
    expect(repoState.hardDeletes).toHaveLength(1);
    expect(repoState.hardDeletes[0]).toBe(repoState.insertedEntries[0].id);
  });

  it('reflect=NEEDS_EXECUTIVE → 硬刪 + 403', async () => {
    overrides.reflectResult = { ok: false, reason: 'NEEDS_EXECUTIVE' };
    const [req, res] = makeReqRes({ method: 'POST', body: validBody() });
    await indexHandler(req, res);
    expect(res.statusCode).toBe(403);
    expect(res.body.reason).toBe('NEEDS_EXECUTIVE');
    expect(repoState.hardDeletes).toHaveLength(1);
  });

  it('reflect=PERIOD_LOCKED → 硬刪 + 409', async () => {
    overrides.reflectResult = { ok: false, reason: 'PERIOD_LOCKED' };
    const [req, res] = makeReqRes({ method: 'POST', body: validBody() });
    await indexHandler(req, res);
    expect(res.statusCode).toBe(409);
    expect(res.body.reason).toBe('PERIOD_LOCKED');
    expect(repoState.hardDeletes).toHaveLength(1);
  });

  it('reflect=NO_SALARY_RECORD → 硬刪 + 409', async () => {
    overrides.reflectResult = { ok: false, reason: 'NO_SALARY_RECORD' };
    const [req, res] = makeReqRes({ method: 'POST', body: validBody() });
    await indexHandler(req, res);
    expect(res.statusCode).toBe(409);
    expect(res.body.reason).toBe('NO_SALARY_RECORD');
    expect(repoState.hardDeletes).toHaveLength(1);
  });

  it('reflect 拋錯 → 硬刪 + 500', async () => {
    overrides.reflectThrow = new Error('reflect boom');
    const [req, res] = makeReqRes({ method: 'POST', body: validBody() });
    await indexHandler(req, res);
    expect(res.statusCode).toBe(500);
    expect(res.body.error).toMatch(/reflect boom/);
    expect(repoState.hardDeletes).toHaveLength(1);
  });

  it('amount 非正 → 400', async () => {
    const [req, res] = makeReqRes({ method: 'POST', body: validBody({ amount: 0 }) });
    await indexHandler(req, res);
    expect(res.statusCode).toBe(400);
  });

  it('缺 employee_id / target_year / target_month / category_id → 400', async () => {
    for (const drop of ['employee_id', 'target_year', 'target_month', 'category_id']) {
      const body = validBody(); delete body[drop];
      const [req, res] = makeReqRes({ method: 'POST', body });
      await indexHandler(req, res);
      expect(res.statusCode).toBe(400);
    }
  });

  it('非 backoffice → 403', async () => {
    overrides.caller = EMP;
    const [req, res] = makeReqRes({ method: 'POST', body: validBody() });
    await indexHandler(req, res);
    expect(res.statusCode).toBe(403);
  });
});

// ════════════════════════════════════════════════════════════
describe('PATCH /api/salary-expense-entries/:id', () => {
  beforeEach(() => {
    seedCategory('EC1', { name: '交通', is_wage: false, is_taxable: true, is_active: true });
    seedCategory('EC2', { name: '餐費', is_wage: false, is_taxable: false, is_active: true });
  });

  it('PATCH 改 category → 3 snapshot 更新、reflect 被呼叫、200', async () => {
    seedEntry({ id: 'SEE_A', category_id: 'EC1', amount: 500 });

    const [req, res] = makeReqRes({
      method: 'PATCH', query: { id: 'SEE_A' },
      body: { category_id: 'EC2' },
    });
    await idHandler(req, res);

    expect(res.statusCode).toBe(200);
    expect(repoState.updates).toHaveLength(1);    // 只更新成功、無回滾
    const patch = repoState.updates[0].patch;
    expect(patch.category_id).toBe('EC2');
    expect(patch.category_name_snapshot).toBe('餐費');
    expect(patch.is_taxable_snapshot).toBe(false);
    expect(patch.is_wage_snapshot).toBe(false);
    expect(mockReflect).toHaveBeenCalledTimes(1);
    expect(mockReflect.mock.calls[0][0].employee_id).toBe('E_X');
    expect(mockReflect.mock.calls[0][0].year).toBe(2026);
    expect(mockReflect.mock.calls[0][0].month).toBe(7);
  });

  it('PATCH 改 amount → 更新、reflect 被呼叫', async () => {
    seedEntry({ id: 'SEE_B', amount: 500 });
    const [req, res] = makeReqRes({
      method: 'PATCH', query: { id: 'SEE_B' }, body: { amount: 800 },
    });
    await idHandler(req, res);
    expect(res.statusCode).toBe(200);
    expect(repoState.updates[0].patch.amount).toBe(800);
  });

  it('PATCH reflect=NEEDS_FORCE → 還原舊值 + 409', async () => {
    seedEntry({
      id: 'SEE_C', category_id: 'EC1', category_name_snapshot: '交通',
      is_wage_snapshot: false, is_taxable_snapshot: true, amount: 500,
      description: 'before', note: 'before-note',
    });
    overrides.reflectResult = { ok: false, reason: 'NEEDS_FORCE' };

    const [req, res] = makeReqRes({
      method: 'PATCH', query: { id: 'SEE_C' },
      body: { category_id: 'EC2', amount: 999 },
    });
    await idHandler(req, res);

    expect(res.statusCode).toBe(409);
    expect(res.body.reason).toBe('NEEDS_FORCE');
    // 2 次 update:第一次套 patch、第二次還原
    expect(repoState.updates).toHaveLength(2);
    const rollback = repoState.updates[1].patch;
    expect(rollback.category_id).toBe('EC1');
    expect(rollback.category_name_snapshot).toBe('交通');
    expect(rollback.is_taxable_snapshot).toBe(true);
    expect(rollback.amount).toBe(500);
    expect(rollback.note).toBe('before-note');
  });

  it('PATCH reflect 拋錯 → 還原 + 500', async () => {
    seedEntry({ id: 'SEE_D', amount: 500, note: 'pre' });
    overrides.reflectThrow = new Error('reflect boom');
    const [req, res] = makeReqRes({
      method: 'PATCH', query: { id: 'SEE_D' }, body: { amount: 800 },
    });
    await idHandler(req, res);
    expect(res.statusCode).toBe(500);
    expect(repoState.updates).toHaveLength(2);    // patch + rollback
    expect(repoState.updates[1].patch.amount).toBe(500);
  });

  it('已作廢明細 PATCH → 409、不 update / 不 reflect', async () => {
    seedEntry({ id: 'SEE_VOID', status: 'voided' });
    const [req, res] = makeReqRes({
      method: 'PATCH', query: { id: 'SEE_VOID' }, body: { amount: 999 },
    });
    await idHandler(req, res);
    expect(res.statusCode).toBe(409);
    expect(repoState.updates).toHaveLength(0);
    expect(mockReflect).not.toHaveBeenCalled();
  });

  it('PATCH id 不存在 → 404', async () => {
    const [req, res] = makeReqRes({
      method: 'PATCH', query: { id: 'NOPE' }, body: { amount: 999 },
    });
    await idHandler(req, res);
    expect(res.statusCode).toBe(404);
  });

  it('PATCH 改 category 但 category 已停用 → 400、未 update / 未 reflect', async () => {
    seedEntry({ id: 'SEE_E' });
    seedCategory('EC_DIS', { is_active: false });
    const [req, res] = makeReqRes({
      method: 'PATCH', query: { id: 'SEE_E' }, body: { category_id: 'EC_DIS' },
    });
    await idHandler(req, res);
    expect(res.statusCode).toBe(400);
    expect(repoState.updates).toHaveLength(0);
    expect(mockReflect).not.toHaveBeenCalled();
  });

  it('沒帶任何改動欄位 → 400', async () => {
    seedEntry({ id: 'SEE_NOOP' });
    const [req, res] = makeReqRes({ method: 'PATCH', query: { id: 'SEE_NOOP' }, body: {} });
    await idHandler(req, res);
    expect(res.statusCode).toBe(400);
  });

  it('非 backoffice PATCH → 403', async () => {
    overrides.caller = EMP;
    seedEntry({ id: 'SEE_F' });
    const [req, res] = makeReqRes({
      method: 'PATCH', query: { id: 'SEE_F' }, body: { amount: 999 },
    });
    await idHandler(req, res);
    expect(res.statusCode).toBe(403);
  });
});

// ════════════════════════════════════════════════════════════
describe('DELETE /api/salary-expense-entries/:id', () => {
  it('DELETE 作廢 → status=voided、reflect 被呼叫(force from ?force=true)、200', async () => {
    seedEntry({ id: 'SEE_X', note: 'pre' });
    const [req, res] = makeReqRes({
      method: 'DELETE', query: { id: 'SEE_X', force: 'true' },
    });
    await idHandler(req, res);
    expect(res.statusCode).toBe(200);
    expect(repoState.updates).toHaveLength(1);
    const patch = repoState.updates[0].patch;
    expect(patch.status).toBe('voided');
    expect(patch.note).toMatch(/作廢/);
    expect(mockReflect).toHaveBeenCalledTimes(1);
    expect(mockReflect.mock.calls[0][0].force).toBe(true);
  });

  it('DELETE 預設 force=false', async () => {
    seedEntry({ id: 'SEE_Y' });
    const [req, res] = makeReqRes({ method: 'DELETE', query: { id: 'SEE_Y' } });
    await idHandler(req, res);
    expect(res.statusCode).toBe(200);
    expect(mockReflect.mock.calls[0][0].force).toBe(false);
  });

  it('DELETE reflect=PERIOD_LOCKED → 還原 active + 409', async () => {
    seedEntry({ id: 'SEE_Z', note: 'pre-note' });
    overrides.reflectResult = { ok: false, reason: 'PERIOD_LOCKED' };
    const [req, res] = makeReqRes({ method: 'DELETE', query: { id: 'SEE_Z' } });
    await idHandler(req, res);
    expect(res.statusCode).toBe(409);
    expect(res.body.reason).toBe('PERIOD_LOCKED');
    expect(repoState.updates).toHaveLength(2);
    const rollback = repoState.updates[1].patch;
    expect(rollback.status).toBe('active');
    expect(rollback.note).toBe('pre-note');
  });

  it('DELETE reflect 拋錯 → 還原 + 500', async () => {
    seedEntry({ id: 'SEE_Z2' });
    overrides.reflectThrow = new Error('reflect boom');
    const [req, res] = makeReqRes({ method: 'DELETE', query: { id: 'SEE_Z2' } });
    await idHandler(req, res);
    expect(res.statusCode).toBe(500);
    expect(repoState.updates).toHaveLength(2);
    expect(repoState.updates[1].patch.status).toBe('active');
  });

  it('DELETE 已作廢 → 200 idempotent、不呼叫 reflect、不再 update', async () => {
    seedEntry({ id: 'SEE_VV', status: 'voided' });
    const [req, res] = makeReqRes({ method: 'DELETE', query: { id: 'SEE_VV' } });
    await idHandler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.reflect).toBe('noop');
    expect(repoState.updates).toHaveLength(0);
    expect(mockReflect).not.toHaveBeenCalled();
  });

  it('DELETE id 不存在 → 404', async () => {
    const [req, res] = makeReqRes({ method: 'DELETE', query: { id: 'NOPE' } });
    await idHandler(req, res);
    expect(res.statusCode).toBe(404);
  });

  it('非 backoffice DELETE → 403', async () => {
    overrides.caller = EMP;
    seedEntry({ id: 'SEE_W' });
    const [req, res] = makeReqRes({ method: 'DELETE', query: { id: 'SEE_W' } });
    await idHandler(req, res);
    expect(res.statusCode).toBe(403);
  });
});

// ════════════════════════════════════════════════════════════
describe('method fallback', () => {
  it('index 不接受的 method → 405', async () => {
    const [req, res] = makeReqRes({ method: 'DELETE' });
    await indexHandler(req, res);
    expect(res.statusCode).toBe(405);
  });

  it('[id] 不接受的 method → 405', async () => {
    seedEntry({ id: 'SEE_M' });
    const [req, res] = makeReqRes({ method: 'POST', query: { id: 'SEE_M' }, body: {} });
    await idHandler(req, res);
    expect(res.statusCode).toBe(405);
  });
});
