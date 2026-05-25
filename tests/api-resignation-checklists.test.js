// tests/api-resignation-checklists.test.js — Phase 6 任務 2
//
// 對應實作:api/resignation-checklists.js(Phase 3 新建)
// 涵蓋:
//   * GET ?employee_id=X / ?id=Y(成功 / 404 / 員工不存在 → null)
//   * PATCH ?item_id=Z(status / note / 母 checklist 自動同步 status)
//   * 403 gate(非 HR)
//   * status transition:pending↔done↔n_a / completed→不再 completed → completed_at=null

import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls = { tables: [], updates: [], inserts: [], deletes: [] };
const dataByQuery = {};
const overrides = { caller: null };

vi.mock('../lib/supabase.js', () => {
  function chain(table) {
    const c = {};
    let where = {};
    let opType = 'select';
    c.select = vi.fn(() => c);
    c.eq = vi.fn((col, val) => { where[col] = val; return c; });
    c.neq = vi.fn(() => c);
    c.in = vi.fn(() => c);
    c.gte = vi.fn(() => c); c.lte = vi.fn(() => c);
    c.order = vi.fn(() => c); c.limit = vi.fn(() => c);
    c.update = vi.fn((patch) => {
      opType = 'update';
      calls.updates.push({ table, patch, where: { ...where } });
      // Stateful merge:模擬 update().eq().select().maybeSingle() 回 updated row
      // (handlePatchItem 內 update 後接 .select().maybeSingle() 撈新值)
      if (dataByQuery[`${table}:maybeSingle`]) {
        dataByQuery[`${table}:maybeSingle`] = {
          ...dataByQuery[`${table}:maybeSingle`],
          ...patch,
        };
      }
      return c;
    });
    c.insert = vi.fn((rows) => { opType = 'insert'; calls.inserts.push({ table, rows }); return c; });
    c.delete = vi.fn(() => { opType = 'delete'; calls.deletes.push({ table }); return c; });
    c.single = vi.fn(() => Promise.resolve({
      data: dataByQuery[`${table}:single`] ?? null,
      error: dataByQuery[`${table}:single`] ? null : { code: 'PGRST116' },
    }));
    c.maybeSingle = vi.fn(() => Promise.resolve({
      data: dataByQuery[`${table}:maybeSingle`] ?? null, error: null,
    }));
    c.then = (onF, onR) => Promise.resolve({
      data: dataByQuery[`${table}:then`] ?? [], error: null,
    }).then(onF, onR);
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
}));

const { default: handler } = await import('../api/resignation-checklists.js');

function makeReqRes({ method = 'GET', query = {}, body = {} } = {}) {
  const res = {
    statusCode: 200, body: undefined,
    status(c) { this.statusCode = c; return this; },
    json(p)   { this.body = p; return this; },
    end()     { return this; },
  };
  return [{ method, query, body, headers: {} }, res];
}

beforeEach(() => {
  calls.tables = []; calls.updates = []; calls.inserts = []; calls.deletes = [];
  for (const k of Object.keys(dataByQuery)) delete dataByQuery[k];
  overrides.caller = null;
});

// ─── caller fixtures ─────────────────────────────────────────
const HR = { id: 'HR1', role: 'hr', is_manager: false, dept_id: 'D_HR' };
const E1 = { id: 'E1', role: 'employee', is_manager: false, dept_id: 'D1' };
const CEO = { id: 'C1', role: 'ceo', is_manager: false, dept_id: 'D_EXEC' };

// ─── fixture data ────────────────────────────────────────────
const FIX_CHECKLIST = {
  id: 'RCL001',
  employee_id: 'EMP_01251101',
  approval_request_id: 'APR_R1',
  status: 'in_progress',
  created_at: '2026-05-26T10:00:00+08:00',
  updated_at: '2026-05-26T10:00:00+08:00',
  completed_at: null,
};
const FIX_EMPLOYEE = {
  id: 'EMP_01251101', name: '柯郁含',
  dept_id: 'D1', hire_date: '2024-01-01',
  resigned_at: '2026-05-13T00:00:00+08:00', resigned_reason: '生涯規劃',
  departments: { name: '行政部' },
};

// ════════════════════════════════════════════════════════════
// GET ?employee_id=X
// ════════════════════════════════════════════════════════════
describe('GET /api/resignation-checklists?employee_id=X', () => {
  it('R.1 員工有 checklist → 200 + checklist + items + employee', async () => {
    overrides.caller = HR;
    dataByQuery['resignation_checklists:maybeSingle'] = FIX_CHECKLIST;
    dataByQuery['employees:maybeSingle'] = FIX_EMPLOYEE;
    dataByQuery['resignation_checklist_items:then'] = [
      { id: 'ITM001', item_seq: 1, status: 'pending' },
      { id: 'ITM002', item_seq: 2, status: 'done' },
    ];
    const [req, res] = makeReqRes({ query: { employee_id: 'EMP_01251101' } });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.checklist).toMatchObject({ id: 'RCL001', status: 'in_progress' });
    expect(res.body.items).toHaveLength(2);
    expect(res.body.employee.name).toBe('柯郁含');
    // flatten dept_name
    expect(res.body.employee.dept_name).toBe('行政部');
    expect(res.body.employee.departments).toBeUndefined();
  });

  it('R.2 員工尚未建 checklist → 200 + null checklist + empty items + employee 仍回(UX 友善)', async () => {
    overrides.caller = HR;
    // 不 set resignation_checklists:maybeSingle → null
    dataByQuery['employees:maybeSingle'] = FIX_EMPLOYEE;
    const [req, res] = makeReqRes({ query: { employee_id: 'EMP_01251101' } });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.checklist).toBeNull();
    expect(res.body.items).toEqual([]);
    expect(res.body.employee.name).toBe('柯郁含');
  });
});

// ════════════════════════════════════════════════════════════
// GET ?id=Y
// ════════════════════════════════════════════════════════════
describe('GET /api/resignation-checklists?id=Y', () => {
  it('R.3 id 存在 → 200 + checklist + items + employee', async () => {
    overrides.caller = HR;
    dataByQuery['resignation_checklists:maybeSingle'] = FIX_CHECKLIST;
    dataByQuery['employees:maybeSingle'] = FIX_EMPLOYEE;
    dataByQuery['resignation_checklist_items:then'] = [
      { id: 'ITM001', item_seq: 1, status: 'pending' },
    ];
    const [req, res] = makeReqRes({ query: { id: 'RCL001' } });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.checklist.id).toBe('RCL001');
    expect(res.body.items).toHaveLength(1);
  });

  it('R.4 id 不存在 → 404', async () => {
    overrides.caller = HR;
    // 不 set resignation_checklists:maybeSingle → null
    const [req, res] = makeReqRes({ query: { id: 'RCL_NOPE' } });
    await handler(req, res);
    expect(res.statusCode).toBe(404);
    expect(res.body.error).toMatch(/找不到/);
  });
});

// ════════════════════════════════════════════════════════════
// Gate 403
// ════════════════════════════════════════════════════════════
describe('Gate (非 HR / admin / CEO / chairman)', () => {
  it('R.5 employee 角色 GET → 403', async () => {
    overrides.caller = E1;
    const [req, res] = makeReqRes({ query: { employee_id: 'EMP_01251101' } });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
  });

  it('R.15 employee 角色 PATCH → 403', async () => {
    overrides.caller = E1;
    const [req, res] = makeReqRes({
      method: 'PATCH', query: { item_id: 'ITM001' }, body: { status: 'done' },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
  });

  it('R.5b CEO 角色 GET → 200(CEO 屬 backoffice)', async () => {
    overrides.caller = CEO;
    dataByQuery['resignation_checklists:maybeSingle'] = FIX_CHECKLIST;
    dataByQuery['employees:maybeSingle'] = FIX_EMPLOYEE;
    const [req, res] = makeReqRes({ query: { employee_id: 'EMP_01251101' } });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
  });
});

// ════════════════════════════════════════════════════════════
// PATCH ?item_id=Z status / note
// ════════════════════════════════════════════════════════════
describe('PATCH /api/resignation-checklists?item_id=Z (status)', () => {
  function setupItem(initialStatus = 'pending', allItemsStatus = ['pending', 'pending']) {
    dataByQuery['resignation_checklist_items:maybeSingle'] = {
      id: 'ITM001', checklist_id: 'RCL001', status: initialStatus,
      completed_at: initialStatus !== 'pending' ? '2026-05-26T10:00:00+08:00' : null,
      completed_by: initialStatus !== 'pending' ? 'HR1' : null,
      note: '',
    };
    dataByQuery['resignation_checklist_items:then'] = allItemsStatus.map((s, i) => ({ status: s }));
  }

  it('R.6 pending → done:寫 completed_at + completed_by', async () => {
    overrides.caller = HR;
    setupItem('pending', ['done', 'pending']); // 改後混合 → in_progress
    const [req, res] = makeReqRes({
      method: 'PATCH', query: { item_id: 'ITM001' }, body: { status: 'done' },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    const itemUpd = calls.updates.find(u => u.table === 'resignation_checklist_items');
    expect(itemUpd.patch.status).toBe('done');
    expect(itemUpd.patch.completed_at).toBeTruthy();
    expect(itemUpd.patch.completed_by).toBe('HR1');
  });

  it('R.7 done → pending:清 completed_at + completed_by(取消完成)', async () => {
    overrides.caller = HR;
    setupItem('done', ['pending', 'pending']); // 改後全 pending → draft
    const [req, res] = makeReqRes({
      method: 'PATCH', query: { item_id: 'ITM001' }, body: { status: 'pending' },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    const itemUpd = calls.updates.find(u => u.table === 'resignation_checklist_items');
    expect(itemUpd.patch.status).toBe('pending');
    expect(itemUpd.patch.completed_at).toBeNull();
    expect(itemUpd.patch.completed_by).toBeNull();
  });

  it('R.8 done → n_a:仍寫 completed_at / completed_by(n_a 是「終態」)', async () => {
    overrides.caller = HR;
    setupItem('done', ['done', 'pending']);
    const [req, res] = makeReqRes({
      method: 'PATCH', query: { item_id: 'ITM001' }, body: { status: 'n_a' },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    const itemUpd = calls.updates.find(u => u.table === 'resignation_checklist_items');
    expect(itemUpd.patch.status).toBe('n_a');
    expect(itemUpd.patch.completed_at).toBeTruthy();
    expect(itemUpd.patch.completed_by).toBe('HR1');
  });

  it('R.9 只改 note:母 checklist status 不重算、回 checklist_status=null', async () => {
    overrides.caller = HR;
    setupItem('done', ['done', 'pending']);
    const [req, res] = makeReqRes({
      method: 'PATCH', query: { item_id: 'ITM001' }, body: { note: '已完成、附件 A' },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.checklist_status).toBeNull();
    // 只 update item.note + bump 母 updated_at(2 個 update);沒 update 母 status
    const itemUpd = calls.updates.find(u => u.table === 'resignation_checklist_items');
    expect(itemUpd.patch.note).toBe('已完成、附件 A');
    expect(itemUpd.patch.status).toBeUndefined();
    const clUpd = calls.updates.find(u => u.table === 'resignation_checklists');
    expect(clUpd.patch.status).toBeUndefined();
    expect(clUpd.patch.updated_at).toBeTruthy();
  });

  it('R.10 不合法 status → 400', async () => {
    overrides.caller = HR;
    const [req, res] = makeReqRes({
      method: 'PATCH', query: { item_id: 'ITM001' }, body: { status: 'invalid_status' },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/invalid status/);
  });

  it('R.11 母 checklist 全 done/n_a → status=completed + completed_at=NOW', async () => {
    overrides.caller = HR;
    setupItem('pending', ['done', 'n_a']); // 改後最後一個 pending → done,全 done/n_a
    const [req, res] = makeReqRes({
      method: 'PATCH', query: { item_id: 'ITM001' }, body: { status: 'done' },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.checklist_status).toBe('completed');
    const clUpd = calls.updates.find(u => u.table === 'resignation_checklists');
    expect(clUpd.patch.status).toBe('completed');
    expect(clUpd.patch.completed_at).toBeTruthy();
  });

  it('R.12 母 checklist 全 pending → status=draft', async () => {
    overrides.caller = HR;
    setupItem('done', ['pending', 'pending']); // 唯一 done 改回 pending、全 pending
    const [req, res] = makeReqRes({
      method: 'PATCH', query: { item_id: 'ITM001' }, body: { status: 'pending' },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.checklist_status).toBe('draft');
    const clUpd = calls.updates.find(u => u.table === 'resignation_checklists');
    expect(clUpd.patch.status).toBe('draft');
  });

  it('R.13 母 checklist 混合 → status=in_progress', async () => {
    overrides.caller = HR;
    setupItem('pending', ['done', 'pending']); // 改後混合
    const [req, res] = makeReqRes({
      method: 'PATCH', query: { item_id: 'ITM001' }, body: { status: 'done' },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.checklist_status).toBe('in_progress');
    const clUpd = calls.updates.find(u => u.table === 'resignation_checklists');
    expect(clUpd.patch.status).toBe('in_progress');
  });

  it('R.14 從 completed 退回 → 母 completed_at=null(audit 一致)', async () => {
    overrides.caller = HR;
    // 模擬本來全 done(母 completed)、改一筆回 pending → 應變 in_progress + completed_at=null
    setupItem('done', ['pending', 'done']);
    const [req, res] = makeReqRes({
      method: 'PATCH', query: { item_id: 'ITM001' }, body: { status: 'pending' },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.checklist_status).toBe('in_progress');
    const clUpd = calls.updates.find(u => u.table === 'resignation_checklists');
    expect(clUpd.patch.status).toBe('in_progress');
    expect(clUpd.patch.completed_at).toBeNull();
  });
});
