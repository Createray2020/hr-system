// tests/api-schedule-period-publish.test.js — Phase 2.x.3 publish.js 嚴格 spec
//
// 對齊 approve.js spec(approve + publish 同主管角色、procedural 兩步)。
// 重點:
//   1. 無 auth → 401
//   2. self-approval → 403
//   3. HR / 跨部門 manager → 403(bypass 拔)
//   4. 真主管 → 200 + published_by=caller.id + published_at audit

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
    c.in = vi.fn((col, vals) => { where[`${col}_in`] = vals; return c; });
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
    // F2:thenable for list queries — `await sb.from(t).select().eq()` 不帶 terminal
    // 時 await 會呼叫 chain.then,回 dataByQuery[`${table}:list`] 預設空陣列。
    // 既有 .single() / .maybeSingle() 走自己的 Promise、不受影響。
    c.then = (onFulfilled, onRejected) => {
      const data = dataByQuery[`${table}:list`] ?? [];
      return Promise.resolve({ data, error: null }).then(onFulfilled, onRejected);
    };
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

const { default: handler } = await import('../api/schedule-periods/[id]/publish.js');

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

const MGR  = { id: 'M1',  role: 'employee', is_manager: true,  dept_id: 'D1' };
const MGR2 = { id: 'M2',  role: 'employee', is_manager: true,  dept_id: 'D2' };
const HR   = { id: 'HR1', role: 'hr',       is_manager: false, dept_id: 'D_HR' };

function setupApprovedPeriod(over = {}) {
  dataByQuery['schedule_periods:maybeSingle'] = {
    id: 'P1', employee_id: 'E1', status: 'approved',
    period_start: '2026-06-01', period_end: '2026-06-03',
    ...over.period,
  };
  dataByQuery['employees:maybeSingle'] = { dept_id: 'D1', ...over.employee };
  // F2:預設 schedules:list 完整覆蓋 3 天(讓守門加完後既有「真主管 200」case 仍綠)
  // 個別 case 可覆寫(over.schedules)
  dataByQuery['schedules:list'] = over.schedules ?? [
    { work_date: '2026-06-01' },
    { work_date: '2026-06-02' },
    { work_date: '2026-06-03' },
  ];
}

describe('/api/schedule-periods/:id/publish — Phase 2.x.3 嚴格 spec', () => {
  it('無 auth → 401', async () => {
    const [req, res] = makeReqRes({ query: { id: 'P1' } });
    await handler(req, res);
    expect(res.statusCode).toBe(401);
  });

  it('self-approval → 403', async () => {
    overrides.caller = { id: 'E1', role: 'employee', is_manager: true, dept_id: 'D1' };
    setupApprovedPeriod();
    const [req, res] = makeReqRes({ query: { id: 'P1' } });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
    expect(res.body?.error).toBe('CANNOT_PUBLISH_OWN_PERIOD');
  });

  it('HR → 403(原 isBackofficeRole bypass 拔)', async () => {
    overrides.caller = HR;
    setupApprovedPeriod();
    const [req, res] = makeReqRes({ query: { id: 'P1' } });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
  });

  it('跨部門 manager → 403', async () => {
    overrides.caller = MGR2;
    setupApprovedPeriod();
    const [req, res] = makeReqRes({ query: { id: 'P1' } });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
    expect(res.body?.error).toBe('NOT_SAME_DEPT');
  });

  it('真主管 → 200 + published_by=caller.id + published_at', async () => {
    overrides.caller = MGR;
    setupApprovedPeriod();
    // mock 對所有 .from('schedule_periods').maybeSingle() 回同一筆 'approved'、
    // 第一次撈是 'approved'(canTransition pass)、update 後 .select().maybeSingle()
    // 仍回 row(truthy 即 200)
    const [req, res] = makeReqRes({ query: { id: 'P1' } });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    const upd = calls.updates.find(u => u.table === 'schedule_periods');
    expect(upd?.patch.published_by).toBe('M1');
    expect(upd?.patch.published_at).toBeTruthy();
    expect(upd?.patch.status).toBe('published');
  });

  it('偽造 published_by → ignored', async () => {
    overrides.caller = MGR;
    setupApprovedPeriod();
    const [req, res] = makeReqRes({
      query: { id: 'P1' },
      body: { published_by: 'FAKE_BOSS' },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    const upd = calls.updates.find(u => u.table === 'schedule_periods');
    expect(upd?.patch.published_by).toBe('M1');
    expect(upd?.patch.published_by).not.toBe('FAKE_BOSS');
  });

  it('period 找不到 → 404', async () => {
    overrides.caller = MGR;
    const [req, res] = makeReqRes({ query: { id: 'P_404' } });
    await handler(req, res);
    expect(res.statusCode).toBe(404);
  });

  // ─── F2 守門:approved period 底下每天必須有 schedules row ───
  it('F2:approved + 每天有狀態 → 200(守門通過、正常 publish)', async () => {
    overrides.caller = MGR;
    setupApprovedPeriod();  // 預設 schedules 完整覆蓋 6/1~6/3
    const [req, res] = makeReqRes({ query: { id: 'P1' } });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(calls.updates.find(u => u.table === 'schedule_periods')).toBeDefined();
  });

  it('F2:approved + 缺中間 1 天 → 422 PUBLISH_EMPTY_PERIOD + missingDates、不 update / log / push', async () => {
    overrides.caller = MGR;
    setupApprovedPeriod({
      schedules: [
        { work_date: '2026-06-01' },
        // 缺 06-02
        { work_date: '2026-06-03' },
      ],
    });
    const [req, res] = makeReqRes({ query: { id: 'P1' } });
    await handler(req, res);
    expect(res.statusCode).toBe(422);
    expect(res.body?.error).toBe('PUBLISH_EMPTY_PERIOD');
    expect(res.body?.missingDates).toEqual(['2026-06-02']);
    // 守門擋下、不該寫 update / log / push(F2 spec)
    expect(calls.updates.find(u => u.table === 'schedule_periods')).toBeUndefined();
  });

  it('F2:approved + 完全 0 筆 schedules → 422 + 全部 missingDates', async () => {
    overrides.caller = MGR;
    setupApprovedPeriod({ schedules: [] });
    const [req, res] = makeReqRes({ query: { id: 'P1' } });
    await handler(req, res);
    expect(res.statusCode).toBe(422);
    expect(res.body?.error).toBe('PUBLISH_EMPTY_PERIOD');
    expect(res.body?.missingDates).toEqual(['2026-06-01', '2026-06-02', '2026-06-03']);
    expect(calls.updates.find(u => u.table === 'schedule_periods')).toBeUndefined();
  });
});
