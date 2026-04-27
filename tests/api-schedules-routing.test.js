// 分流驗證：api/schedules/index.js 同時服務舊路徑（legacy）+ 新路徑（Batch 3+）+ shift_types。
// 本 test 不在 §5.10 規範要求的 4 個 lib test 之列，是 Ray 在 Batch 3 額外要求的
// 「跑舊 URL / 跑 /api/shift-types 確認沒破壞」驗證的程式化版本。
//
// 策略：mock lib/supabase.js + lib/auth.js + lib/push.js，攔截 supabase.from(table)
// 的第一次呼叫，據此判定 handler 走了哪條分支。

import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls = { fromTables: [], inserted: [], action: null };

vi.mock('../lib/supabase.js', () => {
  function chain() {
    const c = {};
    const passthrough = ['select', 'order', 'eq', 'gte', 'lte', 'in', 'is', 'limit'];
    for (const k of passthrough) c[k] = vi.fn(() => c);
    c.insert = vi.fn((row) => { calls.inserted.push({ table: calls._lastTable, row }); return c; });
    c.upsert = vi.fn((row) => { calls.inserted.push({ table: calls._lastTable, row, kind: 'upsert' }); return c; });
    c.update = vi.fn(() => c);
    c.delete = vi.fn(() => c);
    c.maybeSingle = vi.fn(() => Promise.resolve({ data: null, error: null }));
    c.single = vi.fn(() => Promise.resolve({ data: null, error: null }));
    // thenable so `await q` resolves
    c.then = (onF, onR) => Promise.resolve({ data: [], error: null }).then(onF, onR);
    return c;
  }
  // 同一個 client 物件 export 為 supabase 跟 supabaseAdmin
  // 因為 Phase 3 後 handler 一律走 supabaseAdmin、test 仍然攔截 from() 即可
  const client = {
    from: vi.fn((table) => {
      calls.fromTables.push(table);
      calls._lastTable = table;
      return chain();
    }),
    auth: { getUser: vi.fn(async () => ({ data: { user: null }, error: null })) },
  };
  return {
    supabase: client,
    supabaseAdmin: client,
  };
});

vi.mock('../lib/auth.js', () => ({
  requireRoleOrPass: vi.fn(async () => ({ id: 'HR1', role: 'hr', is_manager: false })),
  getAuthUser:       vi.fn(async () => null),
  getEmployee:       vi.fn(async () => null),
  requireAuth:       vi.fn(async () => ({ id: 'HR1' })),
  requireRole:       vi.fn(async () => ({ id: 'HR1', role: 'hr' })),
}));

vi.mock('../lib/push.js', () => ({
  sendPushToEmployees:        vi.fn(async () => ({ sent: 0 })),
  sendPushToRoles:            vi.fn(async () => ({ sent: 0 })),
  createNotification:         vi.fn(async () => undefined),
  createNotifications:        vi.fn(async () => undefined),
  createNotificationsForRoles: vi.fn(async () => undefined),
}));

// import 在 mock 之後
const { default: handler } = await import('../api/schedules/index.js');

function makeReqRes({ method, query = {}, body = null }) {
  const res = {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    end() { return this; },
  };
  return [{ method, query, body, headers: {} }, res];
}

beforeEach(() => {
  calls.fromTables = [];
  calls.inserted = [];
  calls._lastTable = null;
});

describe('分流：_resource=shift_types', () => {
  it('GET ?_resource=shift_types → 第一個 supabase.from 是 "shift_types"', async () => {
    const [req, res] = makeReqRes({ method: 'GET', query: { _resource: 'shift_types' } });
    await handler(req, res);
    expect(calls.fromTables[0]).toBe('shift_types');
    expect(res.statusCode).toBe(200);
  });

  it('POST ?_resource=shift_types {name:"X"} → 用 insert 寫入 shift_types', async () => {
    const [req, res] = makeReqRes({
      method: 'POST', query: { _resource: 'shift_types' }, body: { name: '夜班' },
    });
    await handler(req, res);
    expect(calls.fromTables[0]).toBe('shift_types');
    expect(calls.inserted.length).toBe(1);
    expect(calls.inserted[0].table).toBe('shift_types');
    expect(calls.inserted[0].row[0].name).toBe('夜班');
    expect([200, 201]).toContain(res.statusCode);
  });

  it('POST ?_resource=shift_types 缺 name → 400', async () => {
    const [req, res] = makeReqRes({ method: 'POST', query: { _resource: 'shift_types' }, body: {} });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
  });
});

describe('分流：legacy 舊路徑（employee-app.html / calendar.html 用）', () => {
  it('GET ?dept=X&start=Y&end=Z → 第一個 from 是 "schedules"（不是 employees,代表沒走 auth-first 新分支）', async () => {
    const [req, res] = makeReqRes({
      method: 'GET',
      query: { dept: 'kitchen', start: '2026-05-01', end: '2026-05-31' },
    });
    await handler(req, res);
    expect(calls.fromTables[0]).toBe('schedules');
    // legacy GET 是 single-call(空陣列直接回),沒 fetch employees
    expect(calls.fromTables.length).toBeLessThanOrEqual(1);
    expect(res.statusCode).toBe(200);
  });

  it('GET ?employee_id=E001（無 period_id, 無 year）→ 仍走 legacy', async () => {
    const [req, res] = makeReqRes({ method: 'GET', query: { employee_id: 'E001' } });
    await handler(req, res);
    expect(calls.fromTables[0]).toBe('schedules');
  });

  it('POST {employee_id, work_date, shift_type_id}（無 period_id）→ legacy upsert', async () => {
    const [req, res] = makeReqRes({
      method: 'POST',
      body: { employee_id: 'E001', work_date: '2026-05-01', shift_type_id: 'ST1' },
    });
    await handler(req, res);
    expect(calls.fromTables[0]).toBe('schedules');
    expect(calls.inserted.find(x => x.table === 'schedules' && x.kind === 'upsert')).toBeTruthy();
    expect([200, 201]).toContain(res.statusCode);
  });
});

describe('分流：新路徑（Batch 3+）', () => {
  it('GET ?period_id=P → 走新分支（先 auth call employees,然後 schedules）', async () => {
    const [req, res] = makeReqRes({ method: 'GET', query: { period_id: 'p1' } });
    await handler(req, res);
    // 新分支第一個 supabase 動作是 schedules（auth.js 已被 mock，不 call supabase）
    expect(calls.fromTables[0]).toBe('schedules');
    expect(res.statusCode).toBe(200);
  });

  it('GET ?year=2026&month=5 → 走新分支', async () => {
    const [req, res] = makeReqRes({ method: 'GET', query: { year: '2026', month: '5' } });
    await handler(req, res);
    expect(calls.fromTables[0]).toBe('schedules');
  });

  it('POST {period_id, employee_id, work_date} → 走新分支(先讀 schedule_periods)', async () => {
    const [req, res] = makeReqRes({
      method: 'POST',
      body: {
        period_id: 'p1', employee_id: 'E001', work_date: '2026-05-01',
        start_time: '09:00', end_time: '18:00', segment_no: 1,
      },
    });
    await handler(req, res);
    // 新 POST 第一步先撈 schedule_periods 確認 period 存在
    expect(calls.fromTables[0]).toBe('schedule_periods');
  });
});
