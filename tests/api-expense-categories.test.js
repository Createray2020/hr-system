// tests/api-expense-categories.test.js
// 對 api/expense-categories/{index,[id]}.js 的覆蓋:
//   C1 GET list 預設只含 is_active=true;include_inactive=true 時含停用、回 { categories }
//   C2 POST 成功 201、id 以 'EC' 開頭;未給 name 回 400
//   C3 POST 撞 UNIQUE(name) → 409
//   C4 PUT 只更新白名單欄(嘗試塞 id/created_by 應被忽略)
//   C5 DELETE 被引用回 409;未被引用回 { deleted:true }
//
// Mock 策略(對齊 tests/api-overtime-admin-edit.test.js):
//   - supabase: thin chain mock(只給 import 跑過、實際 query 不走、被 _repo mock 攔)
//   - auth.requireAuth / requireRole: 真實 role-list semantics
//   - _repo.js makeExpenseCategoryRepo: stateful stub

import { describe, it, expect, vi, beforeEach } from 'vitest';

const repoState = {
  rows: [],          // expense_categories 表
  inserted: [],
  updates: [],
  deletes: [],
  inUseCount: 0,
  insertError: null,
  updateError: null,
};

const overrides = { caller: null };

vi.mock('../lib/supabase.js', () => {
  const c = {
    select: vi.fn(() => c), eq: vi.fn(() => c),
    update: vi.fn(() => c), insert: vi.fn(() => c),
    delete: vi.fn(() => c),
    maybeSingle: vi.fn(() => Promise.resolve({ data: null, error: null })),
    single: vi.fn(() => Promise.resolve({ data: null, error: null })),
    order: vi.fn(() => c), limit: vi.fn(() => c), or: vi.fn(() => c),
    gte: vi.fn(() => c), lte: vi.fn(() => c), in: vi.fn(() => c), is: vi.fn(() => c),
  };
  const client = { from: vi.fn(() => c) };
  return { supabase: client, supabaseAdmin: client };
});

vi.mock('../lib/auth.js', () => ({
  requireAuth: vi.fn(async (req, res) => {
    if (!overrides.caller) { res.status(401).json({ error: 'Unauthorized' }); return null; }
    return overrides.caller;
  }),
  requireRole: vi.fn(async (req, res, allowedRoles, opts = {}) => {
    if (!overrides.caller) { res.status(401).json({ error: 'Unauthorized' }); return null; }
    const allowManager = opts.allowManager === true;
    const passByRole = allowedRoles.includes(overrides.caller.role);
    const passByManager = allowManager && overrides.caller.is_manager === true;
    if (!passByRole && !passByManager) {
      res.status(403).json({ error: 'Forbidden: insufficient role' });
      return null;
    }
    return overrides.caller;
  }),
}));

const mockMakeRepo = vi.fn(() => ({
  listCategories: vi.fn(async ({ includeInactive } = {}) => {
    return includeInactive
      ? [...repoState.rows]
      : repoState.rows.filter(r => r.is_active);
  }),
  getCategory: vi.fn(async (id) => repoState.rows.find(r => r.id === id) || null),
  nextSortOrder: vi.fn(async () => {
    const m = repoState.rows.reduce((s, r) => Math.max(s, r.sort_order || 0), 0);
    return m + 1;
  }),
  insertCategory: vi.fn(async (row) => {
    if (repoState.insertError) {
      const e = new Error(repoState.insertError.message || 'insert err');
      e.code = repoState.insertError.code;
      throw e;
    }
    repoState.inserted.push(row);
    repoState.rows.push({ ...row });
    return { ...row };
  }),
  updateCategory: vi.fn(async (id, patch) => {
    if (repoState.updateError) {
      const e = new Error(repoState.updateError.message || 'update err');
      e.code = repoState.updateError.code;
      throw e;
    }
    repoState.updates.push({ id, patch });
    const idx = repoState.rows.findIndex(r => r.id === id);
    if (idx >= 0) {
      repoState.rows[idx] = { ...repoState.rows[idx], ...patch };
      return { ...repoState.rows[idx] };
    }
    return null;
  }),
  countEntriesUsing: vi.fn(async (/* id */) => repoState.inUseCount),
  deleteCategory: vi.fn(async (id) => {
    repoState.deletes.push(id);
    repoState.rows = repoState.rows.filter(r => r.id !== id);
  }),
}));
vi.mock('../api/expense-categories/_repo.js', () => ({
  makeExpenseCategoryRepo: mockMakeRepo,
}));

const { default: indexHandler } = await import('../api/expense-categories/index.js');
const { default: idHandler }    = await import('../api/expense-categories/[id].js');

function makeReqRes({ method = 'GET', query = {}, body = {} } = {}) {
  const res = {
    statusCode: 200, body: undefined,
    status(c) { this.statusCode = c; return this; },
    json(p)   { this.body = p; return this; },
    end()     { return this; },
  };
  return [{ method, query, body, headers: {} }, res];
}

const HR  = { id: 'HR1', role: 'hr',       is_manager: false, dept_id: 'D_HR' };
const EMP = { id: 'E1',  role: 'employee', is_manager: false, dept_id: 'D1' };

beforeEach(() => {
  repoState.rows = [];
  repoState.inserted = [];
  repoState.updates = [];
  repoState.deletes = [];
  repoState.inUseCount = 0;
  repoState.insertError = null;
  repoState.updateError = null;
  overrides.caller = HR;
  mockMakeRepo.mockClear();
});

// ════════════════════════════════════════════════════════════
describe('GET /api/expense-categories', () => {
  it('C1: 預設只回 is_active=true 的、回 { categories }', async () => {
    repoState.rows = [
      { id: 'EC1', name: '交通', is_wage: false, is_taxable: true,  is_active: true,  sort_order: 1 },
      { id: 'EC2', name: '舊類別', is_wage: false, is_taxable: true, is_active: false, sort_order: 2 },
      { id: 'EC3', name: '餐費', is_wage: false, is_taxable: true,  is_active: true,  sort_order: 3 },
    ];
    const [req, res] = makeReqRes({ method: 'GET' });
    await indexHandler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('categories');
    expect(res.body.categories).toHaveLength(2);
    expect(res.body.categories.map(c => c.id)).toEqual(['EC1', 'EC3']);
  });

  it('C1b: include_inactive=true 時含停用', async () => {
    repoState.rows = [
      { id: 'EC1', name: '交通', is_active: true,  sort_order: 1 },
      { id: 'EC2', name: '舊類別', is_active: false, sort_order: 2 },
    ];
    const [req, res] = makeReqRes({ method: 'GET', query: { include_inactive: 'true' } });
    await indexHandler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.categories).toHaveLength(2);
  });

  it('C1c: 員工也可看(只 requireAuth、不擋 role)', async () => {
    overrides.caller = EMP;
    repoState.rows = [{ id: 'EC1', name: '交通', is_active: true, sort_order: 1 }];
    const [req, res] = makeReqRes({ method: 'GET' });
    await indexHandler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.categories).toHaveLength(1);
  });

  it('無 auth → 401', async () => {
    overrides.caller = null;
    const [req, res] = makeReqRes({ method: 'GET' });
    await indexHandler(req, res);
    expect(res.statusCode).toBe(401);
  });
});

describe('POST /api/expense-categories', () => {
  it('C2: 成功 201、id 以 EC 開頭、預設值正確、回 { category }', async () => {
    const [req, res] = makeReqRes({ method: 'POST', body: { name: '交通補貼' } });
    await indexHandler(req, res);

    expect(res.statusCode).toBe(201);
    expect(res.body).toHaveProperty('category');
    expect(res.body.category.id).toMatch(/^EC/);
    expect(res.body.category.name).toBe('交通補貼');
    expect(res.body.category.is_wage).toBe(false);     // default
    expect(res.body.category.is_taxable).toBe(true);   // default
    expect(res.body.category.is_active).toBe(true);    // default
    expect(res.body.category.created_by).toBe('HR1');
    expect(repoState.inserted).toHaveLength(1);
  });

  it('C2b: 未給 name → 400 類別名稱必填', async () => {
    const [req, res] = makeReqRes({ method: 'POST', body: {} });
    await indexHandler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('類別名稱必填');
    expect(repoState.inserted).toHaveLength(0);
  });

  it('C2c: name 是空白字串 → 400', async () => {
    const [req, res] = makeReqRes({ method: 'POST', body: { name: '   ' } });
    await indexHandler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('類別名稱必填');
  });

  it('C2d: 員工 POST → 403(requireRole BACKOFFICE)', async () => {
    overrides.caller = EMP;
    const [req, res] = makeReqRes({ method: 'POST', body: { name: '交通' } });
    await indexHandler(req, res);
    expect(res.statusCode).toBe(403);
  });

  it('C2e: 帶 is_wage=true / sort_order → 寫進 row、覆蓋預設', async () => {
    const [req, res] = makeReqRes({
      method: 'POST',
      body: { name: '津貼', is_wage: true, is_taxable: true, sort_order: 5, note: 'taxable allowance' },
    });
    await indexHandler(req, res);

    expect(res.statusCode).toBe(201);
    expect(res.body.category.is_wage).toBe(true);
    expect(res.body.category.is_taxable).toBe(true);
    expect(res.body.category.sort_order).toBe(5);
    expect(res.body.category.note).toBe('taxable allowance');
  });

  it('C3: 撞 UNIQUE(name)→ 409', async () => {
    repoState.insertError = { code: '23505', message: 'duplicate key value' };
    const [req, res] = makeReqRes({ method: 'POST', body: { name: '交通' } });
    await indexHandler(req, res);
    expect(res.statusCode).toBe(409);
    expect(res.body.error).toBe('已有同名類別');
  });

  it('GET / POST 以外 method → 405', async () => {
    const [req, res] = makeReqRes({ method: 'DELETE' });
    await indexHandler(req, res);
    expect(res.statusCode).toBe(405);
  });
});

describe('PUT /api/expense-categories/:id', () => {
  it('C4: 只更新白名單欄、嘗試塞 id/created_by 被忽略', async () => {
    repoState.rows = [
      { id: 'EC1', name: '交通', is_wage: false, is_taxable: true, is_active: true, sort_order: 1, created_by: 'HR1' },
    ];
    const [req, res] = makeReqRes({
      method: 'PUT',
      query: { id: 'EC1' },
      body: {
        name: '交通(改名)',
        is_wage: true,
        is_active: false,
        sort_order: 7,
        note: 'updated',
        // 嘗試塞非白名單欄 — 應被忽略
        id: 'HACKED',
        created_by: 'HACKER',
        created_at: '1970-01-01',
      },
    });
    await idHandler(req, res);

    expect(res.statusCode).toBe(200);
    expect(repoState.updates).toHaveLength(1);
    const patch = repoState.updates[0].patch;
    expect(patch).toHaveProperty('name', '交通(改名)');
    expect(patch).toHaveProperty('is_wage', true);
    expect(patch).toHaveProperty('is_active', false);
    expect(patch).toHaveProperty('sort_order', 7);
    expect(patch).toHaveProperty('note', 'updated');
    expect(patch).toHaveProperty('updated_at');
    expect(patch).not.toHaveProperty('id');
    expect(patch).not.toHaveProperty('created_by');
    expect(patch).not.toHaveProperty('created_at');
  });

  it('C4b: row 不存在 → 404', async () => {
    const [req, res] = makeReqRes({ method: 'PUT', query: { id: 'NOPE' }, body: { name: 'x' } });
    await idHandler(req, res);
    expect(res.statusCode).toBe(404);
  });

  it('C4c: 沒帶任何白名單欄 → 400', async () => {
    repoState.rows = [{ id: 'EC1', name: '交通', is_active: true }];
    const [req, res] = makeReqRes({ method: 'PUT', query: { id: 'EC1' }, body: { random: 'x' } });
    await idHandler(req, res);
    expect(res.statusCode).toBe(400);
  });

  it('C4d: PUT name 空白 → 400', async () => {
    repoState.rows = [{ id: 'EC1', name: '交通', is_active: true }];
    const [req, res] = makeReqRes({ method: 'PUT', query: { id: 'EC1' }, body: { name: '   ' } });
    await idHandler(req, res);
    expect(res.statusCode).toBe(400);
  });

  it('C4e: PUT 撞 UNIQUE → 409', async () => {
    repoState.rows = [{ id: 'EC1', name: '交通', is_active: true }];
    repoState.updateError = { code: '23505', message: 'dup' };
    const [req, res] = makeReqRes({ method: 'PUT', query: { id: 'EC1' }, body: { name: '餐費' } });
    await idHandler(req, res);
    expect(res.statusCode).toBe(409);
    expect(res.body.error).toBe('已有同名類別');
  });

  it('員工 PUT → 403', async () => {
    overrides.caller = EMP;
    repoState.rows = [{ id: 'EC1', name: '交通', is_active: true }];
    const [req, res] = makeReqRes({ method: 'PUT', query: { id: 'EC1' }, body: { name: 'x' } });
    await idHandler(req, res);
    expect(res.statusCode).toBe(403);
  });
});

describe('DELETE /api/expense-categories/:id', () => {
  it('C5: 被引用 → 409、未實際刪', async () => {
    repoState.rows = [{ id: 'EC1', name: '交通', is_active: true }];
    repoState.inUseCount = 3;
    const [req, res] = makeReqRes({ method: 'DELETE', query: { id: 'EC1' } });
    await idHandler(req, res);

    expect(res.statusCode).toBe(409);
    expect(res.body.error).toMatch(/已被請款併薪紀錄引用/);
    expect(res.body.in_use_count).toBe(3);
    expect(repoState.deletes).toHaveLength(0);
  });

  it('C5b: 未被引用 → 200 { deleted: true, id }', async () => {
    repoState.rows = [{ id: 'EC1', name: '交通', is_active: true }];
    repoState.inUseCount = 0;
    const [req, res] = makeReqRes({ method: 'DELETE', query: { id: 'EC1' } });
    await idHandler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ deleted: true, id: 'EC1' });
    expect(repoState.deletes).toEqual(['EC1']);
  });

  it('C5c: row 不存在 → 404、未呼叫 count / delete', async () => {
    const [req, res] = makeReqRes({ method: 'DELETE', query: { id: 'NOPE' } });
    await idHandler(req, res);
    expect(res.statusCode).toBe(404);
    expect(repoState.deletes).toHaveLength(0);
  });

  it('員工 DELETE → 403', async () => {
    overrides.caller = EMP;
    repoState.rows = [{ id: 'EC1', name: '交通', is_active: true }];
    const [req, res] = makeReqRes({ method: 'DELETE', query: { id: 'EC1' } });
    await idHandler(req, res);
    expect(res.statusCode).toBe(403);
  });

  it('PATCH 不接受 → 405', async () => {
    repoState.rows = [{ id: 'EC1', name: '交通', is_active: true }];
    const [req, res] = makeReqRes({ method: 'PATCH', query: { id: 'EC1' }, body: {} });
    await idHandler(req, res);
    expect(res.statusCode).toBe(405);
  });
});
