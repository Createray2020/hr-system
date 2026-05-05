// tests/cron-absence-detection.test.js — repo SQL filter 驗證
//
// 重點:findLockedSchedulesByDate 必須 JOIN shift_types 並過濾 is_off=true、
// 否則 cron 會把例假 / 休假 / 國假寫成 absent(prod 5/3 已踩過、52 筆受害)。
//
// 策略:mock lib/supabase.js、攔截 .from('schedules').select(...).eq(...).eq(...) 鏈式呼叫、
// 斷言:
//   - select 字串含 'shift_types!inner(is_off)'
//   - .eq 被呼叫兩次:('work_date', date) + ('shift_types.is_off', false)
//
// 不驗 PG 真的會做 JOIN(那是 supabase-js + PG 的事、Phase 跨層整合測試是 prod e2e)、
// 只驗 SQL chain 帶對 filter、避免未來重構誤刪 .eq('shift_types.is_off', false)。

import { describe, it, expect, vi, beforeEach } from 'vitest';

// 累積 supabase chain 呼叫紀錄
const calls = { tables: [], selects: [], eqs: [], inResults: [] };

vi.mock('../lib/supabase.js', () => {
  function chain(table) {
    const c = {};
    c.select = vi.fn((str) => { calls.selects.push({ table, str }); return c; });
    c.eq = vi.fn((col, val) => { calls.eqs.push({ table, col, val }); return c; });
    c.in = vi.fn((col, vals) => { calls.inResults.push({ table, col, vals }); return c; });
    c.order = vi.fn(() => c);
    c.limit = vi.fn(() => c);
    c.maybeSingle = vi.fn(() => Promise.resolve({ data: null, error: null }));
    c.single = vi.fn(() => Promise.resolve({ data: null, error: null }));
    // thenable for `await q` — 預設回空陣列、避免後續 chain 邏輯炸
    c.then = (onF, onR) => Promise.resolve({ data: [], error: null }).then(onF, onR);
    return c;
  }
  const client = {
    from: vi.fn((table) => { calls.tables.push(table); return chain(table); }),
  };
  return { supabase: client, supabaseAdmin: client };
});

vi.mock('../lib/cron-auth.js', () => ({
  requireCron: vi.fn(() => true),
}));
vi.mock('../lib/push.js', () => ({
  sendPushToEmployees: vi.fn(async () => ({ sent: 0 })),
  sendPushToRoles:     vi.fn(async () => ({ sent: 0 })),
  createNotification:  vi.fn(async () => undefined),
  createNotificationsForRoles: vi.fn(async () => undefined),
}));

// import 在 mock 之後
const { default: handler } = await import('../api/cron-absence-detection.js');

function makeReqRes(query = {}) {
  const res = {
    statusCode: 200, body: undefined,
    status(c) { this.statusCode = c; return this; },
    json(p)   { this.body = p; return this; },
  };
  return [{ method: 'GET', query, headers: {} }, res];
}

beforeEach(() => {
  calls.tables = []; calls.selects = []; calls.eqs = []; calls.inResults = [];
});

describe('cron-absence-detection findLockedSchedulesByDate — SQL filter chain', () => {
  it('SELECT 字串含 shift_types!inner(is_off) JOIN', async () => {
    const [req, res] = makeReqRes({ today: '2026-05-04' });
    await handler(req, res);

    const scheduleSelect = calls.selects.find(s => s.table === 'schedules');
    expect(scheduleSelect).toBeDefined();
    expect(scheduleSelect.str).toContain('shift_types!inner');
    expect(scheduleSelect.str).toContain('is_off');
  });

  it('eq 被呼叫:work_date=yesterday + shift_types.is_off=false', async () => {
    const [req, res] = makeReqRes({ today: '2026-05-04' });  // sweep 5/3
    await handler(req, res);

    // schedules 表上的 .eq calls
    const scheduleEqs = calls.eqs.filter(e => e.table === 'schedules');

    // work_date filter
    const workDateEq = scheduleEqs.find(e => e.col === 'work_date');
    expect(workDateEq).toBeDefined();
    expect(workDateEq.val).toBe('2026-05-03');

    // is_off=false filter (這是修補的核心、絕對不能 regression 拿掉)
    const isOffEq = scheduleEqs.find(e => e.col === 'shift_types.is_off');
    expect(isOffEq).toBeDefined();
    expect(isOffEq.val).toBe(false);
  });

  it('handler 回 200 ok(SQL filter 沒帶錯不 throw)', async () => {
    const [req, res] = makeReqRes({ today: '2026-05-04' });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ ok: true, today: '2026-05-04' });
  });
});
