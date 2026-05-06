// tests/api-attendance-routing.test.js — Phase Attendance dead-code regression
//
// 重點:
//   1. ?_action=punch legacy(已拔、commit XXX)→ 4xx,防 revive
//   2. manual punch shape body { employee_id, work_date, clock_in_time }(已拔、commit YYY)→ 4xx
//   3. 新 path body { action: 'clock_in'|'clock_out' } → handleNewPunch 仍 work
//
// 策略:mock supabase + auth、攔 chain calls、不依賴 lib/attendance/clock.js 跑完整 flow。

import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls = { tables: [], inserts: [], updates: [] };
const dataByTable = {};

vi.mock('../lib/supabase.js', () => {
  function chain(table) {
    const c = {};
    c.select = vi.fn(() => c);
    c.eq = vi.fn(() => c);
    c.in = vi.fn(() => c);
    c.is = vi.fn(() => c);
    c.not = vi.fn(() => c);
    c.gte = vi.fn(() => c); c.lte = vi.fn(() => c);
    c.order = vi.fn(() => c); c.limit = vi.fn(() => c);
    c.update = vi.fn((patch) => { calls.updates.push({ table, patch }); return c; });
    c.insert = vi.fn((rows) => { calls.inserts.push({ table, rows }); return c; });
    c.upsert = vi.fn((rows) => { calls.inserts.push({ table, rows, upsert: true }); return c; });
    c.maybeSingle = vi.fn(() => Promise.resolve({
      data: dataByTable[`${table}:maybeSingle`] ?? null, error: null,
    }));
    c.single = vi.fn(() => Promise.resolve({
      data: dataByTable[`${table}:single`] ?? null,
      error: dataByTable[`${table}:single`] ? null : { code: 'PGRST116' },
    }));
    c.then = (onF, onR) => Promise.resolve({
      data: dataByTable[table] ?? [], error: null,
    }).then(onF, onR);
    return c;
  }
  const client = { from: vi.fn((table) => { calls.tables.push(table); return chain(table); }) };
  return { supabase: client, supabaseAdmin: client };
});

vi.mock('../lib/auth.js', () => ({
  requireAuth: vi.fn(async () => ({ id: 'E001', role: 'employee', is_manager: false, dept_id: 'D1' })),
  requireRole: vi.fn(async () => ({ id: 'E001', role: 'employee', is_manager: false, dept_id: 'D1' })),
}));

vi.mock('../lib/dept-name-mapper.js', () => ({
  addDeptName: vi.fn(),
  addDeptNameSingle: vi.fn(),
}));

const { default: handler } = await import('../api/attendance/index.js');

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
  calls.tables = []; calls.inserts = []; calls.updates = [];
  for (const k of Object.keys(dataByTable)) delete dataByTable[k];
});

describe('api/attendance routing — dead-code regression', () => {
  it('?_action=punch legacy → 4xx(已拔、防 revive)', async () => {
    const [req, res] = makeReqRes({
      query: { _action: 'punch' },
      body: { employee_id: 'E001', type: 'in' },
    });
    await handler(req, res);
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
    // 不該寫進 attendance(legacy path 已不執行 INSERT/UPDATE)
    expect(calls.inserts.filter(i => i.table === 'attendance').length).toBe(0);
    expect(calls.updates.filter(u => u.table === 'attendance').length).toBe(0);
  });

  it('manual punch shape body { employee_id, work_date, clock_in_time } → 4xx(已拔、防 revive 安全洞)', async () => {
    const [req, res] = makeReqRes({
      body: {
        employee_id: 'E_VICTIM',
        work_date: '2026-05-07',
        clock_in_time: '09:00',
        clock_out_time: '18:00',
      },
    });
    await handler(req, res);
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
    expect(res.body?.error).toBe('INVALID_ACTION');
    // 守:不該寫進 attendance(原 dead code 沒 auth 會直接 INSERT/UPDATE)
    expect(calls.inserts.filter(i => i.table === 'attendance').length).toBe(0);
    expect(calls.updates.filter(u => u.table === 'attendance').length).toBe(0);
  });

  it('新 path body { action: \'clock_in\' } 仍正常 work(不被 legacy 拔影響)', async () => {
    // 新 path 走 handleNewPunch → lib clockIn:
    // 預期會撈 schedules、撈 holiday、upsert attendance
    // mock 預設 schedules=[]、會拋 NoScheduleError → 400 NO_SCHEDULE
    // 重點:status 不是 4xx GONE / INVALID_ACTION,而是 lib 的 NO_SCHEDULE(代表 path 有走到 lib)
    const [req, res] = makeReqRes({ body: { action: 'clock_in' } });
    await handler(req, res);
    expect(res.body?.error).toBe('NO_SCHEDULE');  // 走到 lib 才會回這個
  });
});
