// tests/api-comp-time-admin-edit.test.js — P5.3:comp_time_balance admin_edit + audit
//
// 對 api/comp-time/[id].js PUT handler 9 case 覆蓋:
//   C1: 完整失效付款處理(expiry_payout_amount + expiry_processed_at + status='expired_paid')→ row 更新、audit 列三欄變化
//   C2: 延長 expires_at → row 更新、audit 列 expires_at 變化
//   C3: expiry_payout_amount = 0 → 合法(0 是合法金額)
//   C4: expiry_payout_amount 負數 → 400
//   C5: status='invalid' → 400
//   C6: 黑名單(earned_hours=99)→ callerPatch 為空 → 400 'no allowed fields'
//   C7: caller role='employee' → 403
//   C8: existing.admin_audit_note 已有 → 新 line 在頂 + '\n' 分隔
//   C9: row 不存在 → 404
//
// Mock 策略(對齊 tests/api-overtime-admin-edit.test.js):
//   supabase chain by 'comp_time_balance' table、dataByTable 控 SELECT、calls.updates 攔 UPDATE
//   auth.requireRole 真實 check role list

import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls = { tables: [], updates: [] };
const dataByTable = {};
const overrides = { caller: null };

vi.mock('../lib/supabase.js', () => {
  function chain(table) {
    const c = {};
    c.select = vi.fn(() => c);
    c.eq = vi.fn(() => c);
    c.update = vi.fn((patch) => { calls.updates.push({ table, patch }); return c; });
    c.maybeSingle = vi.fn(() => Promise.resolve({
      data: dataByTable[`${table}:maybeSingle`] ?? null, error: null,
    }));
    c.single = vi.fn(() => Promise.resolve({ data: null, error: null }));
    return c;
  }
  const client = { from: vi.fn((table) => { calls.tables.push(table); return chain(table); }) };
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

const { default: handler } = await import('../api/comp-time/[id].js');

function makeReqRes({ method = 'PUT', query = { id: '42' }, body = {} } = {}) {
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
  for (const k of Object.keys(dataByTable)) delete dataByTable[k];
  overrides.caller = { id: 'HR1', role: 'hr', is_manager: false };
});

function setExisting(over = {}) {
  dataByTable['comp_time_balance:maybeSingle'] = {
    id: 42,
    employee_id: 'E1',
    source_overtime_request_id: 100,
    earned_hours: 4,
    earned_at: '2026-01-15T10:00:00+08:00',
    expires_at: '2027-01-15',
    used_hours: 0,
    status: 'active',
    expiry_payout_amount: null,
    expiry_processed_at: null,
    admin_audit_note: null,
    ...over,
  };
}

describe('PUT /api/comp-time/:id — admin_edit + audit', () => {

  it('C1: 完整失效付款處理(amount + processed_at + status) → 200、audit 列三欄', async () => {
    setExisting({ status: 'active', expiry_payout_amount: null, expiry_processed_at: null });
    const [req, res] = makeReqRes({ body: {
      expiry_payout_amount: 1500,
      expiry_processed_at: '2026-05-19T00:00:00+08:00',
      status: 'expired_paid',
    }});
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    const upd = calls.updates.find(u => u.table === 'comp_time_balance');
    expect(upd.patch.expiry_payout_amount).toBe(1500);
    expect(upd.patch.expiry_processed_at).toBe('2026-05-19T00:00:00+08:00');
    expect(upd.patch.status).toBe('expired_paid');
    expect(upd.patch.admin_audit_note).toMatch(/expiry_payout_amount null→1500/);
    expect(upd.patch.admin_audit_note).toMatch(/expiry_processed_at null→2026-05-19/);
    expect(upd.patch.admin_audit_note).toMatch(/status active→expired_paid/);
  });

  it('C2: 延長 expires_at → 200、audit 列 expires_at', async () => {
    setExisting({ expires_at: '2027-01-15' });
    const [req, res] = makeReqRes({ body: { expires_at: '2027-06-15' } });
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    const upd = calls.updates[0];
    expect(upd.patch.expires_at).toBe('2027-06-15');
    expect(upd.patch.admin_audit_note).toMatch(/expires_at 2027-01-15→2027-06-15/);
  });

  it('C3: expiry_payout_amount=0 → 合法、200', async () => {
    setExisting({ expiry_payout_amount: null });
    const [req, res] = makeReqRes({ body: { expiry_payout_amount: 0 } });
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    const upd = calls.updates[0];
    expect(upd.patch.expiry_payout_amount).toBe(0);
    expect(upd.patch.admin_audit_note).toMatch(/expiry_payout_amount null→0/);
  });

  it('C4: expiry_payout_amount 負數 → 400', async () => {
    setExisting({});
    const [req, res] = makeReqRes({ body: { expiry_payout_amount: -100 } });
    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('invalid expiry_payout_amount');
    expect(calls.updates.length).toBe(0);
  });

  it('C5: status=invalid → 400', async () => {
    setExisting({});
    const [req, res] = makeReqRes({ body: { status: 'bogus' } });
    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('invalid status');
  });

  it('C6: 黑名單欄位 only(earned_hours=99)→ 過濾後空 → 400 no allowed fields', async () => {
    setExisting({});
    const [req, res] = makeReqRes({ body: { earned_hours: 99 } });
    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('no allowed fields to update');
    expect(calls.updates.length).toBe(0);
  });

  it('C7: caller role=employee → 403', async () => {
    overrides.caller = { id: 'E1', role: 'employee', is_manager: false };
    setExisting({});
    const [req, res] = makeReqRes({ body: { status: 'expired_paid' } });
    await handler(req, res);

    expect(res.statusCode).toBe(403);
    expect(calls.updates.length).toBe(0);
  });

  it('C8: existing.admin_audit_note 已有 → 新 line 在頂 + \\n 分隔', async () => {
    setExisting({
      status: 'active',
      admin_audit_note: '[2026-04-01] admin_edit by HR1: expires_at 2026-04-01→2027-01-15',
    });
    const [req, res] = makeReqRes({ body: { status: 'expired_void' } });
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    const upd = calls.updates[0];
    const note = upd.patch.admin_audit_note;
    const lines = note.split('\n');
    expect(lines[0]).toMatch(/admin_edit by HR1: status active→expired_void/);
    expect(lines[1]).toMatch(/expires_at 2026-04-01→2027-01-15/);
  });

  it('C9: row 不存在 → 404', async () => {
    // dataByTable['comp_time_balance:maybeSingle'] 不 set → maybeSingle 回 null
    const [req, res] = makeReqRes({ body: { status: 'expired_paid' } });
    await handler(req, res);

    expect(res.statusCode).toBe(404);
    expect(calls.updates.length).toBe(0);
  });
});
