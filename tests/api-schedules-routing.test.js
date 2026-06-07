// 分流驗證：api/schedules/index.js 同時服務舊路徑（legacy）+ 新路徑（Batch 3+）+ shift_types。
// 本 test 不在 §5.10 規範要求的 4 個 lib test 之列，是 Ray 在 Batch 3 額外要求的
// 「跑舊 URL / 跑 /api/shift-types 確認沒破壞」驗證的程式化版本。
//
// 策略：mock lib/supabase.js + lib/auth.js + lib/push.js，攔截 supabase.from(table)
// 的第一次呼叫，據此判定 handler 走了哪條分支。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const calls = { fromTables: [], inserted: [], action: null };

// Per-test override registry。新 describe block 在 beforeEach 設定後、
// mock 讀這個 object 提供回應。預設 null = 跟 Phase 3 既有 9 個 test 行為一樣
// （maybeSingle 回 null、requireAuth 回 HR1）。
const overrides = {
  caller: null,                    // null → 預設 { id: 'HR1' }
  schedulePeriodsResponse: null,   // null → schedule_periods.maybeSingle 回 { data: null }
  employeesResponse: null,         // null → employees.maybeSingle 回 { data: null }
};

vi.mock('../lib/supabase.js', () => {
  function chain() {
    const c = {};
    const passthrough = ['select', 'order', 'eq', 'gte', 'lte', 'in', 'is', 'limit'];
    for (const k of passthrough) c[k] = vi.fn(() => c);
    c.insert = vi.fn((row) => { calls.inserted.push({ table: calls._lastTable, row }); return c; });
    c.upsert = vi.fn((row) => { calls.inserted.push({ table: calls._lastTable, row, kind: 'upsert' }); return c; });
    c.update = vi.fn(() => c);
    c.delete = vi.fn(() => c);
    c.maybeSingle = vi.fn(() => {
      // 新 describe 可在 beforeEach 注入 schedule_periods 回應
      if (calls._lastTable === 'schedule_periods' && overrides.schedulePeriodsResponse) {
        return Promise.resolve({ data: overrides.schedulePeriodsResponse, error: null });
      }
      // 2026-06-07:主管自編路徑會撈 employees 算 in_same_dept,需可注入
      if (calls._lastTable === 'employees' && overrides.employeesResponse) {
        return Promise.resolve({ data: overrides.employeesResponse, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    });
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
  requireAuth:       vi.fn(async () => overrides.caller || { id: 'HR1' }),
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

describe('分流：_resource=shift_types_item（PATCH/DELETE）', () => {
  it('PATCH ?_resource=shift_types_item&id=ST_X → 第一個 from 是 "shift_types"', async () => {
    const [req, res] = makeReqRes({
      method: 'PATCH',
      query: { _resource: 'shift_types_item', id: 'ST_X' },
      body: { color: '#000' },
    });
    await handler(req, res);
    expect(calls.fromTables[0]).toBe('shift_types');
    // existing maybeSingle 預設 null → handler 回 404、不繼續 update
    expect(res.statusCode).toBe(404);
  });

  it('DELETE ?_resource=shift_types_item&id=ST_X → 第一個 from 是 "shift_types"', async () => {
    const [req, res] = makeReqRes({
      method: 'DELETE',
      query: { _resource: 'shift_types_item', id: 'ST_X' },
    });
    await handler(req, res);
    expect(calls.fromTables[0]).toBe('shift_types');
    expect(res.statusCode).toBe(404);
  });

  it('PATCH 缺 id → 400', async () => {
    const [req, res] = makeReqRes({
      method: 'PATCH',
      query: { _resource: 'shift_types_item' },
      body: { color: '#000' },
    });
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

  it('POST 無 period_id → 400（legacy POST 已移除、防回歸）', async () => {
    const [req, res] = makeReqRes({
      method: 'POST',
      body: { employee_id: 'E001', work_date: '2026-05-01', shift_type_id: 'ST1' },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    // 安全屬性：無 period_id 的 POST 絕不能寫 DB
    expect(calls.inserted.find(x => x.table === 'schedules')).toBeFalsy();
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

// ─── G1:員工自助 shift 只能標「希望休假」(ST003 + __OFF__) ───────────
// 規則:isSelf=true 員工 POST 任何非「ST003+__OFF__/null」shift_type → 403
//      EMPLOYEE_SHIFT_RESTRICTED;主管/HR 代操作(isSelf=false)不受限。
// 員工 wish 認定仍靠 period.status='draft';本規則只擋「員工能送什麼 shift_type」。

describe('員工自助:G1 EMPLOYEE_SHIFT_RESTRICTED (POST 路徑)', () => {
  beforeEach(() => {
    overrides.caller = { id: 'E001', role: 'employee', is_manager: false };
    overrides.schedulePeriodsResponse = {
      id: 'p1',
      employee_id: 'E001',
      status: 'draft',
      period_year: 2099,
      period_month: 1,
      period_start: '2099-01-01',
      period_end: '2099-01-31',
      dept: 'kitchen',
    };
  });

  afterEach(() => {
    overrides.caller = null;
    overrides.schedulePeriodsResponse = null;
  });

  it('員工 POST ST001 (希望早班) → 403 EMPLOYEE_SHIFT_RESTRICTED', async () => {
    const [req, res] = makeReqRes({
      method: 'POST',
      body: {
        period_id: 'p1', employee_id: 'E001', work_date: '2099-01-15',
        shift_type_id: 'ST001', segment_no: 1,
        start_time: '09:00', end_time: '18:00',
      },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toBe('EMPLOYEE_SHIFT_RESTRICTED');
  });

  it('員工 POST ST002 (希望晚班) → 403 EMPLOYEE_SHIFT_RESTRICTED', async () => {
    const [req, res] = makeReqRes({
      method: 'POST',
      body: {
        period_id: 'p1', employee_id: 'E001', work_date: '2099-01-15',
        shift_type_id: 'ST002', segment_no: 1,
        start_time: '14:00', end_time: '22:00',
      },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toBe('EMPLOYEE_SHIFT_RESTRICTED');
  });

  it('員工 POST ST004 (例假) → 403 EMPLOYEE_SHIFT_RESTRICTED', async () => {
    const [req, res] = makeReqRes({
      method: 'POST',
      body: {
        period_id: 'p1', employee_id: 'E001', work_date: '2099-01-15',
        shift_type_id: 'ST004', segment_no: 1,
      },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toBe('EMPLOYEE_SHIFT_RESTRICTED');
  });

  it('員工 POST ST003 缺 __OFF__ note → 403 (光 ST003 不夠、要 note=__OFF__)', async () => {
    const [req, res] = makeReqRes({
      method: 'POST',
      body: {
        period_id: 'p1', employee_id: 'E001', work_date: '2099-01-15',
        shift_type_id: 'ST003', segment_no: 1,
        start_time: '09:00', end_time: '18:00',
      },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toBe('EMPLOYEE_SHIFT_RESTRICTED');
  });

  it('員工 POST ST003 + note=__OFF__ → 201 (休假能標、唯一合法選項)', async () => {
    const [req, res] = makeReqRes({
      method: 'POST',
      body: {
        period_id: 'p1', employee_id: 'E001', work_date: '2099-01-15',
        shift_type_id: 'ST003', segment_no: 1,
        note: '__OFF__',
      },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(201);
  });

  it('員工 POST shift_type_id=null (清除/空 cell) → 201 (留空合法)', async () => {
    const [req, res] = makeReqRes({
      method: 'POST',
      body: {
        period_id: 'p1', employee_id: 'E001', work_date: '2099-01-15',
        shift_type_id: null, segment_no: 1,
      },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(201);
  });
});

// ─── G1:代操作不誤擋 — 主管/HR 排員工早晚班正常通過 ─────────────────
describe('代操作:G1 不誤擋主管/HR 代員工排早晚班 (POST)', () => {
  beforeEach(() => {
    // HR 代員工 E001 排班(caller != employee_id → isSelf=false)
    overrides.caller = { id: 'HR1', role: 'hr', is_manager: false };
    overrides.schedulePeriodsResponse = {
      id: 'p1', employee_id: 'E001', status: 'draft',
      period_year: 2099, period_month: 1,
      period_start: '2099-01-01', period_end: '2099-01-31',
      dept: 'kitchen',
    };
  });

  afterEach(() => {
    overrides.caller = null;
    overrides.schedulePeriodsResponse = null;
  });

  it('HR 代員工 POST ST001 (早班) → 201、G1 不擋', async () => {
    const [req, res] = makeReqRes({
      method: 'POST',
      body: {
        period_id: 'p1', employee_id: 'E001', work_date: '2099-01-15',
        shift_type_id: 'ST001', segment_no: 1,
        start_time: '09:00', end_time: '18:00',
      },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(201);
    expect(res.body?.error).not.toBe('EMPLOYEE_SHIFT_RESTRICTED');
  });

  it('HR 代員工 POST ST002 (晚班) → 201、G1 不擋', async () => {
    const [req, res] = makeReqRes({
      method: 'POST',
      body: {
        period_id: 'p1', employee_id: 'E001', work_date: '2099-01-15',
        shift_type_id: 'ST002', segment_no: 1,
        start_time: '14:00', end_time: '22:00',
      },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(201);
    expect(res.body?.error).not.toBe('EMPLOYEE_SHIFT_RESTRICTED');
  });
});

// ════════════════════════════════════════════════════════════
// 2026-06-07:主管/executive 改自己的班表 — isSelf 分流加身分判斷(POST)
//   M1 主管 POST 自己 published 「未來日」ST001 → 201,走 canManagerEditSchedule
//   M2 主管 POST 自己 published 「今天/過去」ST001 → 403 MANAGER_LATE_DENIED
//   M3 一般員工 POST 自己 published 任何日 ST001 → 仍 403(EMPLOYEE_SHIFT_RESTRICTED 或 NOT_DRAFT,回歸保護)
//   M4 executive(role=ceo)POST 自己 published 任何日 ST001 → 201(HR/exec 不受 late 擋)
// 用真實的 lib/schedule/permissions.js + lib/roles.js,只透過 fixture period.status 與 work_date 控
// ════════════════════════════════════════════════════════════
describe('B 修:主管/executive 改自己的班表(POST)', () => {
  afterEach(() => {
    overrides.caller = null;
    overrides.schedulePeriodsResponse = null;
    overrides.employeesResponse = null;
  });

  it('M1: 主管 POST 自己 published 未來日 ST001 → 201,走 canManagerEditSchedule', async () => {
    overrides.caller = { id: 'EMP_01251001', role: 'employee', is_manager: true, dept_id: 'D1' };
    overrides.schedulePeriodsResponse = {
      id: 'p1', employee_id: 'EMP_01251001', status: 'published',
      period_year: 2099, period_month: 1,
      period_start: '2099-01-01', period_end: '2099-01-31',
    };
    overrides.employeesResponse = { dept_id: 'D1' };  // self → in_same_dept=true
    const [req, res] = makeReqRes({
      method: 'POST',
      body: {
        period_id: 'p1', employee_id: 'EMP_01251001', work_date: '2099-01-15',
        shift_type_id: 'ST001', segment_no: 1,
        start_time: '09:00', end_time: '18:00',
      },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(201);
    expect(res.body?.error).not.toBe('EMPLOYEE_SHIFT_RESTRICTED');
    expect(res.body?.error).not.toBe('NOT_DRAFT');
  });

  it('M2: 主管 POST 自己 published 過去日 ST001 → 403 MANAGER_LATE_DENIED', async () => {
    overrides.caller = { id: 'EMP_01251001', role: 'employee', is_manager: true, dept_id: 'D1' };
    overrides.schedulePeriodsResponse = {
      id: 'p1', employee_id: 'EMP_01251001', status: 'published',
      period_year: 2020, period_month: 1,
      period_start: '2020-01-01', period_end: '2020-01-31',
    };
    overrides.employeesResponse = { dept_id: 'D1' };
    const [req, res] = makeReqRes({
      method: 'POST',
      body: {
        period_id: 'p1', employee_id: 'EMP_01251001', work_date: '2020-01-15',
        shift_type_id: 'ST001', segment_no: 1,
        start_time: '09:00', end_time: '18:00',
      },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toBe('MANAGER_LATE_DENIED');
  });

  it('M3: 一般員工 POST 自己 published ST001 → 仍 403(回歸保護)', async () => {
    overrides.caller = { id: 'E1', role: 'employee', is_manager: false, dept_id: 'D1' };
    overrides.schedulePeriodsResponse = {
      id: 'p1', employee_id: 'E1', status: 'published',
      period_year: 2099, period_month: 1,
      period_start: '2099-01-01', period_end: '2099-01-31',
    };
    const [req, res] = makeReqRes({
      method: 'POST',
      body: {
        period_id: 'p1', employee_id: 'E1', work_date: '2099-01-15',
        shift_type_id: 'ST001', segment_no: 1,
        start_time: '09:00', end_time: '18:00',
      },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
    // published 非 draft → NOT_DRAFT;若改 draft 則 EMPLOYEE_SHIFT_RESTRICTED;兩種都是擋
    expect(['NOT_DRAFT', 'EMPLOYEE_SHIFT_RESTRICTED']).toContain(res.body.error);
  });

  it('M3b: 一般員工 POST 自己 draft ST001 → 仍 403 EMPLOYEE_SHIFT_RESTRICTED', async () => {
    overrides.caller = { id: 'E1', role: 'employee', is_manager: false, dept_id: 'D1' };
    overrides.schedulePeriodsResponse = {
      id: 'p1', employee_id: 'E1', status: 'draft',
      period_year: 2099, period_month: 1,
      period_start: '2099-01-01', period_end: '2099-01-31',
    };
    const [req, res] = makeReqRes({
      method: 'POST',
      body: {
        period_id: 'p1', employee_id: 'E1', work_date: '2099-01-15',
        shift_type_id: 'ST001', segment_no: 1,
        start_time: '09:00', end_time: '18:00',
      },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toBe('EMPLOYEE_SHIFT_RESTRICTED');
  });

  it('M4: executive(role=ceo, is_manager=false)POST 自己 published 任何日 ST001 → 201', async () => {
    overrides.caller = { id: 'CEO1', role: 'ceo', is_manager: false, dept_id: 'D_EXEC' };
    overrides.schedulePeriodsResponse = {
      id: 'p1', employee_id: 'CEO1', status: 'published',
      period_year: 2020, period_month: 1,
      period_start: '2020-01-01', period_end: '2020-01-31',
    };
    // executive 不需要 employees query(isHR=true bypass)
    const [req, res] = makeReqRes({
      method: 'POST',
      body: {
        period_id: 'p1', employee_id: 'CEO1', work_date: '2020-01-15',
        shift_type_id: 'ST001', segment_no: 1,
        start_time: '09:00', end_time: '18:00',
      },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(201);
    expect(res.body?.error).not.toBe('EMPLOYEE_SHIFT_RESTRICTED');
    expect(res.body?.error).not.toBe('MANAGER_LATE_DENIED');
  });
});
