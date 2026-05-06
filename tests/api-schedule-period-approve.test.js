// tests/api-schedule-period-approve.test.js — Phase 2.x.3 嚴格 spec
//
// 重點:
//   1. 無 auth → 401
//   2. self-approval(caller.id === period.employee_id)→ 403
//   3. 非 is_manager → 403
//   4. 跨部門 manager → 403
//   5. HR(is_manager=false)→ 403(原本 isBackofficeRole bypass 拔)
//   6. 真主管(同 dept + is_manager + 非自己)→ 200 + approved_by=caller.id
//   7. 偽造 approved_by(client 傳)→ ignored

import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls = { tables: [], updates: [] };
const dataByQuery = {};
const overrides = { caller: null };

vi.mock('../lib/supabase.js', () => {
  function chain(table) {
    const c = {};
    let where = {};
    c.select = vi.fn(() => c);
    c.eq = vi.fn((col, val) => { where[col] = val; return c; });
    c.update = vi.fn((patch) => {
      calls.updates.push({ table, patch, where: { ...where } });
      return c;
    });
    c.insert = vi.fn(() => c);
    c.single = vi.fn(() => Promise.resolve({
      data: dataByQuery[`${table}:single`] ?? null, error: null,
    }));
    c.maybeSingle = vi.fn(() => Promise.resolve({
      data: dataByQuery[`${table}:maybeSingle`] ?? null, error: null,
    }));
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
}));

vi.mock('../lib/schedule/change-logger.js', () => ({
  logScheduleChange: vi.fn(async () => ({})),
}));

vi.mock('../lib/push.js', () => ({
  sendPushToEmployees: vi.fn(async () => ({})),
  createNotifications: vi.fn(async () => undefined),
}));

const { default: handler } = await import('../api/schedule-periods/[id]/approve.js');

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

const E1   = { id: 'E1',  role: 'employee', is_manager: false, dept_id: 'D1' };
const MGR  = { id: 'M1',  role: 'employee', is_manager: true,  dept_id: 'D1' };
const MGR2 = { id: 'M2',  role: 'employee', is_manager: true,  dept_id: 'D2' };
const HR   = { id: 'HR1', role: 'hr',       is_manager: false, dept_id: 'D_HR' };
const CEO  = { id: 'C1',  role: 'ceo',      is_manager: false, dept_id: 'D_EXEC' };

function setupSubmittedPeriod(over = {}) {
  // schedule_periods.maybeSingle:預設 submitted period
  dataByQuery['schedule_periods:maybeSingle'] = {
    id: 'P1', employee_id: 'E1', status: 'submitted',
    period_start: '2026-06-01', period_end: '2026-06-30',
    ...over.period,
  };
  // employees.maybeSingle:預設 employee dept=D1(approve.js 撈 dept 用)
  // 注意:.update().select().maybeSingle() 也走 maybeSingle、要回 updated row
  dataByQuery['employees:maybeSingle'] = { dept_id: 'D1', ...over.employee };
}

describe('/api/schedule-periods/:id/approve — Phase 2.x.3 嚴格 spec', () => {
  it('無 auth → 401', async () => {
    const [req, res] = makeReqRes({ query: { id: 'P1' } });
    await handler(req, res);
    expect(res.statusCode).toBe(401);
  });

  it('self-approval(caller.id === period.employee_id)→ 403', async () => {
    overrides.caller = { ...E1, is_manager: true };
    setupSubmittedPeriod();
    const [req, res] = makeReqRes({ query: { id: 'P1' } });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
    expect(res.body?.error).toBe('CANNOT_APPROVE_OWN_PERIOD');
  });

  it('非 is_manager → 403(NOT_MANAGER)', async () => {
    overrides.caller = { id: 'E2', role: 'employee', is_manager: false, dept_id: 'D1' };
    setupSubmittedPeriod();
    const [req, res] = makeReqRes({ query: { id: 'P1' } });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
    expect(res.body?.error).toBe('NOT_MANAGER');
  });

  it('HR(is_manager=false)→ 403(原 isBackofficeRole bypass 拔)', async () => {
    overrides.caller = HR;
    setupSubmittedPeriod();
    const [req, res] = makeReqRes({ query: { id: 'P1' } });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
    expect(res.body?.error).toBe('NOT_MANAGER');
  });

  it('CEO(is_manager=false)→ 403', async () => {
    overrides.caller = CEO;
    setupSubmittedPeriod();
    const [req, res] = makeReqRes({ query: { id: 'P1' } });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
  });

  it('跨部門 manager → 403(NOT_SAME_DEPT)', async () => {
    overrides.caller = MGR2;  // dept=D2
    setupSubmittedPeriod();    // employee dept=D1
    const [req, res] = makeReqRes({ query: { id: 'P1' } });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
    expect(res.body?.error).toBe('NOT_SAME_DEPT');
  });

  it('真主管(同 dept + is_manager)→ 200 + approved_by=caller.id', async () => {
    overrides.caller = MGR;
    setupSubmittedPeriod();
    // mock 對所有 .from('schedule_periods').maybeSingle() 回同一筆、
    // 第一次撈是 'submitted'(canTransition pass)、update 後 .select().maybeSingle() 同 row
    // (truthy 即可、行為等同 PG return updated row)
    const [req, res] = makeReqRes({ query: { id: 'P1' } });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    const upd = calls.updates.find(u => u.table === 'schedule_periods');
    expect(upd?.patch.approved_by).toBe('M1');
    expect(upd?.patch.status).toBe('approved');
    expect(upd?.patch.approved_at).toBeTruthy();
  });

  it('偽造 approved_by(client 傳 != caller.id)→ ignored、實寫 caller.id', async () => {
    overrides.caller = MGR;
    setupSubmittedPeriod();
    const [req, res] = makeReqRes({
      query: { id: 'P1' },
      body: { approved_by: 'FAKE_BOSS' },  // body 應被忽略
    });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    const upd = calls.updates.find(u => u.table === 'schedule_periods');
    expect(upd?.patch.approved_by).toBe('M1');
    expect(upd?.patch.approved_by).not.toBe('FAKE_BOSS');
  });

  it('period 找不到 → 404', async () => {
    overrides.caller = MGR;
    // 不 setup、period:maybeSingle 預設 null
    const [req, res] = makeReqRes({ query: { id: 'P_404' } });
    await handler(req, res);
    expect(res.statusCode).toBe(404);
  });
});
