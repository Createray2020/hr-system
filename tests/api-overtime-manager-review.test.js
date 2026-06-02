// tests/api-overtime-manager-review.test.js — Phase 2.x.2 dept+is_manager 嚴格 spec
//
// 重點:
//   1. 無 auth → 401
//   2. self-approval(caller.id === employee_id)→ 403
//   3. 非 manager(is_manager=false)→ 403
//   4. 跨部門 manager(dept 不同)→ 403
//   5. HR / admin / CEO 跨層 bypass 拔(必須 is_manager + 同 dept)
//   6. 真主管(同 dept + is_manager + 非自己)→ 200
//   7. manager_id 強制 caller.id(client 偽造 ignored)

import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls = { tables: [], updates: [] };
const dataByQuery = {};
const overrides = { caller: null };

vi.mock('../lib/supabase.js', () => {
  function chain() {
    const c = {};
    c.select = vi.fn(() => c);
    c.eq = vi.fn(() => c);
    c.maybeSingle = vi.fn(() => Promise.resolve({ data: null, error: null }));
    return c;
  }
  const client = { from: vi.fn(() => chain()) };
  return { supabase: client, supabaseAdmin: client };
});

vi.mock('../api/overtime-requests/_repo.js', () => ({
  makeOvertimeRepo: vi.fn(() => ({
    findOvertimeRequestById: vi.fn(async () => dataByQuery['request'] || null),
    findEmployeeManager: vi.fn(async () => dataByQuery['employee'] || null),
    updateOvertimeRequest: vi.fn(async (id, patch) => {
      calls.updates.push({ table: 'overtime_requests', patch });
      return { id, ...dataByQuery['request'], ...patch };
    }),
    nowIso: () => '2026-05-07T00:00:00.000Z',
    getSystemOvertimeSettings: vi.fn(async () => ({})),
    findEmployeeMonthlySalary: vi.fn(async () => 0),
    insertCompBalance: vi.fn(async () => ({})),
    insertBalanceLog: vi.fn(async () => ({})),
    updateOvertimeCompBalanceId: vi.fn(async () => ({})),
  })),
}));

vi.mock('../lib/auth.js', () => ({
  requireAuth: vi.fn(async (req, res) => {
    if (!overrides.caller) { res.status(401).json({ error: 'Unauthorized' }); return null; }
    return overrides.caller;
  }),
}));

// 2026-06:review endpoint 改用 safe wrapper(失敗不 throw、改帶 warning + audit note)
const mockConvertSafe = vi.fn(async () => ({ ok: true, comp_balance: {}, warning: null }));
vi.mock('../lib/overtime/comp-conversion.js', () => ({
  convertOvertimeToCompTime: vi.fn(async () => ({})),
  convertOvertimeToCompTimeSafe: mockConvertSafe,
}));

const { default: handler } = await import('../api/overtime-requests/[id]/manager-review.js');

function makeReqRes({ method = 'POST', query = {}, body = {} } = {}) {
  const res = {
    statusCode: 200, body: undefined,
    status(c) { this.statusCode = c; return this; },
    json(p)   { this.body = p; return this; },
    end()     { return this; },
  };
  return [{ method, query, body, headers: {} }, res];
}

beforeEach(() => {
  calls.tables = []; calls.updates = [];
  for (const k of Object.keys(dataByQuery)) delete dataByQuery[k];
  overrides.caller = null;
});

const E1   = { id: 'E1', role: 'employee', is_manager: false, dept_id: 'D1' };
const MGR  = { id: 'M1', role: 'employee', is_manager: true,  dept_id: 'D1' };
const MGR2 = { id: 'M2', role: 'employee', is_manager: true,  dept_id: 'D2' };
const HR   = { id: 'HR1', role: 'hr',       is_manager: false, dept_id: 'D_HR' };
const HR_M = { id: 'HR2', role: 'hr',       is_manager: true,  dept_id: 'D_HR' };  // HR + is_manager,但 dept 不對
const CEO  = { id: 'C1',  role: 'ceo',      is_manager: false, dept_id: 'D_EXEC' };
const ADM  = { id: 'A1',  role: 'admin',    is_manager: false, dept_id: 'D_HR' };

function setupPending(over = {}) {
  dataByQuery['request'] = {
    id: 'OT1', employee_id: 'E1', status: 'pending',
    overtime_date: '2026-05-07', hours: 2, compensation_type: 'comp_leave',
    is_over_limit: false, manager_id: null,
    ...over.request,
  };
  dataByQuery['employee'] = { id: 'E1', dept_id: 'D1', manager_id: null };
}

describe('/api/overtime-requests/:id/manager-review — Phase 2.x.2 嚴格 spec', () => {
  it('無 auth → 401', async () => {
    const [req, res] = makeReqRes({ query: { id: 'OT1' }, body: { decision: 'approved' } });
    await handler(req, res);
    expect(res.statusCode).toBe(401);
  });

  it('self-approval(caller.id === employee_id)→ 403', async () => {
    overrides.caller = { ...E1, is_manager: true };  // 員工碰巧是 is_manager
    setupPending();
    const [req, res] = makeReqRes({ query: { id: 'OT1' }, body: { decision: 'approved' } });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
    expect(res.body?.error).toBe('CANNOT_REVIEW_OWN_REQUEST');
  });

  it('非 is_manager → 403(NOT_MANAGER)', async () => {
    overrides.caller = { id: 'E2', role: 'employee', is_manager: false, dept_id: 'D1' };
    setupPending();
    const [req, res] = makeReqRes({ query: { id: 'OT1' }, body: { decision: 'approved' } });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
    expect(res.body?.error).toBe('NOT_MANAGER');
  });

  it('跨部門 manager(dept_id 不同)→ 403(NOT_SAME_DEPT)', async () => {
    overrides.caller = MGR2;  // dept_id=D2
    setupPending();             // employee dept=D1
    const [req, res] = makeReqRes({ query: { id: 'OT1' }, body: { decision: 'approved' } });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
    expect(res.body?.error).toBe('NOT_SAME_DEPT');
  });

  it('HR(is_manager=false)→ 403(原本 isHR bypass 拔)', async () => {
    overrides.caller = HR;
    setupPending();
    const [req, res] = makeReqRes({ query: { id: 'OT1' }, body: { decision: 'approved' } });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
    expect(res.body?.error).toBe('NOT_MANAGER');
  });

  it('HR + is_manager=true 但跨部門 → 403(dept 不對)', async () => {
    overrides.caller = HR_M;  // dept=D_HR、employee dept=D1
    setupPending();
    const [req, res] = makeReqRes({ query: { id: 'OT1' }, body: { decision: 'approved' } });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
    expect(res.body?.error).toBe('NOT_SAME_DEPT');
  });

  it('CEO(is_manager=false)→ 403(原本 isHR bypass 拔)', async () => {
    overrides.caller = CEO;
    setupPending();
    const [req, res] = makeReqRes({ query: { id: 'OT1' }, body: { decision: 'approved' } });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
  });

  it('admin(is_manager=false)→ 403', async () => {
    overrides.caller = ADM;
    setupPending();
    const [req, res] = makeReqRes({ query: { id: 'OT1' }, body: { decision: 'approved' } });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
  });

  it('真主管(同 dept + is_manager + 非自己)+ pending → 200 + manager_id=caller.id', async () => {
    overrides.caller = MGR;  // dept=D1、is_manager=true
    setupPending();
    const [req, res] = makeReqRes({ query: { id: 'OT1' }, body: { decision: 'approved' } });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    const upd = calls.updates[0];
    expect(upd.patch.manager_id).toBe('M1');
    expect(upd.patch.manager_decision).toBe('approved');
  });

  it('manager_id 強制 caller.id(client 偽造 ignored)', async () => {
    overrides.caller = MGR;
    setupPending();
    const [req, res] = makeReqRes({
      query: { id: 'OT1' },
      body: { decision: 'approved', manager_id: 'FAKE_BOSS' },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    const upd = calls.updates[0];
    expect(upd.patch.manager_id).toBe('M1');
    expect(upd.patch.manager_id).not.toBe('FAKE_BOSS');
  });

  it('真主管 reject → 200 + manager_decision=rejected', async () => {
    overrides.caller = MGR;
    setupPending();
    const [req, res] = makeReqRes({
      query: { id: 'OT1' },
      body: { decision: 'rejected', note: '時數不對' },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    const upd = calls.updates[0];
    expect(upd.patch.manager_decision).toBe('rejected');
    expect(upd.patch.reject_reason).toBe('時數不對');
  });

  it('non-pending status → 409(canTransition 擋)', async () => {
    overrides.caller = MGR;
    setupPending({ request: { status: 'approved' } });  // 已 approved、不能再批
    const [req, res] = makeReqRes({ query: { id: 'OT1' }, body: { decision: 'approved' } });
    await handler(req, res);
    expect(res.statusCode).toBe(409);
  });

  it('找不到 request → 404', async () => {
    overrides.caller = MGR;
    // 不 setupPending、dataByQuery['request']=undefined
    const [req, res] = makeReqRes({ query: { id: 'OT_404' }, body: { decision: 'approved' } });
    await handler(req, res);
    expect(res.statusCode).toBe(404);
  });

  // 04.5 §四:已選定者鎖死、審核者不得改寫
  it('已選定 compensation_type → body 帶不同值被忽略、維持 row 上值', async () => {
    overrides.caller = MGR;
    setupPending({ request: { compensation_type: 'comp_leave' } });
    const [req, res] = makeReqRes({
      query: { id: 'OT1' },
      body: { decision: 'approved', compensation_type: 'overtime_pay' },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    const upd = calls.updates[0];
    expect(upd.patch.compensation_type).toBe('comp_leave');
  });

  // 安全網:legacy undecided row 仍允許主管核准時補指定
  it('legacy undecided row + approved + body 補指定 → 採用 body 的補償方式', async () => {
    overrides.caller = MGR;
    setupPending({ request: { compensation_type: 'undecided' } });
    const [req, res] = makeReqRes({
      query: { id: 'OT1' },
      body: { decision: 'approved', compensation_type: 'overtime_pay' },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    const upd = calls.updates[0];
    expect(upd.patch.compensation_type).toBe('overtime_pay');
  });

  it('legacy undecided row + approved + body 未指定 → 400 COMPENSATION_TYPE_REQUIRED', async () => {
    overrides.caller = MGR;
    setupPending({ request: { compensation_type: 'undecided' } });
    const [req, res] = makeReqRes({ query: { id: 'OT1' }, body: { decision: 'approved' } });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body?.error).toBe('COMPENSATION_TYPE_REQUIRED');
  });

  it('body 傳 undecided → 400(白名單僅 comp_leave / overtime_pay)', async () => {
    overrides.caller = MGR;
    setupPending();
    const [req, res] = makeReqRes({
      query: { id: 'OT1' },
      body: { decision: 'approved', compensation_type: 'undecided' },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body?.error).toBe('invalid compensation_type');
  });

  // 2026-06:safe wrapper 失敗 → 仍 200、response 帶 warning
  it('comp_leave 轉換失敗 → 200 仍核准成功、response.warnings 含 COMP_CONVERSION_FAILED', async () => {
    overrides.caller = MGR;
    setupPending();
    mockConvertSafe.mockResolvedValueOnce({
      ok: false,
      comp_balance: null,
      warning: {
        code: 'COMP_CONVERSION_FAILED',
        message: '加班已核准,但補休餘額建立失敗,請聯繫 HR。',
        detail: 'grantCompTime did not return a record with id',
      },
    });
    const [req, res] = makeReqRes({
      query: { id: 'OT1' },
      body: { decision: 'approved' },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body?.request).toBeTruthy();
    expect(res.body?.comp_balance).toBe(null);
    expect(Array.isArray(res.body?.warnings)).toBe(true);
    expect(res.body.warnings).toHaveLength(1);
    expect(res.body.warnings[0].code).toBe('COMP_CONVERSION_FAILED');
  });

  it('comp_leave 轉換成功 → response.warnings 空陣列、comp_balance 有值', async () => {
    overrides.caller = MGR;
    setupPending();
    mockConvertSafe.mockResolvedValueOnce({
      ok: true,
      comp_balance: { id: 'CB42' },
      warning: null,
    });
    const [req, res] = makeReqRes({
      query: { id: 'OT1' },
      body: { decision: 'approved' },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body?.comp_balance?.id).toBe('CB42');
    expect(res.body?.warnings).toEqual([]);
  });
});
