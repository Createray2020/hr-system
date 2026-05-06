// tests/api-attendance-handle-new-punch-geo.test.js
// GPS Phase A:handleNewPunch body.geo 三態 validation + makeRepo.findActiveOfficeLocations

import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls = { tables: [], inserts: [], updates: [], eqs: [] };
const dataByTable = {};

vi.mock('../lib/supabase.js', () => {
  function chain(table) {
    const c = {};
    c.select = vi.fn(() => c);
    c.eq = vi.fn((col, val) => { calls.eqs.push({ table, col, val }); return c; });
    c.in = vi.fn(() => c);
    c.is = vi.fn(() => c);
    c.not = vi.fn(() => c);
    c.gte = vi.fn(() => c); c.lte = vi.fn(() => c);
    c.order = vi.fn(() => c); c.limit = vi.fn(() => c);
    c.update = vi.fn((patch) => { calls.updates.push({ table, patch }); return c; });
    c.insert = vi.fn((rows) => { calls.inserts.push({ table, rows }); return c; });
    c.upsert = vi.fn((rows) => { calls.inserts.push({ table, rows, upsert: true }); return c; });
    c.maybeSingle = vi.fn(() => Promise.resolve({
      data: dataByTable[`${table}:maybeSingle`] ?? null, error: null,
    }));
    c.single = vi.fn(() => Promise.resolve({
      data: dataByTable[`${table}:single`] ?? null,
      error: dataByTable[`${table}:single`] ? null : { code: 'PGRST116' },
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
  requireAuth: vi.fn(async () => ({ id: 'E001', role: 'employee', is_manager: false, dept_id: 'D1' })),
  requireRole: vi.fn(async () => ({ id: 'E001', role: 'employee', is_manager: false, dept_id: 'D1' })),
}));

vi.mock('../lib/dept-name-mapper.js', () => ({
  addDeptName: vi.fn(),
  addDeptNameSingle: vi.fn(),
}));

// spy lib clockIn / clockOut 是否拿到對的 geo
const clockSpy = { clockInArgs: null, clockOutArgs: null };

vi.mock('../lib/attendance/clock.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    clockIn: vi.fn(async (repo, args) => {
      clockSpy.clockInArgs = args;
      return { ok: true, args };
    }),
    clockOut: vi.fn(async (repo, args) => {
      clockSpy.clockOutArgs = args;
      return { ok: true, args };
    }),
  };
});

const { default: handler, makeRepo } = await import('../api/attendance/index.js');

function makeReqRes({ body = {}, query = {} } = {}) {
  const res = {
    statusCode: 200, body: undefined,
    status(c) { this.statusCode = c; return this; },
    json(p)   { this.body = p; return this; },
    end()     { return this; },
  };
  return [{ method: 'POST', body, query, headers: {} }, res];
}

beforeEach(() => {
  calls.tables = []; calls.inserts = []; calls.updates = []; calls.eqs = [];
  for (const k of Object.keys(dataByTable)) delete dataByTable[k];
  clockSpy.clockInArgs = null;
  clockSpy.clockOutArgs = null;
});

// ════════════════════════════════════════════════════════════
// handleNewPunch — body.geo 三態 + validation
// ════════════════════════════════════════════════════════════
describe('handleNewPunch — body.geo passthrough', () => {
  it('A. 沒 geo → lib clockIn 收到 geo=undefined(向後相容)', async () => {
    const [req, res] = makeReqRes({ body: { action: 'clock_in' } });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(clockSpy.clockInArgs).toBeTruthy();
    expect(clockSpy.clockInArgs.geo).toBeUndefined();
  });

  it('B. geo=null → lib clockIn 收到 geo=null', async () => {
    const [req, res] = makeReqRes({ body: { action: 'clock_in', geo: null } });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(clockSpy.clockInArgs.geo).toBeNull();
  });

  it('C. geo={ lat,lng,accuracy } → lib clockIn 收到 normalized object', async () => {
    const [req, res] = makeReqRes({
      body: { action: 'clock_in', geo: { lat: 24.13, lng: 120.68, accuracy: 15 } },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(clockSpy.clockInArgs.geo).toEqual({ lat: 24.13, lng: 120.68, accuracy: 15 });
  });

  it('clock_out 也走相同 path:geo passthrough', async () => {
    const [req, res] = makeReqRes({
      body: { action: 'clock_out', geo: { lat: 25, lng: 121, accuracy: 20 } },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(clockSpy.clockOutArgs.geo).toEqual({ lat: 25, lng: 121, accuracy: 20 });
  });
});

// ════════════════════════════════════════════════════════════
// handleNewPunch — INVALID_GEO 400
// ════════════════════════════════════════════════════════════
describe('handleNewPunch — INVALID_GEO', () => {
  it('D. geo=string → 400 INVALID_GEO', async () => {
    const [req, res] = makeReqRes({
      body: { action: 'clock_in', geo: 'invalid string' },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body?.error).toBe('INVALID_GEO');
    expect(res.body?.detail).toMatch(/object/);
    // lib 不該被呼叫
    expect(clockSpy.clockInArgs).toBeNull();
  });

  it('E. geo=array → 400 INVALID_GEO', async () => {
    const [req, res] = makeReqRes({ body: { action: 'clock_in', geo: [1, 2] } });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body?.error).toBe('INVALID_GEO');
  });

  it('F. geo.lat=100(超 [-90,90])→ 400 INVALID_GEO', async () => {
    const [req, res] = makeReqRes({
      body: { action: 'clock_in', geo: { lat: 100, lng: 121, accuracy: 15 } },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body?.detail).toMatch(/lat/);
  });

  it('G. geo.lng=200(超 [-180,180])→ 400 INVALID_GEO', async () => {
    const [req, res] = makeReqRes({
      body: { action: 'clock_in', geo: { lat: 24, lng: 200, accuracy: 15 } },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body?.detail).toMatch(/lng/);
  });

  it('H. geo.accuracy=-5(負)→ 400 INVALID_GEO', async () => {
    const [req, res] = makeReqRes({
      body: { action: 'clock_in', geo: { lat: 24, lng: 121, accuracy: -5 } },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body?.detail).toMatch(/accuracy/);
  });

  it('geo=number → 400(物件 / null 才接受)', async () => {
    const [req, res] = makeReqRes({ body: { action: 'clock_in', geo: 42 } });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
  });

  it('geo=true → 400', async () => {
    const [req, res] = makeReqRes({ body: { action: 'clock_in', geo: true } });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
  });
});

// ════════════════════════════════════════════════════════════
// handleNewPunch — partial null 接受
// ════════════════════════════════════════════════════════════
describe('handleNewPunch — partial null 接受', () => {
  it('I. geo={ lat:null, lng:null, accuracy:null } → 通過、normalize 給 lib', async () => {
    const [req, res] = makeReqRes({
      body: { action: 'clock_in', geo: { lat: null, lng: null, accuracy: null } },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(clockSpy.clockInArgs.geo).toEqual({ lat: null, lng: null, accuracy: null });
  });

  it('geo 多餘 key 忽略(向前相容)、validation 仍過', async () => {
    const [req, res] = makeReqRes({
      body: {
        action: 'clock_in',
        geo: { lat: 24, lng: 121, accuracy: 15, altitude: 100, heading: 90 },
      },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    // normalized:只回 lat/lng/accuracy、額外 key 不傳給 lib
    expect(clockSpy.clockInArgs.geo).toEqual({ lat: 24, lng: 121, accuracy: 15 });
  });

  it('geo={} → 通過(等同所有欄位 null)', async () => {
    const [req, res] = makeReqRes({ body: { action: 'clock_in', geo: {} } });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(clockSpy.clockInArgs.geo).toEqual({ lat: null, lng: null, accuracy: null });
  });
});

// ════════════════════════════════════════════════════════════
// makeRepo.findActiveOfficeLocations
// ════════════════════════════════════════════════════════════
describe('makeRepo.findActiveOfficeLocations', () => {
  it('J. 撈 office_locations WHERE is_active=true、回 array', async () => {
    dataByTable.office_locations = [
      { id: 'LOC_HQ', lat: 25, lng: 121, radius_m: 150 },
    ];
    const repo = makeRepo();
    const r = await repo.findActiveOfficeLocations();
    expect(r).toEqual([{ id: 'LOC_HQ', lat: 25, lng: 121, radius_m: 150 }]);

    // 守:有 .eq('is_active', true) call
    const eqActive = calls.eqs.find(e => e.table === 'office_locations' && e.col === 'is_active');
    expect(eqActive).toBeDefined();
    expect(eqActive.val).toBe(true);
  });

  it('沒 row → 回 []', async () => {
    // dataByTable 不設 → 預設 []
    const repo = makeRepo();
    const r = await repo.findActiveOfficeLocations();
    expect(r).toEqual([]);
  });
});
