// tests/cron-leave-proof-expiry.test.js — repo SQL filter 驗證
//
// 重點:cron 必須:
//   1. SELECT leave_requests WHERE proof_status='required' AND proof_due_at < now
//   2. UPDATE leave_type='personal' / proof_status='converted_to_personal' / handler_note
//
// 策略:同 tests/cron-absence-detection.test.js、mock supabase 攔截 chain。

import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls = { tables: [], selects: [], eqs: [], lts: [], updates: [] };

vi.mock('../lib/supabase.js', () => {
  function chain(table) {
    const c = {};
    c.select = vi.fn((str) => { calls.selects.push({ table, str }); return c; });
    c.eq = vi.fn((col, val) => { calls.eqs.push({ table, col, val }); return c; });
    c.lt = vi.fn((col, val) => { calls.lts.push({ table, col, val }); return c; });
    c.update = vi.fn((patch) => { calls.updates.push({ table, patch }); return c; });
    c.order = vi.fn(() => c);
    c.limit = vi.fn(() => c);
    c.in = vi.fn(() => c);
    c.maybeSingle = vi.fn(() => Promise.resolve({ data: null, error: null }));
    c.single = vi.fn(() => Promise.resolve({ data: null, error: null }));
    // 預設 SELECT 回空、不會觸發 UPDATE 流程
    c.then = (onF, onR) => Promise.resolve({ data: [], error: null }).then(onF, onR);
    return c;
  }
  const client = {
    from: vi.fn((table) => { calls.tables.push(table); return chain(table); }),
  };
  return { supabase: client, supabaseAdmin: client };
});

vi.mock('../lib/cron-auth.js', () => ({ requireCron: vi.fn(() => true) }));
vi.mock('../lib/push.js', () => ({
  sendPushToEmployees: vi.fn(async () => ({ sent: 0 })),
  sendPushToRoles:     vi.fn(async () => ({ sent: 0 })),
  createNotification:  vi.fn(async () => undefined),
  createNotificationsForRoles: vi.fn(async () => undefined),
}));

const { default: handler } = await import('../api/cron-leave-proof-expiry.js');

function makeReqRes(query = {}) {
  const res = {
    statusCode: 200, body: undefined,
    status(c) { this.statusCode = c; return this; },
    json(p)   { this.body = p; return this; },
  };
  return [{ method: 'GET', query, headers: {} }, res];
}

beforeEach(() => {
  calls.tables = []; calls.selects = []; calls.eqs = []; calls.lts = []; calls.updates = [];
});

describe('cron-leave-proof-expiry — SELECT filter chain', () => {
  it('SELECT leave_requests 含 id / leave_type / proof_status / proof_due_at / handler_note', async () => {
    const [req, res] = makeReqRes({ now: '2026-05-10T00:00:00+08:00' });
    await handler(req, res);

    const sel = calls.selects.find(s => s.table === 'leave_requests');
    expect(sel).toBeDefined();
    expect(sel.str).toContain('id');
    expect(sel.str).toContain('employee_id');
    expect(sel.str).toContain('leave_type');
    expect(sel.str).toContain('proof_status');
    expect(sel.str).toContain('proof_due_at');
    expect(sel.str).toContain('handler_note');
  });

  it('eq proof_status=required + lt proof_due_at < now', async () => {
    const NOW = '2026-05-10T00:00:00+08:00';
    const [req, res] = makeReqRes({ now: NOW });
    await handler(req, res);

    const eqs = calls.eqs.filter(e => e.table === 'leave_requests');
    const proofEq = eqs.find(e => e.col === 'proof_status');
    expect(proofEq).toBeDefined();
    expect(proofEq.val).toBe('required');

    const lts = calls.lts.filter(e => e.table === 'leave_requests');
    const dueLt = lts.find(e => e.col === 'proof_due_at');
    expect(dueLt).toBeDefined();
    expect(dueLt.val).toBe(NOW);
  });

  it('SELECT 回空 → handler 200 / scanned=0 / converted=0、不觸發 UPDATE', async () => {
    const [req, res] = makeReqRes({ now: '2026-05-10T00:00:00+08:00' });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ ok: true, scanned: 0, converted: 0 });
    expect(calls.updates.length).toBe(0);
  });

  it('沒帶 query.now → 用 server NOW(預設行為)', async () => {
    const [req, res] = makeReqRes({});
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    // lt('proof_due_at', NOW) 仍要被 call、值是 server new Date().toISOString()
    const lts = calls.lts.filter(e => e.col === 'proof_due_at');
    expect(lts.length).toBe(1);
    expect(typeof lts[0].val).toBe('string');
    expect(lts[0].val).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
