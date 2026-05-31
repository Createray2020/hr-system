// tests/api-schedule-period-force-finalize.test.js
// 對齊 api/schedule-periods/[id]/force-finalize.js spec。
//
// 重點:
//   1. 無 auth → 401
//   2. 未到窗 → 403 BEFORE_WINDOW(角色符合)
//   3. 一般員工 → 403 NOT_AUTHORIZED
//   4. 缺天 → 422 FORCE_EMPTY_PERIOD
//   5. published / locked → 200 no-op
//   6. draft → published 一刀(3 步 change_log + audit columns 補齊)

import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls = { tables: [], updates: [], logs: [] };
const dataByQuery = {};
const overrides = { caller: null };

// 把 now 凍結到 2026-06-01(已過 manager 5/26 + ceo 5/31 兩窗,manager_force / ceo_force 都通)
vi.useFakeTimers();
vi.setSystemTime(new Date('2026-06-01T00:00:00Z'));

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
    c.insert = vi.fn((rows) => {
      if (table === 'schedule_change_logs') calls.logs.push(...rows);
      return c;
    });
    c.single = vi.fn(() => Promise.resolve({
      data: dataByQuery[`${table}:single`] ?? (table === 'schedule_periods'
        ? dataByQuery[`${table}:maybeSingle`] : null),
      error: null,
    }));
    c.maybeSingle = vi.fn(() => Promise.resolve({
      data: dataByQuery[`${table}:maybeSingle`] ?? null, error: null,
    }));
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

// 不 mock logScheduleChange:讓真的呼叫到 repo.insertScheduleChangeLog、撈 calls.logs 驗 reason
vi.mock('../lib/push.js', () => ({
  sendPushToEmployees: vi.fn(async () => ({})),
  createNotifications: vi.fn(async () => undefined),
}));

const { default: handler } = await import('../api/schedule-periods/[id]/force-finalize.js');

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
  calls.tables = []; calls.updates = []; calls.logs = [];
  for (const k of Object.keys(dataByQuery)) delete dataByQuery[k];
  overrides.caller = null;
});

const SAME_DEPT_MGR = { id: 'M1', role: 'employee', is_manager: true,  dept_id: 'D1' };
const NON_MGR_EMP   = { id: 'E1', role: 'employee', is_manager: false, dept_id: 'D1' };
const CEO_USER      = { id: 'C1', role: 'ceo',      is_manager: false, dept_id: 'DX' };

function setupDraftPeriod(over = {}) {
  dataByQuery['schedule_periods:maybeSingle'] = {
    id: 'P1', employee_id: 'E1', status: 'draft',
    period_start: '2026-06-01', period_end: '2026-06-03',
    submitted_at: null, approved_at: null, approved_by: null,
    published_at: null, published_by: null,
    ...over.period,
  };
  dataByQuery['employees:maybeSingle'] = { dept_id: 'D1', ...over.employee };
  dataByQuery['schedules:list'] = over.schedules ?? [
    { work_date: '2026-06-01' },
    { work_date: '2026-06-02' },
    { work_date: '2026-06-03' },
  ];
}

describe('/api/schedule-periods/:id/force-finalize', () => {
  it('無 auth → 401', async () => {
    const [req, res] = makeReqRes({ query: { id: 'P1' } });
    await handler(req, res);
    expect(res.statusCode).toBe(401);
  });

  it('一般員工 → 403 NOT_AUTHORIZED', async () => {
    overrides.caller = NON_MGR_EMP;
    setupDraftPeriod();
    const [req, res] = makeReqRes({ query: { id: 'P1' } });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
    expect(res.body?.error).toBe('NOT_AUTHORIZED');
  });

  it('CEO 未到 ceo 窗(5/30) → 403 BEFORE_WINDOW', async () => {
    overrides.caller = CEO_USER;
    setupDraftPeriod();
    vi.setSystemTime(new Date('2026-05-30T00:00:00Z'));
    const [req, res] = makeReqRes({ query: { id: 'P1' } });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
    expect(res.body?.error).toBe('BEFORE_WINDOW');
    // reset
    vi.setSystemTime(new Date('2026-06-01T00:00:00Z'));
  });

  it('CEO 6/1 + 缺天 → 422 FORCE_EMPTY_PERIOD + missingDates', async () => {
    overrides.caller = CEO_USER;
    setupDraftPeriod({ schedules: [{ work_date: '2026-06-01' }] });  // 缺 6/2、6/3
    const [req, res] = makeReqRes({ query: { id: 'P1' } });
    await handler(req, res);
    expect(res.statusCode).toBe(422);
    expect(res.body?.error).toBe('FORCE_EMPTY_PERIOD');
    expect(res.body?.missingDates).toEqual(['2026-06-02', '2026-06-03']);
  });

  it('已 published → 200 no-op', async () => {
    overrides.caller = CEO_USER;
    setupDraftPeriod({ period: { status: 'published' } });
    const [req, res] = makeReqRes({ query: { id: 'P1' } });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body?.status).toBe('published');
    expect(res.body?.note).toBe('已公告');
    // 沒寫任何 UPDATE / log
    expect(calls.updates.length).toBe(0);
    expect(calls.logs.length).toBe(0);
  });

  it('已 locked → 200 no-op', async () => {
    overrides.caller = CEO_USER;
    setupDraftPeriod({ period: { status: 'locked' } });
    const [req, res] = makeReqRes({ query: { id: 'P1' } });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body?.status).toBe('locked');
  });

  it('CEO + draft → 200 published + 3 筆 change_log [FORCE] + audit 補齊', async () => {
    overrides.caller = CEO_USER;
    setupDraftPeriod();
    const [req, res] = makeReqRes({ query: { id: 'P1' } });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, status: 'published', tier: 'ceo_force' });

    // 3 筆 change_log,順序 submit / approve / publish
    expect(calls.logs.length).toBe(3);
    expect(calls.logs[0].change_type).toBe('employee_submit');
    expect(calls.logs[1].change_type).toBe('manager_approve');
    expect(calls.logs[2].change_type).toBe('manager_publish');
    // 每筆 reason 都含 [FORCE]
    for (const l of calls.logs) {
      expect(l.reason).toContain('[FORCE]');
      expect(l.reason).toContain('tier=ceo_force');
      expect(l.reason).toContain('caller=C1');
      expect(l.changed_by).toBe('C1');
    }

    // UPDATE patch:audit columns 補齊
    const upd = calls.updates.find(u => u.table === 'schedule_periods');
    expect(upd?.patch.status).toBe('published');
    expect(upd?.patch.submitted_at).toBeTruthy();
    expect(upd?.patch.approved_at).toBeTruthy();
    expect(upd?.patch.approved_by).toBe('C1');
    expect(upd?.patch.published_at).toBeTruthy();
    expect(upd?.patch.published_by).toBe('C1');
  });

  it('manager 5/26 + draft → manager_force tier + 一刀 published', async () => {
    overrides.caller = SAME_DEPT_MGR;
    setupDraftPeriod();
    vi.setSystemTime(new Date('2026-05-26T00:00:00Z'));
    const [req, res] = makeReqRes({ query: { id: 'P1' } });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body?.tier).toBe('manager_force');
    expect(calls.logs[0].reason).toContain('tier=manager_force');
    vi.setSystemTime(new Date('2026-06-01T00:00:00Z'));
  });

  it('submitted period + CEO → 只跑 approve + publish 2 步', async () => {
    overrides.caller = CEO_USER;
    setupDraftPeriod({ period: { status: 'submitted', submitted_at: '2026-05-01T00:00:00Z' } });
    const [req, res] = makeReqRes({ query: { id: 'P1' } });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(calls.logs.length).toBe(2);
    expect(calls.logs[0].change_type).toBe('manager_approve');
    expect(calls.logs[1].change_type).toBe('manager_publish');
    // submitted_at 不被覆蓋(COALESCE 邏輯)
    const upd = calls.updates.find(u => u.table === 'schedule_periods');
    expect(upd?.patch.submitted_at).toBe('2026-05-01T00:00:00Z');
  });

  it('approved period + CEO → 只跑 publish 1 步、approved_by 不被覆蓋', async () => {
    overrides.caller = CEO_USER;
    setupDraftPeriod({ period: {
      status: 'approved',
      submitted_at: '2026-05-01T00:00:00Z',
      approved_at:  '2026-05-15T00:00:00Z',
      approved_by:  'M1',
    } });
    const [req, res] = makeReqRes({ query: { id: 'P1' } });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(calls.logs.length).toBe(1);
    expect(calls.logs[0].change_type).toBe('manager_publish');
    const upd = calls.updates.find(u => u.table === 'schedule_periods');
    expect(upd?.patch.approved_by).toBe('M1');
    expect(upd?.patch.published_by).toBe('C1');
  });
});
