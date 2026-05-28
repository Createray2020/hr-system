// tests/api-schedule-period-unpublish.test.js — F3 unpublish endpoint
//
// 對齊 publish.js 設計、反向版:
//   - 限 admin / chairman / 同部門主管(endpoint 層擋、不靠純函式)
//   - self-approval guard:caller.id === period.employee_id → 403
//   - canTransition published → approved (is_manager 布林、純函式 RULES 第 10 條)
//   - update SET status='approved' WHERE id=X AND status='published'
//     ⚠ published_by / published_at 保留、不在 update patch 內動(決策 4)
//   - log change_type='manager_unpublish'
//   - push 員工:'排班已撤回'
//   - 不需要 F2 守門(撤回是反向、period 早已有 schedules)

import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls = { tables: [], updates: [] };
const dataByQuery = {};
const overrides = { caller: null };

const mockLogScheduleChange = vi.fn(async () => ({}));
const mockSendPushToEmployees = vi.fn(async () => ({}));
const mockCreateNotifications = vi.fn(async () => undefined);

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
  logScheduleChange: mockLogScheduleChange,
}));

vi.mock('../lib/push.js', () => ({
  sendPushToEmployees: mockSendPushToEmployees,
  createNotifications: mockCreateNotifications,
}));

const { default: handler } = await import('../api/schedule-periods/[id]/unpublish.js');

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
  mockLogScheduleChange.mockClear();
  mockSendPushToEmployees.mockClear();
  mockCreateNotifications.mockClear();
});

const E1       = { id: 'E1',   role: 'employee', is_manager: false, dept_id: 'D1' };
const MGR      = { id: 'M1',   role: 'employee', is_manager: true,  dept_id: 'D1' };
const MGR2     = { id: 'M2',   role: 'employee', is_manager: true,  dept_id: 'D2' };
const ADMIN    = { id: 'A1',   role: 'admin',    is_manager: false, dept_id: 'D_X' };
const CHAIRMAN = { id: 'CH1',  role: 'chairman', is_manager: false, dept_id: 'D_X' };
const HR       = { id: 'HR1',  role: 'hr',       is_manager: false, dept_id: 'D_HR' };
const CEO      = { id: 'C1',   role: 'ceo',      is_manager: false, dept_id: 'D_EXEC' };

function setupPublishedPeriod(over = {}) {
  // 預設 period 已 published、period_start='2026-06-01'(給 push body 文案斷言)
  dataByQuery['schedule_periods:maybeSingle'] = {
    id: 'P1', employee_id: 'E1', status: 'published',
    period_start: '2026-06-01', period_end: '2026-06-30',
    // 決策 4:published_by / published_at 保留、撤回不清空、預設 fixture 已寫入既有 audit
    published_by: 'PREV_MGR', published_at: '2026-05-15T10:00:00.000Z',
    ...over.period,
  };
  // employees.maybeSingle:預設 employee dept=D1
  dataByQuery['employees:maybeSingle'] = { dept_id: 'D1', ...over.employee };
}

describe('/api/schedule-periods/:id/unpublish — F3 spec', () => {
  it('method GET → 405', async () => {
    overrides.caller = MGR;
    const [req, res] = makeReqRes({ method: 'GET', query: { id: 'P1' } });
    await handler(req, res);
    expect(res.statusCode).toBe(405);
  });

  it('無 auth → 401', async () => {
    const [req, res] = makeReqRes({ query: { id: 'P1' } });
    await handler(req, res);
    expect(res.statusCode).toBe(401);
  });

  it('沒帶 id → 400', async () => {
    overrides.caller = MGR;
    const [req, res] = makeReqRes({ query: {} });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
  });

  it('period 找不到 → 404', async () => {
    overrides.caller = MGR;
    // 不 setup、period:maybeSingle 預設 null
    const [req, res] = makeReqRes({ query: { id: 'P_404' } });
    await handler(req, res);
    expect(res.statusCode).toBe(404);
  });

  it('self-approval(caller.id === period.employee_id)→ 403 CANNOT_UNPUBLISH_OWN_PERIOD', async () => {
    // 即使 caller 是同部門主管、撤回自己的 period 仍擋(對齊 publish.js)
    overrides.caller = { ...E1, is_manager: true };
    setupPublishedPeriod();
    const [req, res] = makeReqRes({ query: { id: 'P1' } });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
    expect(res.body?.error).toBe('CANNOT_UNPUBLISH_OWN_PERIOD');
  });

  it('admin → 200(即使非該部門)', async () => {
    overrides.caller = ADMIN;  // dept=D_X、跟 period employee 的 D1 不同
    setupPublishedPeriod();
    const [req, res] = makeReqRes({ query: { id: 'P1' } });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    const upd = calls.updates.find(u => u.table === 'schedule_periods');
    expect(upd?.patch.status).toBe('approved');
  });

  it('chairman → 200(即使非該部門)', async () => {
    overrides.caller = CHAIRMAN;
    setupPublishedPeriod();
    const [req, res] = makeReqRes({ query: { id: 'P1' } });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    const upd = calls.updates.find(u => u.table === 'schedule_periods');
    expect(upd?.patch.status).toBe('approved');
  });

  it('同部門主管 → 200 + audit log(manager_unpublish)+ push 員工', async () => {
    overrides.caller = MGR;
    setupPublishedPeriod();
    const [req, res] = makeReqRes({ query: { id: 'P1' } });
    await handler(req, res);
    expect(res.statusCode).toBe(200);

    // status 翻回 approved
    const upd = calls.updates.find(u => u.table === 'schedule_periods');
    expect(upd?.patch.status).toBe('approved');

    // audit log change_type='manager_unpublish' + changed_by=caller.id
    expect(mockLogScheduleChange).toHaveBeenCalledTimes(1);
    const logArg = mockLogScheduleChange.mock.calls[0][1];
    expect(logArg.change_type).toBe('manager_unpublish');
    expect(logArg.changed_by).toBe('M1');
    expect(logArg.before_data).toEqual({ status: 'published' });
    expect(logArg.after_data).toEqual({ status: 'approved' });

    // push 員工
    expect(mockSendPushToEmployees).toHaveBeenCalled();
    expect(mockCreateNotifications).toHaveBeenCalled();
  });

  it('跨部門 manager → 403 NOT_AUTHORIZED(只允許 admin/chairman/同部門主管)', async () => {
    overrides.caller = MGR2;  // dept=D2、period employee dept=D1
    setupPublishedPeriod();
    const [req, res] = makeReqRes({ query: { id: 'P1' } });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
    expect(res.body?.error).toBe('NOT_AUTHORIZED');
  });

  it('HR(role=hr、is_manager=false)→ 403 NOT_AUTHORIZED(HR 不在 allowlist)', async () => {
    // F3 spec 撤回限 admin/chairman/同部門主管,HR 不在其中
    overrides.caller = HR;
    setupPublishedPeriod();
    const [req, res] = makeReqRes({ query: { id: 'P1' } });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
    expect(res.body?.error).toBe('NOT_AUTHORIZED');
  });

  it('CEO(role=ceo、is_manager=false)→ 403 NOT_AUTHORIZED(CEO 不在 allowlist、只 chairman 可)', async () => {
    overrides.caller = CEO;
    setupPublishedPeriod();
    const [req, res] = makeReqRes({ query: { id: 'P1' } });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
    expect(res.body?.error).toBe('NOT_AUTHORIZED');
  });

  it('一般員工(非自己)→ 403 NOT_AUTHORIZED', async () => {
    overrides.caller = { id: 'E2', role: 'employee', is_manager: false, dept_id: 'D1' };
    setupPublishedPeriod();
    const [req, res] = makeReqRes({ query: { id: 'P1' } });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
    expect(res.body?.error).toBe('NOT_AUTHORIZED');
  });

  it('非 published 狀態(approved)→ 409 ILLEGAL_TRANSITION(對齊 RULES)', async () => {
    overrides.caller = MGR;
    setupPublishedPeriod({ period: { status: 'approved' } });
    const [req, res] = makeReqRes({ query: { id: 'P1' } });
    await handler(req, res);
    expect(res.statusCode).toBe(409);
  });

  it('非 published 狀態(locked)→ 409 ILLEGAL_TRANSITION(鎖月後不可撤回)', async () => {
    overrides.caller = MGR;
    setupPublishedPeriod({ period: { status: 'locked' } });
    const [req, res] = makeReqRes({ query: { id: 'P1' } });
    await handler(req, res);
    expect(res.statusCode).toBe(409);
  });

  it('決策 4:200 時 update patch 不含 published_by / published_at(保留既有 audit)', async () => {
    overrides.caller = MGR;
    setupPublishedPeriod();
    const [req, res] = makeReqRes({ query: { id: 'P1' } });
    await handler(req, res);
    expect(res.statusCode).toBe(200);

    const upd = calls.updates.find(u => u.table === 'schedule_periods');
    expect(upd).toBeDefined();
    // 重點:patch 內只有 status,沒動 published_by / published_at
    expect(upd.patch).not.toHaveProperty('published_by');
    expect(upd.patch).not.toHaveProperty('published_at');
    expect(upd.patch.status).toBe('approved');
  });

  it('員工 push payload 含「撤回」字樣 + 用 schedule-unpublished tag(不覆蓋 publish 通知)', async () => {
    overrides.caller = MGR;
    setupPublishedPeriod();
    const [req, res] = makeReqRes({ query: { id: 'P1' } });
    await handler(req, res);
    expect(res.statusCode).toBe(200);

    // sendPushToEmployees(employeeIds, payload)
    expect(mockSendPushToEmployees).toHaveBeenCalled();
    const [empIds, payload] = mockSendPushToEmployees.mock.calls[0];
    expect(empIds).toEqual(['E1']);   // 通知該 period 的員工
    expect(payload.title).toMatch(/撤回/);
    expect(payload.body).toMatch(/撤回/);
    expect(payload.body).toMatch(/2026-06-01/);   // period_start 入 body
    expect(payload.tag).toBe('schedule-unpublished-P1');
    // Web Push tag 用完全相等比對、不是 substring/regex,所以 'schedule-unpublished-X'
    // 跟 'schedule-published-X' 是兩個獨立 tag、不會互相覆蓋
    expect(payload.tag).not.toBe(`schedule-published-P1`);
    expect(payload.url).toBe('/employee-schedule.html');
  });

  it('偽造 body.changed_by → 仍寫 caller.id', async () => {
    overrides.caller = MGR;
    setupPublishedPeriod();
    const [req, res] = makeReqRes({
      query: { id: 'P1' },
      body: { changed_by: 'FAKE_MGR' },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    const logArg = mockLogScheduleChange.mock.calls[0][1];
    expect(logArg.changed_by).toBe('M1');
    expect(logArg.changed_by).not.toBe('FAKE_MGR');
  });
});
