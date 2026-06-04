// tests/api-overtime-requests-proxy-create.test.js
// 對 api/overtime-requests/proxy-create.js 覆蓋:
//   C1 comp_leave 代建:status='approved'、manager_id/ceo_id=caller、
//      convertOvertimeToCompTimeSafe 被呼叫且傳入 created row;estimated_pay=null
//   C2 overtime_pay 代建:estimated_pay = real calculateOvertimePay 同輸入算出的值
//      (不 mock pay-calc、走 real lib 驗證跟「員工正常 POST」同條 path)
//   C3 權限:role='employee' → 403
//   C4 over-limit 不擋:is_over_limit=true 但仍 201 + insert
//   C5 缺欄位 → 400(employee_id / dates / hours / compensation_type / reason)
//   C6 overtime_pay 缺 day_type → 400
//   C7 employee 不存在 → 400
//
// Mock 策略(對齊 tests/api-overtime-admin-edit.test.js):
//   supabase: thin chain mock(只給 import 通過)
//   auth.requireRole: 真實 check role list semantics
//   _repo.js makeOvertimeRepo: stateful stub
//   lib/overtime/limits.js checkOverLimit: mock 回 overrides.limitResult
//   lib/overtime/comp-conversion.js convertOvertimeToCompTimeSafe: mock spy
//   lib/overtime/pay-calc.js: **不 mock**(走真實計算驗 C2)

import { describe, it, expect, vi, beforeEach } from 'vitest';

const repoState = {
  insertedRows: [],
  wageProfile: { employment_type: 'full_time', base_salary: 72000 },
  settings: {
    monthly_work_hours_base: 240,
    weekday_overtime_first_2h_rate: 1.34,
    weekday_overtime_after_2h_rate: 1.67,
    rest_day_overtime_first_2h_rate: 1.34,
    rest_day_overtime_after_2h_rate: 1.67,
    rest_day_overtime_after_8h_rate: 2.67,
  },
  employee: { id: 'E1', dept_id: 'D1', name: 'Emp', manager_id: null },
};

const overrides = {
  caller: null,
  limitResult: {
    is_over_limit: false,
    over_limit_dimensions: [],
    exceeds_hard_cap: false,
    projected: { daily: 0, weekly: 0, monthly: 0, yearly: 0 },
    limits: {},
  },
};

vi.mock('../lib/supabase.js', () => {
  const c = {
    select: vi.fn(() => c), eq: vi.fn(() => c),
    update: vi.fn(() => c), insert: vi.fn(() => c),
    delete: vi.fn(() => c),
    maybeSingle: vi.fn(() => Promise.resolve({ data: null, error: null })),
    single: vi.fn(() => Promise.resolve({ data: null, error: null })),
    order: vi.fn(() => c), limit: vi.fn(() => c), or: vi.fn(() => c),
    gte: vi.fn(() => c), lte: vi.fn(() => c), in: vi.fn(() => c),
  };
  const client = { from: vi.fn(() => c) };
  return { supabase: client, supabaseAdmin: client };
});

vi.mock('../lib/auth.js', () => ({
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

const mockCheckOverLimit = vi.fn(async () => ({ ...overrides.limitResult }));
vi.mock('../lib/overtime/limits.js', () => ({
  checkOverLimit: mockCheckOverLimit,
}));

const mockConvertSafe = vi.fn(async (_repo, otRow) => ({
  ok: true,
  comp_balance: { id: 999, employee_id: otRow.employee_id, earned_hours: otRow.hours },
  warning: null,
}));
vi.mock('../lib/overtime/comp-conversion.js', () => ({
  convertOvertimeToCompTimeSafe: mockConvertSafe,
}));

// ⚠ 不 mock lib/overtime/pay-calc.js — 用真實 lib 驗 C2 estimated_pay 計算

const mockMakeOvertimeRepo = vi.fn(() => ({
  findEmployeeManager:        vi.fn(async () => repoState.employee),
  findEmployeeWageProfile:    vi.fn(async () => repoState.wageProfile),
  getSystemOvertimeSettings:  vi.fn(async () => repoState.settings),
  insertOvertimeRequest: vi.fn(async (row) => {
    const created = { id: 'OT_NEW_' + (repoState.insertedRows.length + 1), ...row };
    repoState.insertedRows.push(created);
    return created;
  }),
  // 給 convertOvertimeToCompTimeSafe 內部用(但已 mock 整個 wrapper、不會走到這)
  insertCompBalance: vi.fn(async () => ({})),
  insertBalanceLog: vi.fn(async () => ({})),
  updateOvertimeCompBalanceId: vi.fn(async () => ({})),
  appendOvertimeAuditNote: vi.fn(async () => ({})),
  // checkOverLimit 內部依賴(已 mock checkOverLimit、不會走到)
  findActiveOvertimeLimits: vi.fn(async () => ({ employee: null, company: null })),
  findOvertimeApprovedHours: vi.fn(async () => ({ daily: 0, weekly: 0, monthly: 0, yearly: 0 })),
}));
vi.mock('../api/overtime-requests/_repo.js', () => ({
  makeOvertimeRepo: mockMakeOvertimeRepo,
}));

const { default: handler } = await import('../api/overtime-requests/proxy-create.js');

function makeReqRes({ method = 'POST', query = {}, body = {} } = {}) {
  const res = {
    statusCode: 200, body: undefined,
    status(c) { this.statusCode = c; return this; },
    json(p)   { this.body = p; return this; },
    end()     { return this; },
  };
  return [{ method, query, body, headers: {} }, res];
}

const HR    = { id: 'HR1', role: 'hr',       is_manager: false, dept_id: 'D_HR' };
const CEO   = { id: 'C1',  role: 'ceo',      is_manager: false, dept_id: 'D_EXEC' };
const ADM   = { id: 'A1',  role: 'admin',    is_manager: false, dept_id: 'D_HR' };
const EMP   = { id: 'E1',  role: 'employee', is_manager: false, dept_id: 'D1' };

beforeEach(() => {
  repoState.insertedRows = [];
  repoState.employee = { id: 'E1', dept_id: 'D1', name: 'Emp', manager_id: null };
  overrides.caller = HR;
  overrides.limitResult = {
    is_over_limit: false,
    over_limit_dimensions: [],
    exceeds_hard_cap: false,
    projected: { daily: 0, weekly: 0, monthly: 0, yearly: 0 },
    limits: {},
  };
  mockMakeOvertimeRepo.mockClear();
  mockCheckOverLimit.mockClear();
  mockConvertSafe.mockClear();
});

function validBody(over = {}) {
  return {
    employee_id: 'E1',
    overtime_date: '2026-05-15',  // 星期五 weekday
    start_at: '2026-05-15T10:00:00+08:00',
    end_at:   '2026-05-15T13:00:00+08:00',
    hours: 3,
    compensation_type: 'comp_leave',
    reason: '系統故障留下修復',
    ...over,
  };
}

// ════════════════════════════════════════════════════════════
describe('POST /api/overtime-requests/proxy-create', () => {
  // ─── C1 comp_leave 代建 ─────────────────────────────────────
  it('C1: comp_leave 代建 → 201、status=approved、manager_id/ceo_id=caller、'
   + 'convertOvertimeToCompTimeSafe 被呼叫且傳入 created row、estimated_pay=null', async () => {
    overrides.caller = HR;
    const [req, res] = makeReqRes({ body: validBody({ compensation_type: 'comp_leave' }) });
    await handler(req, res);

    expect(res.statusCode).toBe(201);
    expect(repoState.insertedRows.length).toBe(1);
    const inserted = repoState.insertedRows[0];
    expect(inserted.status).toBe('approved');
    expect(inserted.compensation_type).toBe('comp_leave');
    expect(inserted.manager_id).toBe('HR1');
    expect(inserted.manager_decision).toBe('approved');
    expect(inserted.ceo_id).toBe('HR1');
    expect(inserted.ceo_decision).toBe('approved');
    expect(inserted.request_kind).toBe('post_approval');
    expect(inserted.hours).toBe(3);
    expect(inserted.employee_id).toBe('E1');
    expect(inserted.applies_to_year).toBe(2026);
    expect(inserted.applies_to_month).toBe(5);
    expect(inserted.admin_audit_note).toMatch(/後台代建 by HR1/);
    expect(inserted.estimated_pay).toBe(null);
    expect(inserted.pay_multiplier).toBe(null);

    // convert spy
    expect(mockConvertSafe).toHaveBeenCalledTimes(1);
    const [convRepo, convArg] = mockConvertSafe.mock.calls[0];
    expect(convArg.compensation_type).toBe('comp_leave');
    expect(convArg.employee_id).toBe('E1');
    expect(convArg.hours).toBe(3);
    expect(convArg.overtime_date).toBe('2026-05-15');
    expect(convArg.id).toMatch(/^OT_NEW_/);

    // response
    expect(res.body.request.id).toMatch(/^OT_NEW_/);
    expect(res.body.comp_balance).toMatchObject({ id: 999, employee_id: 'E1', earned_hours: 3 });
    expect(res.body.warnings).toEqual([]);
  });

  // ─── C2 overtime_pay 代建 estimated_pay = real calc ────────
  it('C2: overtime_pay weekday 3h hourly=300 → estimated_pay=1305 ='
   + ' 2h×300×1.34 + 1h×300×1.67(real calculateOvertimePay、跟員工正常 POST 同算)', async () => {
    overrides.caller = HR;
    // hourly = base_salary 72000 / 240 = 300
    repoState.wageProfile = { employment_type: 'full_time', base_salary: 72000 };
    repoState.settings = {
      monthly_work_hours_base: 240,
      weekday_overtime_first_2h_rate: 1.34,
      weekday_overtime_after_2h_rate: 1.67,
    };

    const [req, res] = makeReqRes({
      body: validBody({
        compensation_type: 'overtime_pay',
        day_type: 'weekday',
        hours: 3,
      }),
    });
    await handler(req, res);

    expect(res.statusCode).toBe(201);
    const inserted = repoState.insertedRows[0];
    // 2*300*1.34 + 1*300*1.67 = 804 + 501 = 1305
    expect(inserted.estimated_pay).toBe(1305);
    expect(inserted.pay_multiplier).toBe(1.34);  // pickFrozenPayMultiplier weekday
    expect(inserted.compensation_type).toBe('overtime_pay');
    expect(inserted.status).toBe('approved');
    expect(inserted.applies_to_year).toBe(2026);
    expect(inserted.applies_to_month).toBe(5);
    // 不觸發 comp 轉換
    expect(mockConvertSafe).not.toHaveBeenCalled();
  });

  it('C2b: overtime_pay rest_day 3h hourly=300 → '
   + '2h×300×1.34 + 1h×300×1.67 = 1305(休息日前 8h 同 first/after 規則)', async () => {
    overrides.caller = HR;
    repoState.wageProfile = { employment_type: 'full_time', base_salary: 72000 };

    const [req, res] = makeReqRes({
      body: validBody({
        compensation_type: 'overtime_pay',
        day_type: 'rest_day',
        hours: 3,
      }),
    });
    await handler(req, res);

    expect(res.statusCode).toBe(201);
    const inserted = repoState.insertedRows[0];
    expect(inserted.estimated_pay).toBe(1305);
    expect(inserted.pay_multiplier).toBe(1.34);
  });

  it('C2c: overtime_pay holiday 4h hourly=300 → 4×300×2.0=2400(holiday 整段 ×2)', async () => {
    overrides.caller = HR;
    repoState.wageProfile = { employment_type: 'full_time', base_salary: 72000 };

    const [req, res] = makeReqRes({
      body: validBody({
        compensation_type: 'overtime_pay',
        day_type: 'holiday',
        hours: 4,
      }),
    });
    await handler(req, res);

    expect(res.statusCode).toBe(201);
    const inserted = repoState.insertedRows[0];
    expect(inserted.estimated_pay).toBe(2400);
    expect(inserted.pay_multiplier).toBe(2.0);
  });

  // ─── C3 權限 ────────────────────────────────────────────────
  it('C3: 一般 employee → 403(BACKOFFICE_ROLES 才能代建)', async () => {
    overrides.caller = EMP;
    const [req, res] = makeReqRes({ body: validBody() });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
    expect(repoState.insertedRows.length).toBe(0);
  });

  it('C3b: CEO 可代建', async () => {
    overrides.caller = CEO;
    const [req, res] = makeReqRes({ body: validBody({ compensation_type: 'comp_leave' }) });
    await handler(req, res);
    expect(res.statusCode).toBe(201);
    expect(repoState.insertedRows[0].manager_id).toBe('C1');
    expect(repoState.insertedRows[0].ceo_id).toBe('C1');
  });

  it('C3c: admin 可代建', async () => {
    overrides.caller = ADM;
    const [req, res] = makeReqRes({ body: validBody({ compensation_type: 'comp_leave' }) });
    await handler(req, res);
    expect(res.statusCode).toBe(201);
  });

  it('C3d: 無 auth → 401', async () => {
    overrides.caller = null;
    const [req, res] = makeReqRes({ body: validBody() });
    await handler(req, res);
    expect(res.statusCode).toBe(401);
  });

  // ─── C4 over-limit 不擋 ─────────────────────────────────────
  it('C4: over-limit 仍建立 + is_over_limit=true + over_limit_dimensions 寫入', async () => {
    overrides.caller = HR;
    overrides.limitResult = {
      is_over_limit: true,
      over_limit_dimensions: ['monthly', 'weekly'],
      exceeds_hard_cap: false,
      projected: { daily: 4, weekly: 30, monthly: 60, yearly: 100 },
      limits: { monthly_hard_cap: 80 },
    };
    // 重新 mock returning overridden value
    mockCheckOverLimit.mockImplementationOnce(async () => ({ ...overrides.limitResult }));

    const [req, res] = makeReqRes({ body: validBody({ compensation_type: 'comp_leave' }) });
    await handler(req, res);

    expect(res.statusCode).toBe(201);
    const inserted = repoState.insertedRows[0];
    expect(inserted.is_over_limit).toBe(true);
    expect(inserted.over_limit_dimensions).toEqual(['monthly', 'weekly']);
    expect(res.body.limitResult.is_over_limit).toBe(true);
  });

  it('C4b: 即使 exceeds_hard_cap 也照建(代建場景 HR 自負)', async () => {
    overrides.caller = HR;
    overrides.limitResult = {
      is_over_limit: true,
      over_limit_dimensions: ['monthly'],
      exceeds_hard_cap: true,
      projected: { daily: 4, weekly: 30, monthly: 99, yearly: 100 },
      limits: { monthly_hard_cap: 46 },
    };
    mockCheckOverLimit.mockImplementationOnce(async () => ({ ...overrides.limitResult }));

    const [req, res] = makeReqRes({ body: validBody({ compensation_type: 'comp_leave' }) });
    await handler(req, res);

    expect(res.statusCode).toBe(201);
    expect(repoState.insertedRows[0].is_over_limit).toBe(true);
  });

  // ─── C5 缺欄位 ──────────────────────────────────────────────
  it('C5a: 缺 employee_id → 400', async () => {
    overrides.caller = HR;
    const body = validBody(); delete body.employee_id;
    const [req, res] = makeReqRes({ body });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/employee_id/);
  });

  it('C5b: 缺 overtime_date → 400', async () => {
    overrides.caller = HR;
    const body = validBody(); delete body.overtime_date;
    const [req, res] = makeReqRes({ body });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
  });

  it('C5c: hours=0 → 400', async () => {
    overrides.caller = HR;
    const [req, res] = makeReqRes({ body: validBody({ hours: 0 }) });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/hours/);
  });

  it('C5d: compensation_type 非法 → 400', async () => {
    overrides.caller = HR;
    const [req, res] = makeReqRes({ body: validBody({ compensation_type: 'undecided' }) });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/compensation_type/);
  });

  it('C5e: reason 空 → 400', async () => {
    overrides.caller = HR;
    const [req, res] = makeReqRes({ body: validBody({ reason: '   ' }) });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/reason/);
  });

  // ─── C6 overtime_pay 缺 day_type ────────────────────────────
  it('C6: compensation_type=overtime_pay 但缺 day_type → 400', async () => {
    overrides.caller = HR;
    const [req, res] = makeReqRes({
      body: validBody({ compensation_type: 'overtime_pay' /* no day_type */ }),
    });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/day_type/);
  });

  it('C6b: day_type 非法 → 400', async () => {
    overrides.caller = HR;
    const [req, res] = makeReqRes({
      body: validBody({ compensation_type: 'overtime_pay', day_type: 'bogus' }),
    });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/day_type/);
  });

  it('C6c: comp_leave 不需要 day_type(忽略)', async () => {
    overrides.caller = HR;
    const [req, res] = makeReqRes({
      body: validBody({ compensation_type: 'comp_leave' /* no day_type */ }),
    });
    await handler(req, res);
    expect(res.statusCode).toBe(201);
  });

  // ─── C7 員工不存在 ─────────────────────────────────────────
  it('C7: employee 不存在 → 400', async () => {
    overrides.caller = HR;
    repoState.employee = null;  // findEmployeeManager returns null
    const [req, res] = makeReqRes({ body: validBody() });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/employee not found/);
    expect(repoState.insertedRows.length).toBe(0);
  });

  // ─── C8 method gating ──────────────────────────────────────
  it('C8: 非 POST → 405', async () => {
    overrides.caller = HR;
    const [req, res] = makeReqRes({ method: 'GET', body: validBody() });
    await handler(req, res);
    expect(res.statusCode).toBe(405);
  });
});
