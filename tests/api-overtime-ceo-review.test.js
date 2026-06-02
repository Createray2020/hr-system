// tests/api-overtime-ceo-review.test.js — Phase 2.x.2 ceo-review 嚴格 spec
//
// 重點:
//   1. 無 auth → 401
//   2. self-approval → 403
//   3. cross-stage 同人連簽(caller.id === row.manager_id)→ 403
//   4. CEO + chairman → 200(視同 ceo)
//   5. admin → 403(嚴格 spec、admin 不視同 ceo)
//   6. 一般員工 → 403
//   7. ceo_id 強制 caller.id

import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls = { tables: [], updates: [], approvalsTable: [] };
const dataByQuery = {};
const overrides = { caller: null };

vi.mock('../api/overtime-requests/_repo.js', () => ({
  makeOvertimeRepo: vi.fn(() => ({
    findOvertimeRequestById: vi.fn(async () => dataByQuery['request'] || null),
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

// approvals_v2_role_assignments fallback:預設沒對到、回 null
vi.mock('../lib/supabase.js', () => {
  function chain() {
    const c = {};
    c.select = vi.fn(() => c);
    c.eq = vi.fn(() => c);
    c.maybeSingle = vi.fn(() => Promise.resolve({
      data: dataByQuery['approvals_v2_role_assignments'] || null, error: null,
    }));
    return c;
  }
  const client = { from: vi.fn(() => chain()) };
  return { supabase: client, supabaseAdmin: client };
});

vi.mock('../lib/auth.js', () => ({
  requireAuth: vi.fn(async (req, res) => {
    if (!overrides.caller) { res.status(401).json({ error: 'Unauthorized' }); return null; }
    return overrides.caller;
  }),
}));

// 2026-06:review endpoint 改用 safe wrapper(失敗不 throw、改帶 warning + audit note)
const mockConvertSafeCeo = vi.fn(async () => ({ ok: true, comp_balance: {}, warning: null }));
vi.mock('../lib/overtime/comp-conversion.js', () => ({
  convertOvertimeToCompTime: vi.fn(async () => ({})),
  convertOvertimeToCompTimeSafe: mockConvertSafeCeo,
}));

const { default: handler } = await import('../api/overtime-requests/[id]/ceo-review.js');

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
  calls.tables = []; calls.updates = []; calls.approvalsTable = [];
  for (const k of Object.keys(dataByQuery)) delete dataByQuery[k];
  overrides.caller = null;
});

const E1   = { id: 'E1', role: 'employee', is_manager: false, dept_id: 'D1' };
const MGR  = { id: 'M1', role: 'employee', is_manager: true,  dept_id: 'D1' };
const CEO  = { id: 'C1', role: 'ceo',      is_manager: false, dept_id: 'D_EXEC' };
const CHR  = { id: 'CH1', role: 'chairman', is_manager: false, dept_id: 'D_EXEC' };
const ADM  = { id: 'A1', role: 'admin',    is_manager: false, dept_id: 'D_HR' };
const HR   = { id: 'HR1', role: 'hr',      is_manager: false, dept_id: 'D_HR' };

function setupPendingCeo(over = {}) {
  dataByQuery['request'] = {
    id: 'OT1', employee_id: 'E1', status: 'pending_ceo',
    overtime_date: '2026-05-07', hours: 6, compensation_type: 'overtime_pay',
    is_over_limit: true, manager_id: 'M1',  // 已有 manager 簽過
    ...over.request,
  };
}

describe('/api/overtime-requests/:id/ceo-review — Phase 2.x.2 嚴格 spec', () => {
  it('無 auth → 401', async () => {
    const [req, res] = makeReqRes({ query: { id: 'OT1' }, body: { decision: 'approved' } });
    await handler(req, res);
    expect(res.statusCode).toBe(401);
  });

  it('CEO + 非自己 + 非 cross-stage → 200 + ceo_id=caller.id', async () => {
    overrides.caller = CEO;
    setupPendingCeo();
    const [req, res] = makeReqRes({ query: { id: 'OT1' }, body: { decision: 'approved' } });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    const upd = calls.updates[0];
    expect(upd.patch.ceo_id).toBe('C1');
    expect(upd.patch.ceo_decision).toBe('approved');
  });

  it('chairman + pending_ceo → 200(視同 ceo 保留)', async () => {
    overrides.caller = CHR;
    setupPendingCeo();
    const [req, res] = makeReqRes({ query: { id: 'OT1' }, body: { decision: 'approved' } });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
  });

  it('admin → 403(嚴格 spec、admin 不視同 ceo)', async () => {
    overrides.caller = ADM;
    setupPendingCeo();
    const [req, res] = makeReqRes({ query: { id: 'OT1' }, body: { decision: 'approved' } });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
    expect(res.body?.error).toBe('CEO only');
  });

  it('HR → 403', async () => {
    overrides.caller = HR;
    setupPendingCeo();
    const [req, res] = makeReqRes({ query: { id: 'OT1' }, body: { decision: 'approved' } });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
  });

  it('一般員工 → 403', async () => {
    overrides.caller = E1;
    setupPendingCeo();
    const [req, res] = makeReqRes({ query: { id: 'OT1' }, body: { decision: 'approved' } });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
  });

  it('CEO 對自己 → 403(self-approval)', async () => {
    overrides.caller = CEO;
    setupPendingCeo({ request: { employee_id: 'C1' } });
    const [req, res] = makeReqRes({ query: { id: 'OT1' }, body: { decision: 'approved' } });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
    expect(res.body?.error).toBe('CANNOT_REVIEW_OWN_REQUEST');
  });

  it('cross-stage 同人連簽(caller.id === manager_id)→ 403', async () => {
    // 假設 chairman 跨層當 manager 又當 ceo;在新 manager-review 嚴格 spec 下這 case 已 403、
    // 但歷史 row 可能有舊資料 manager_id 為 chairman、ceo-review 仍要再守一次
    overrides.caller = CHR;
    setupPendingCeo({ request: { manager_id: 'CH1' } });  // chairman 本人就是 manager
    const [req, res] = makeReqRes({ query: { id: 'OT1' }, body: { decision: 'approved' } });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
    expect(res.body?.error).toBe('CROSS_STAGE_SELF_REVIEW');
  });

  it('manager_id null(舊 row、沒 manager)→ 不擋 cross-stage、CEO 仍可審', async () => {
    overrides.caller = CEO;
    setupPendingCeo({ request: { manager_id: null } });
    const [req, res] = makeReqRes({ query: { id: 'OT1' }, body: { decision: 'approved' } });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
  });

  it('ceo_id 強制 caller.id(client 偽造 ignored)', async () => {
    overrides.caller = CEO;
    setupPendingCeo();
    const [req, res] = makeReqRes({
      query: { id: 'OT1' },
      body: { decision: 'approved', ceo_id: 'FAKE_CEO' },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    const upd = calls.updates[0];
    expect(upd.patch.ceo_id).toBe('C1');
    expect(upd.patch.ceo_id).not.toBe('FAKE_CEO');
  });

  it('CEO reject + note → 200 + reject_reason 寫入', async () => {
    overrides.caller = CEO;
    setupPendingCeo();
    const [req, res] = makeReqRes({
      query: { id: 'OT1' },
      body: { decision: 'rejected', note: '超時太多' },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    const upd = calls.updates[0];
    expect(upd.patch.ceo_decision).toBe('rejected');
    expect(upd.patch.reject_reason).toBe('超時太多');
  });

  it('non-pending_ceo status → 409(canTransition 擋)', async () => {
    overrides.caller = CEO;
    setupPendingCeo({ request: { status: 'approved' } });
    const [req, res] = makeReqRes({ query: { id: 'OT1' }, body: { decision: 'approved' } });
    await handler(req, res);
    expect(res.statusCode).toBe(409);
  });

  // 04.5 §四:已選定者鎖死、CEO 不得改寫
  it('已選定 compensation_type → body 帶不同值被忽略、維持 row 上值', async () => {
    overrides.caller = CEO;
    setupPendingCeo({ request: { compensation_type: 'comp_leave' } });
    const [req, res] = makeReqRes({
      query: { id: 'OT1' },
      body: { decision: 'approved', compensation_type: 'overtime_pay' },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    const upd = calls.updates[0];
    expect(upd.patch.compensation_type).toBe('comp_leave');
  });

  // 安全網:legacy undecided row 仍允許 CEO 核准時補指定
  it('legacy undecided row + approved + body 補指定 → 採用 body 的補償方式', async () => {
    overrides.caller = CEO;
    setupPendingCeo({ request: { compensation_type: 'undecided' } });
    const [req, res] = makeReqRes({
      query: { id: 'OT1' },
      body: { decision: 'approved', compensation_type: 'comp_leave' },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    const upd = calls.updates[0];
    expect(upd.patch.compensation_type).toBe('comp_leave');
  });

  it('legacy undecided row + approved + body 未指定 → 400 COMPENSATION_TYPE_REQUIRED', async () => {
    overrides.caller = CEO;
    setupPendingCeo({ request: { compensation_type: 'undecided' } });
    const [req, res] = makeReqRes({ query: { id: 'OT1' }, body: { decision: 'approved' } });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body?.error).toBe('COMPENSATION_TYPE_REQUIRED');
  });

  it('body 傳 undecided → 400(白名單僅 comp_leave / overtime_pay)', async () => {
    overrides.caller = CEO;
    setupPendingCeo();
    const [req, res] = makeReqRes({
      query: { id: 'OT1' },
      body: { decision: 'approved', compensation_type: 'undecided' },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body?.error).toBe('invalid compensation_type');
  });
});
