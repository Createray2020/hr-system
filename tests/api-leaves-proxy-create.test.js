// tests/api-leaves-proxy-create.test.js
// 對 api/leaves/proxy-create.js 覆蓋:
//   C1 餘額足夠單筆扣抵:total = 原-hours、leave_balance_logs 1 筆 use、went_negative=false
//   C2 餘額不足允許負:現有 active 全扣到 0 + 新建 over-draw record(earned=0/used=shortfall)
//      + 寫對應 balance_log;went_negative=true、total_remaining 為負
//   C3 多筆 active FIFO 跨筆扣抵(expires_at ASC):earlier 全扣後再扣下一筆
//   C4 caller role='employee' → 403;role='hr'/'ceo'/'admin' → 201
//   C5 缺欄位 → 400(employee_id / start_at / end_at / hours / reason)
//   C6 employee 不存在 → 400
//   C7 hours=0 / 負 / 非數字 → 400
//   C8 method=GET → 405
//
// Mock 策略:
//   supabase: thin chain mock(只給 import 跑過)
//   auth.requireRole: 真實 role-list semantics
//   _repo.js makeLeaveRepo: stateful stub(balances/插入/log/lock)
//   ⚠ 不 mock lib/leave/balance.js — endpoint 自寫 FIFO,不走 deductCompTime

import { describe, it, expect, vi, beforeEach } from 'vitest';

const repoState = {
  employee: { id: 'E1', name: 'Emp', role: 'employee', is_manager: false, dept_id: 'D1' },
  balances: [],     // [{id, earned_hours, used_hours, status, expires_at, earned_at}]
  insertedLeave: null,
  insertedCompBalances: [],   // over-draw 新建的會 push 進來
  balanceLogs: [],            // 寫入 leave_balance_logs 的全部 row
  lockUpdates: [],            // lockAndIncrementCompUsedHours 呼叫紀錄
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

let nextCompId = 100;
const mockMakeLeaveRepo = vi.fn(() => ({
  findEmployeeById: vi.fn(async () => repoState.employee),
  insertLeaveRequest: vi.fn(async (row) => {
    repoState.insertedLeave = { ...row };
    return { ...row };
  }),
  findActiveCompBalances: vi.fn(async (/* employee_id */) => {
    // 已按 expires_at ASC sort(由 fixture 決定)
    return repoState.balances.map(b => ({ ...b }));
  }),
  lockAndIncrementCompUsedHours: vi.fn(async ({ comp_id, delta_hours, allow_negative }) => {
    repoState.lockUpdates.push({ comp_id, delta_hours, allow_negative });
    const b = repoState.balances.find(x => x.id === comp_id);
    if (!b) return { ok: false, reason: 'NOT_FOUND' };
    const newUsed = Number(b.used_hours) + Number(delta_hours);
    if (newUsed > Number(b.earned_hours) + 1e-6) return { ok: false, reason: 'INSUFFICIENT_BALANCE' };
    if (newUsed < -1e-6 && !allow_negative) return { ok: false, reason: 'NEGATIVE_BALANCE' };
    b.used_hours = newUsed;
    if (newUsed >= Number(b.earned_hours) - 1e-6 && Number(delta_hours) > 0) b.status = 'fully_used';
    return { ok: true, record: { ...b } };
  }),
  insertCompBalance: vi.fn(async (row) => {
    const created = { id: nextCompId++, ...row };
    repoState.insertedCompBalances.push(created);
    // 也加入 balances 內,後續 query 才會撈到
    repoState.balances.push({
      ...created,
      remaining_hours: Number(row.earned_hours) - Number(row.used_hours),
    });
    return created;
  }),
  insertBalanceLog: vi.fn(async (row) => {
    const logged = { id: 'LBL_' + (repoState.balanceLogs.length + 1), ...row };
    repoState.balanceLogs.push(logged);
    return logged;
  }),
}));
vi.mock('../api/leaves/_repo.js', () => ({
  makeLeaveRepo: mockMakeLeaveRepo,
}));

const { default: handler } = await import('../api/leaves/proxy-create.js');

function makeReqRes({ method = 'POST', query = {}, body = {} } = {}) {
  const res = {
    statusCode: 200, body: undefined,
    status(c) { this.statusCode = c; return this; },
    json(p)   { this.body = p; return this; },
    end()     { return this; },
  };
  return [{ method, query, body, headers: {} }, res];
}

const HR  = { id: 'HR1', role: 'hr',       is_manager: false, dept_id: 'D_HR' };
const CEO = { id: 'C1',  role: 'ceo',      is_manager: false, dept_id: 'D_EXEC' };
const ADM = { id: 'A1',  role: 'admin',    is_manager: false, dept_id: 'D_HR' };
const EMP = { id: 'E1',  role: 'employee', is_manager: false, dept_id: 'D1' };

beforeEach(() => {
  repoState.employee = { id: 'E1', name: 'Emp', role: 'employee', is_manager: false, dept_id: 'D1' };
  repoState.balances = [];
  repoState.insertedLeave = null;
  repoState.insertedCompBalances = [];
  repoState.balanceLogs = [];
  repoState.lockUpdates = [];
  overrides.caller = HR;
  nextCompId = 100;
  mockMakeLeaveRepo.mockClear();
});

function validBody(over = {}) {
  return {
    employee_id: 'E1',
    start_at: '2026-05-15T01:00:00+00:00',   // = Taipei 09:00
    end_at:   '2026-05-15T05:00:00+00:00',   // = Taipei 13:00
    hours: 4,
    reason: '臨時請補休',
    ...over,
  };
}

// ════════════════════════════════════════════════════════════
describe('POST /api/leaves/proxy-create — comp 補休代扣', () => {

  // ─── C1 餘額足夠單筆扣抵 ────────────────────────────────────
  it('C1: 餘額充足(10h - 4h)→ 單筆扣抵、went_negative=false、log 1 筆', async () => {
    repoState.balances = [
      { id: 52, earned_hours: 10, used_hours: 0, status: 'active',
        expires_at: '2026-10-02', earned_at: '2025-10-02T00:00:00Z' },
    ];
    const [req, res] = makeReqRes({ body: validBody({ hours: 4 }) });
    await handler(req, res);

    expect(res.statusCode).toBe(201);
    // leave_requests INSERT shape
    const lr = repoState.insertedLeave;
    expect(lr.status).toBe('approved');
    expect(lr.leave_type).toBe('comp');
    expect(lr.hours).toBe(4);
    expect(lr.finalized_hours).toBe(4);
    expect(lr.days).toBe(0);
    expect(lr.mgr_decision).toBe('approved');
    expect(lr.ceo_decision).toBe('approved');
    expect(lr.handled_by).toBe('HR1');
    expect(lr.admin_audit_note).toMatch(/後台代建補休 by HR1/);

    // 扣抵
    expect(repoState.lockUpdates.length).toBe(1);
    expect(repoState.lockUpdates[0]).toMatchObject({
      comp_id: 52, delta_hours: 4, allow_negative: false,
    });
    // 沒新建 over-draw
    expect(repoState.insertedCompBalances.length).toBe(0);

    // log 1 筆 use
    expect(repoState.balanceLogs.length).toBe(1);
    expect(repoState.balanceLogs[0]).toMatchObject({
      balance_type: 'comp', change_type: 'use', hours_delta: -4,
      comp_record_id: 52, leave_request_id: lr.id,
    });

    // response
    expect(res.body.comp_after.total_remaining).toBe(6);
    expect(res.body.comp_after.went_negative).toBe(false);
    expect(res.body.over_draw_record_id).toBe(null);
  });

  // ─── C2 餘額不足允許負 ──────────────────────────────────────
  it('C2: 餘額 2h、扣 5h → 現有扣到 0 + over-draw 3h、went_negative=true、log 2 筆', async () => {
    repoState.balances = [
      { id: 52, earned_hours: 2, used_hours: 0, status: 'active',
        expires_at: '2026-10-02', earned_at: '2025-10-02T00:00:00Z' },
    ];
    const [req, res] = makeReqRes({ body: validBody({ hours: 5 }) });
    await handler(req, res);

    expect(res.statusCode).toBe(201);

    // lock 1 筆,扣現有的 2h
    expect(repoState.lockUpdates.length).toBe(1);
    expect(repoState.lockUpdates[0]).toMatchObject({ comp_id: 52, delta_hours: 2 });

    // over-draw record 1 筆
    expect(repoState.insertedCompBalances.length).toBe(1);
    const od = repoState.insertedCompBalances[0];
    expect(od.earned_hours).toBe(0);
    expect(od.used_hours).toBe(3);
    expect(od.status).toBe('active');
    expect(od.source_overtime_request_id).toBe(null);
    expect(od.expires_at).toMatch(/^\d{4}-\d{2}-\d{2}$/);  // YYYY-MM-DD
    expect(od.admin_audit_note).toMatch(/超額.*負餘額 3h/);
    expect(od.employee_id).toBe('E1');

    // balance_logs 2 筆(use -2 + use -3 over-draw)
    expect(repoState.balanceLogs.length).toBe(2);
    expect(repoState.balanceLogs[0]).toMatchObject({
      change_type: 'use', hours_delta: -2, comp_record_id: 52,
    });
    expect(repoState.balanceLogs[1]).toMatchObject({
      change_type: 'use', hours_delta: -3, comp_record_id: od.id,
    });
    expect(repoState.balanceLogs[1].reason).toMatch(/超額.*負餘額/);

    // response
    expect(res.body.comp_after.total_remaining).toBe(-3);
    expect(res.body.comp_after.went_negative).toBe(true);
    expect(res.body.over_draw_record_id).toBe(od.id);
  });

  it('C2b: 餘額 0h、扣 4h → 不動 lock、純 over-draw 4h', async () => {
    repoState.balances = [];  // 完全沒有 active
    const [req, res] = makeReqRes({ body: validBody({ hours: 4 }) });
    await handler(req, res);

    expect(res.statusCode).toBe(201);
    expect(repoState.lockUpdates.length).toBe(0);
    expect(repoState.insertedCompBalances.length).toBe(1);
    expect(repoState.insertedCompBalances[0].used_hours).toBe(4);
    expect(repoState.balanceLogs.length).toBe(1);
    expect(repoState.balanceLogs[0].hours_delta).toBe(-4);
    expect(res.body.comp_after.total_remaining).toBe(-4);
    expect(res.body.comp_after.went_negative).toBe(true);
  });

  // ─── C3 多筆 active FIFO ────────────────────────────────────
  it('C3: 多筆 active(2h+3h+5h)扣 6h → FIFO 跨 3 筆(2/3/1)、log 3 筆', async () => {
    repoState.balances = [
      { id: 50, earned_hours: 2, used_hours: 0, status: 'active',
        expires_at: '2026-08-01', earned_at: '2025-08-01T00:00:00Z' },
      { id: 51, earned_hours: 3, used_hours: 0, status: 'active',
        expires_at: '2026-09-01', earned_at: '2025-09-01T00:00:00Z' },
      { id: 52, earned_hours: 5, used_hours: 0, status: 'active',
        expires_at: '2026-10-01', earned_at: '2025-10-01T00:00:00Z' },
    ];
    const [req, res] = makeReqRes({ body: validBody({ hours: 6 }) });
    await handler(req, res);

    expect(res.statusCode).toBe(201);
    expect(repoState.lockUpdates).toEqual([
      { comp_id: 50, delta_hours: 2, allow_negative: false },
      { comp_id: 51, delta_hours: 3, allow_negative: false },
      { comp_id: 52, delta_hours: 1, allow_negative: false },
    ]);
    expect(repoState.insertedCompBalances.length).toBe(0);  // 還沒到負
    expect(repoState.balanceLogs.length).toBe(3);
    expect(repoState.balanceLogs.map(l => l.hours_delta)).toEqual([-2, -3, -1]);

    // 總額 10 - 6 = 4
    expect(res.body.comp_after.total_remaining).toBe(4);
    expect(res.body.comp_after.went_negative).toBe(false);
  });

  it('C3b: 多筆 FIFO + over-draw 混合(2h+3h)扣 8h → 2/3/over-draw 3h、log 3 筆', async () => {
    repoState.balances = [
      { id: 50, earned_hours: 2, used_hours: 0, status: 'active',
        expires_at: '2026-08-01', earned_at: '2025-08-01T00:00:00Z' },
      { id: 51, earned_hours: 3, used_hours: 0, status: 'active',
        expires_at: '2026-09-01', earned_at: '2025-09-01T00:00:00Z' },
    ];
    const [req, res] = makeReqRes({ body: validBody({ hours: 8 }) });
    await handler(req, res);

    expect(res.statusCode).toBe(201);
    expect(repoState.lockUpdates.length).toBe(2);  // 兩筆既有
    expect(repoState.insertedCompBalances.length).toBe(1);  // 1 筆 over-draw
    expect(repoState.insertedCompBalances[0].used_hours).toBe(3);
    expect(repoState.balanceLogs.length).toBe(3);
    expect(res.body.comp_after.total_remaining).toBe(-3);
    expect(res.body.comp_after.went_negative).toBe(true);
  });

  // ─── C4 權限 ────────────────────────────────────────────────
  it('C4: employee → 403', async () => {
    overrides.caller = EMP;
    const [req, res] = makeReqRes({ body: validBody() });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
    expect(repoState.insertedLeave).toBe(null);
  });

  it('C4b: CEO 可代建', async () => {
    overrides.caller = CEO;
    repoState.balances = [{ id: 52, earned_hours: 10, used_hours: 0, status: 'active',
      expires_at: '2026-10-02', earned_at: '2025-10-02T00:00:00Z' }];
    const [req, res] = makeReqRes({ body: validBody({ hours: 4 }) });
    await handler(req, res);
    expect(res.statusCode).toBe(201);
    expect(repoState.insertedLeave.handled_by).toBe('C1');
    expect(repoState.insertedLeave.ceo_reviewed_by).toBe('C1');
  });

  it('C4c: admin 可代建', async () => {
    overrides.caller = ADM;
    repoState.balances = [{ id: 52, earned_hours: 10, used_hours: 0, status: 'active',
      expires_at: '2026-10-02', earned_at: '2025-10-02T00:00:00Z' }];
    const [req, res] = makeReqRes({ body: validBody({ hours: 4 }) });
    await handler(req, res);
    expect(res.statusCode).toBe(201);
  });

  it('C4d: 無 auth → 401', async () => {
    overrides.caller = null;
    const [req, res] = makeReqRes({ body: validBody() });
    await handler(req, res);
    expect(res.statusCode).toBe(401);
  });

  // ─── C5 缺欄位 ──────────────────────────────────────────────
  it('C5a: 缺 employee_id → 400', async () => {
    const body = validBody(); delete body.employee_id;
    const [req, res] = makeReqRes({ body });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/employee_id/);
  });

  it('C5b: 缺 start_at → 400', async () => {
    const body = validBody(); delete body.start_at;
    const [req, res] = makeReqRes({ body });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
  });

  it('C5c: 缺 end_at → 400', async () => {
    const body = validBody(); delete body.end_at;
    const [req, res] = makeReqRes({ body });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
  });

  it('C5d: reason 空白 → 400', async () => {
    const [req, res] = makeReqRes({ body: validBody({ reason: '   ' }) });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/reason/);
  });

  it('C5e: end_at <= start_at → 400', async () => {
    const [req, res] = makeReqRes({ body: validBody({
      start_at: '2026-05-15T05:00:00+00:00', end_at: '2026-05-15T01:00:00+00:00',
    }) });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/start_at must be before end_at/);
  });

  // ─── C6 employee 不存在 ───────────────────────────────────
  it('C6: employee 不存在 → 400', async () => {
    repoState.employee = null;
    const [req, res] = makeReqRes({ body: validBody() });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/employee not found/);
    expect(repoState.insertedLeave).toBe(null);
  });

  // ─── C7 hours 邊界 ─────────────────────────────────────────
  it('C7a: hours=0 → 400', async () => {
    const [req, res] = makeReqRes({ body: validBody({ hours: 0 }) });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
  });

  it('C7b: hours=-3 → 400', async () => {
    const [req, res] = makeReqRes({ body: validBody({ hours: -3 }) });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
  });

  it('C7c: hours="abc" → 400', async () => {
    const [req, res] = makeReqRes({ body: validBody({ hours: 'abc' }) });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
  });

  // ─── C8 method gating ──────────────────────────────────────
  it('C8: GET → 405', async () => {
    const [req, res] = makeReqRes({ method: 'GET', body: validBody() });
    await handler(req, res);
    expect(res.statusCode).toBe(405);
  });
});
