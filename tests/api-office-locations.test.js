// tests/api-office-locations.test.js — GPS Phase A office_locations CRUD endpoint
//
// 對齊 tests/api-attendance-routing.test.js mock 風格:
//   mock supabase chain + auth、攔 update / insert call、用 dataByQuery 控制 SELECT 回傳

import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls = { tables: [], inserts: [], updates: [] };
const dataByQuery = {};
const dataByTable = {};
const overrides = { caller: null };

vi.mock('../lib/supabase.js', () => {
  function chain(table) {
    const c = {};
    c.select = vi.fn(() => c);
    c.eq = vi.fn(() => c);
    c.in = vi.fn(() => c);
    c.gte = vi.fn(() => c); c.lte = vi.fn(() => c);
    c.order = vi.fn(() => c); c.limit = vi.fn(() => c);
    c.update = vi.fn((patch) => { calls.updates.push({ table, patch }); return c; });
    c.insert = vi.fn((rows) => { calls.inserts.push({ table, rows }); return c; });
    c.maybeSingle = vi.fn(() => Promise.resolve({
      data: dataByQuery[`${table}:maybeSingle`] ?? null, error: null,
    }));
    c.single = vi.fn(() => Promise.resolve({
      data: dataByQuery[`${table}:single`] ?? null,
      error: dataByQuery[`${table}:single`] ? null : { code: 'PGRST116' },
    }));
    c.then = (onF, onR) => Promise.resolve({
      data: dataByTable[table] ?? [], error: null,
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
  requireRole: vi.fn(async (req, res, allowedRoles) => {
    if (!overrides.caller) { res.status(401).json({ error: 'Unauthorized' }); return null; }
    if (!allowedRoles.includes(overrides.caller.role)) {
      res.status(403).json({ error: 'Forbidden' });
      return null;
    }
    return overrides.caller;
  }),
}));

const { default: indexHandler } = await import('../api/office-locations/index.js');
const { default: idHandler } = await import('../api/office-locations/[id].js');

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
  calls.tables = []; calls.inserts = []; calls.updates = [];
  for (const k of Object.keys(dataByQuery)) delete dataByQuery[k];
  for (const k of Object.keys(dataByTable)) delete dataByTable[k];
  overrides.caller = null;
});

const HR  = { id: 'HR1', role: 'hr', is_manager: false, dept_id: 'D_HR' };
const EMP = { id: 'E1',  role: 'employee', is_manager: false, dept_id: 'D1' };

const HQ_ACTIVE   = { id: 'LOC_HQ', name: '總公司', lat: 25.0339, lng: 121.5645,
                      radius_m: 150, is_active: true, note: null,
                      created_at: '2026-05-07T00:00:00Z', updated_at: '2026-05-07T00:00:00Z' };
const HQ_INACTIVE = { ...HQ_ACTIVE, id: 'LOC_OLD', name: '舊辦公室', is_active: false };

// ════════════════════════════════════════════════════════════
// A. GET list
// ════════════════════════════════════════════════════════════
describe('GET /api/office-locations — list', () => {
  it('未登入 → 401', async () => {
    const [req, res] = makeReqRes();
    await indexHandler(req, res);
    expect(res.statusCode).toBe(401);
  });

  it('員工 → 撈 list,backend 已 .eq(is_active, true) filter', async () => {
    overrides.caller = EMP;
    dataByTable.office_locations = [HQ_ACTIVE];  // mock 假設已 filter
    const [req, res] = makeReqRes();
    await indexHandler(req, res);
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    // 守:有 .eq is_active filter call
    // (mock chain 不細記 eq、間接驗 — 這層只看 200 + array)
  });

  it('HR → 200 + array(包 inactive)', async () => {
    overrides.caller = HR;
    dataByTable.office_locations = [HQ_ACTIVE, HQ_INACTIVE];
    const [req, res] = makeReqRes();
    await indexHandler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveLength(2);
  });
});

// ════════════════════════════════════════════════════════════
// B. POST create
// ════════════════════════════════════════════════════════════
describe('POST /api/office-locations — create', () => {
  const validBody = {
    id: 'LOC_NEW', name: '新據點', lat: 25.0, lng: 121.5,
    radius_m: 200, note: 'office',
  };

  it('員工 → 403', async () => {
    overrides.caller = EMP;
    const [req, res] = makeReqRes({ method: 'POST', body: validBody });
    await indexHandler(req, res);
    expect(res.statusCode).toBe(403);
  });

  it('未登入 → 401', async () => {
    const [req, res] = makeReqRes({ method: 'POST', body: validBody });
    await indexHandler(req, res);
    expect(res.statusCode).toBe(401);
  });

  it('HR + valid → 201 + INSERT 寫入', async () => {
    overrides.caller = HR;
    // dataByQuery['office_locations:maybeSingle'] = null(預設、不重複 id)
    // single (insert returning) → 回新 row
    dataByQuery['office_locations:single'] = { ...validBody, is_active: true };
    const [req, res] = makeReqRes({ method: 'POST', body: validBody });
    await indexHandler(req, res);
    expect(res.statusCode).toBe(201);
    const ins = calls.inserts.find(i => i.table === 'office_locations');
    expect(ins).toBeDefined();
    expect(ins.rows[0].id).toBe('LOC_NEW');
    expect(ins.rows[0].radius_m).toBe(200);
  });

  it('lat=100(超出 [-90,90])→ 400 INVALID_INPUT', async () => {
    overrides.caller = HR;
    const [req, res] = makeReqRes({ method: 'POST',
      body: { ...validBody, lat: 100 },
    });
    await indexHandler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body?.error).toBe('INVALID_INPUT');
    expect(res.body?.detail).toMatch(/lat/);
  });

  it('lng=200(超出 [-180,180])→ 400 INVALID_INPUT', async () => {
    overrides.caller = HR;
    const [req, res] = makeReqRes({ method: 'POST',
      body: { ...validBody, lng: 200 },
    });
    await indexHandler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body?.detail).toMatch(/lng/);
  });

  it('radius_m=10000(超 5000 上限)→ 400 INVALID_INPUT', async () => {
    overrides.caller = HR;
    const [req, res] = makeReqRes({ method: 'POST',
      body: { ...validBody, radius_m: 10000 },
    });
    await indexHandler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body?.detail).toMatch(/radius/);
  });

  it('缺 name → 400', async () => {
    overrides.caller = HR;
    const { name, ...noName } = validBody;
    const [req, res] = makeReqRes({ method: 'POST', body: noName });
    await indexHandler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body?.detail).toMatch(/name/);
  });

  it('id 重複 → 409 DUPLICATE_ID', async () => {
    overrides.caller = HR;
    dataByQuery['office_locations:maybeSingle'] = { id: 'LOC_NEW' };  // 既存
    const [req, res] = makeReqRes({ method: 'POST', body: validBody });
    await indexHandler(req, res);
    expect(res.statusCode).toBe(409);
    expect(res.body?.error).toBe('DUPLICATE_ID');
  });

  it('id 含空白 → 400', async () => {
    overrides.caller = HR;
    const [req, res] = makeReqRes({ method: 'POST',
      body: { ...validBody, id: 'LOC NEW' },
    });
    await indexHandler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body?.detail).toMatch(/id/);
  });
});

// ════════════════════════════════════════════════════════════
// C. GET single
// ════════════════════════════════════════════════════════════
describe('GET /api/office-locations/:id — single', () => {
  it('HR 看 inactive id → 200', async () => {
    overrides.caller = HR;
    dataByQuery['office_locations:maybeSingle'] = HQ_INACTIVE;
    const [req, res] = makeReqRes({ query: { id: 'LOC_OLD' } });
    await idHandler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.is_active).toBe(false);
  });

  it('employee 看 inactive id → 404(backend 加 .eq(is_active, true))', async () => {
    overrides.caller = EMP;
    // 員工撈 inactive、mock maybeSingle 回 null(模擬 backend filter 後找不到)
    dataByQuery['office_locations:maybeSingle'] = null;
    const [req, res] = makeReqRes({ query: { id: 'LOC_OLD' } });
    await idHandler(req, res);
    expect(res.statusCode).toBe(404);
  });

  it('不存在的 id → 404', async () => {
    overrides.caller = HR;
    dataByQuery['office_locations:maybeSingle'] = null;
    const [req, res] = makeReqRes({ query: { id: 'LOC_404' } });
    await idHandler(req, res);
    expect(res.statusCode).toBe(404);
  });

  it('未登入 → 401', async () => {
    const [req, res] = makeReqRes({ query: { id: 'LOC_HQ' } });
    await idHandler(req, res);
    expect(res.statusCode).toBe(401);
  });
});

// ════════════════════════════════════════════════════════════
// D. PUT update
// ════════════════════════════════════════════════════════════
describe('PUT /api/office-locations/:id — update', () => {
  it('員工 → 403', async () => {
    overrides.caller = EMP;
    const [req, res] = makeReqRes({
      method: 'PUT', query: { id: 'LOC_HQ' }, body: { name: 'Renamed' },
    });
    await idHandler(req, res);
    expect(res.statusCode).toBe(403);
  });

  it('HR partial update name → 200 + updated_at 改', async () => {
    overrides.caller = HR;
    dataByQuery['office_locations:maybeSingle'] = { id: 'LOC_HQ' };  // 存在
    dataByQuery['office_locations:single'] = { ...HQ_ACTIVE, name: 'Renamed' };
    const [req, res] = makeReqRes({
      method: 'PUT', query: { id: 'LOC_HQ' }, body: { name: 'Renamed' },
    });
    await idHandler(req, res);
    expect(res.statusCode).toBe(200);
    const upd = calls.updates.find(u => u.table === 'office_locations');
    expect(upd?.patch.name).toBe('Renamed');
    expect(upd?.patch.updated_at).toBeTruthy();
  });

  it('試圖改 id(白名單外)→ 不寫入 id、其他欄位仍 update', async () => {
    overrides.caller = HR;
    dataByQuery['office_locations:maybeSingle'] = { id: 'LOC_HQ' };
    dataByQuery['office_locations:single'] = HQ_ACTIVE;
    const [req, res] = makeReqRes({
      method: 'PUT', query: { id: 'LOC_HQ' },
      body: { id: 'LOC_FAKE', name: 'X' },  // id 應被忽略
    });
    await idHandler(req, res);
    expect(res.statusCode).toBe(200);
    const upd = calls.updates.find(u => u.table === 'office_locations');
    expect(upd?.patch.id).toBeUndefined();      // id 不在 whitelist、忽略
    expect(upd?.patch.name).toBe('X');
  });

  it('lat 超範圍 → 400', async () => {
    overrides.caller = HR;
    const [req, res] = makeReqRes({
      method: 'PUT', query: { id: 'LOC_HQ' }, body: { lat: 200 },
    });
    await idHandler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body?.detail).toMatch(/lat/);
  });

  it('不存在 id → 404', async () => {
    overrides.caller = HR;
    dataByQuery['office_locations:maybeSingle'] = null;  // 不存在
    const [req, res] = makeReqRes({
      method: 'PUT', query: { id: 'LOC_404' }, body: { name: 'X' },
    });
    await idHandler(req, res);
    expect(res.statusCode).toBe(404);
  });

  it('沒給任何 whitelist 欄位 → 400', async () => {
    overrides.caller = HR;
    const [req, res] = makeReqRes({
      method: 'PUT', query: { id: 'LOC_HQ' }, body: { id: 'LOC_FAKE' },
    });
    await idHandler(req, res);
    expect(res.statusCode).toBe(400);
  });
});

// ════════════════════════════════════════════════════════════
// E. DELETE soft
// ════════════════════════════════════════════════════════════
describe('DELETE /api/office-locations/:id — soft delete', () => {
  it('HR → 200 + UPDATE is_active=false(不 DELETE row)', async () => {
    overrides.caller = HR;
    dataByQuery['office_locations:maybeSingle'] = { id: 'LOC_HQ' };  // 存在
    const [req, res] = makeReqRes({
      method: 'DELETE', query: { id: 'LOC_HQ' },
    });
    await idHandler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, deleted_id: 'LOC_HQ' });
    // 守:UPDATE 而不是 DELETE,is_active=false
    const upd = calls.updates.find(u => u.table === 'office_locations');
    expect(upd).toBeDefined();
    expect(upd.patch.is_active).toBe(false);
    expect(upd.patch.updated_at).toBeTruthy();
  });

  it('員工 → 403', async () => {
    overrides.caller = EMP;
    const [req, res] = makeReqRes({
      method: 'DELETE', query: { id: 'LOC_HQ' },
    });
    await idHandler(req, res);
    expect(res.statusCode).toBe(403);
  });

  it('不存在 id → 404', async () => {
    overrides.caller = HR;
    dataByQuery['office_locations:maybeSingle'] = null;
    const [req, res] = makeReqRes({
      method: 'DELETE', query: { id: 'LOC_404' },
    });
    await idHandler(req, res);
    expect(res.statusCode).toBe(404);
  });

  it('未登入 → 401', async () => {
    const [req, res] = makeReqRes({
      method: 'DELETE', query: { id: 'LOC_HQ' },
    });
    await idHandler(req, res);
    expect(res.statusCode).toBe(401);
  });
});
