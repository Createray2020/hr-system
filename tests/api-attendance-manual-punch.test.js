// tests/api-attendance-manual-punch.test.js — 多段班 manual punch lookup 修補
//
// 重點:api/attendance/index.js 人工補登原本死取 segment_no=1、
// 多段班員工 14:00 補登第二段時誤用第一段算 late=6h(誤判遲到 6 小時)。
// 修補:重用 lib/attendance/clock.js::pickSegmentForClockIn、跟即時打卡同算法。
//
// 策略:mock supabase chain、攔截 .from('schedules').select / .from('attendance').upsert + insert 的 row,
//      斷言 schedule_id / segment_no 寫對 + late_minutes 算對。

import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls = { tables: [], inserts: [], updates: [] };
// 控制 SELECT 回傳:per-table 指定 data,沒指定 → 預設空 array
const dataByTable = {};

vi.mock('../lib/supabase.js', () => {
  function chain(table) {
    const c = {};
    c.select = vi.fn(() => c);
    c.eq = vi.fn(() => c);
    c.gte = vi.fn(() => c); c.lte = vi.fn(() => c);
    c.in = vi.fn(() => c);
    c.order = vi.fn(() => c);
    c.limit = vi.fn(() => c);
    c.update = vi.fn((patch) => { calls.updates.push({ table, patch }); return c; });
    c.insert = vi.fn((rows) => { calls.inserts.push({ table, rows }); return c; });
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
  const client = {
    from: vi.fn((table) => { calls.tables.push(table); return chain(table); }),
  };
  return { supabase: client, supabaseAdmin: client };
});

vi.mock('../lib/auth.js', () => ({
  requireAuth: vi.fn(async () => ({ id: 'HR1', role: 'hr', is_manager: false })),
  requireRole: vi.fn(async () => ({ id: 'HR1', role: 'hr', is_manager: false })),
}));

vi.mock('../lib/dept-name-mapper.js', () => ({
  addDeptName: vi.fn(),
  addDeptNameSingle: vi.fn(),
}));

const { default: handler } = await import('../api/attendance/index.js');

function makeReq(body) {
  return { method: 'POST', query: {}, body, headers: {} };
}
function makeRes() {
  return {
    statusCode: 200, body: undefined,
    status(c) { this.statusCode = c; return this; },
    json(p)   { this.body = p; return this; },
  };
}

beforeEach(() => {
  calls.tables = []; calls.inserts = []; calls.updates = [];
  for (const k of Object.keys(dataByTable)) delete dataByTable[k];
});

describe('api/attendance manual punch — 多段班 segment lookup', () => {
  const seg1 = { id: 'S1', segment_no: 1, start_time: '09:00', end_time: '12:00',
                 crosses_midnight: false, scheduled_work_minutes: 180 };
  const seg2 = { id: 'S2', segment_no: 2, start_time: '14:00', end_time: '18:00',
                 crosses_midnight: false, scheduled_work_minutes: 240 };

  it('多段班 14:00 補登 → 寫進 schedule_id=S2 + segment_no=2、late=0(原本誤算 late=300)', async () => {
    dataByTable.schedules = [seg1, seg2];
    // 既有 row 不存在 → 走 insert
    const res = makeRes();
    await handler(makeReq({
      employee_id: 'E001', work_date: '2026-04-26',
      clock_in_time: '14:00', clock_out_time: '18:00',
    }), res);

    expect(res.statusCode).toBe(201);
    const ins = calls.inserts.find(i => i.table === 'attendance');
    expect(ins).toBeDefined();
    const row = ins.rows[0];
    expect(row.schedule_id).toBe('S2');
    expect(row.segment_no).toBe(2);
    expect(row.late_minutes).toBe(0);          // 14:00 ≤ seg2.start_time → 不遲到
    expect(row.early_leave_minutes).toBe(0);   // 18:00 = seg2.end_time → 不早退
    expect(row.status).toBe('normal');
  });

  it('多段班 09:00 補登 → 寫進 segment 1(行為 regression、第一段仍正確)', async () => {
    dataByTable.schedules = [seg1, seg2];
    const res = makeRes();
    await handler(makeReq({
      employee_id: 'E001', work_date: '2026-04-26',
      clock_in_time: '09:00', clock_out_time: '12:00',
    }), res);

    const ins = calls.inserts.find(i => i.table === 'attendance');
    expect(ins.rows[0].schedule_id).toBe('S1');
    expect(ins.rows[0].segment_no).toBe(1);
    expect(ins.rows[0].late_minutes).toBe(0);
  });

  it('多段班 14:30 補登(seg2 內遲到 30min)→ schedule=S2、late=30', async () => {
    dataByTable.schedules = [seg1, seg2];
    const res = makeRes();
    await handler(makeReq({
      employee_id: 'E001', work_date: '2026-04-26',
      clock_in_time: '14:30', clock_out_time: '18:00',
    }), res);

    const ins = calls.inserts.find(i => i.table === 'attendance');
    expect(ins.rows[0].schedule_id).toBe('S2');
    expect(ins.rows[0].segment_no).toBe(2);
    expect(ins.rows[0].late_minutes).toBe(30);
    expect(ins.rows[0].status).toBe('late');
  });

  it('單段班 09:00 補登 → 行為跟舊版一致(regression 守、segment lookup 不影響單段)', async () => {
    dataByTable.schedules = [seg1];
    const res = makeRes();
    await handler(makeReq({
      employee_id: 'E001', work_date: '2026-04-26',
      clock_in_time: '09:00', clock_out_time: '12:00',
    }), res);

    const ins = calls.inserts.find(i => i.table === 'attendance');
    expect(ins.rows[0].schedule_id).toBe('S1');
    expect(ins.rows[0].segment_no).toBe(1);
    expect(ins.rows[0].late_minutes).toBe(0);
  });

  it('沒 schedule(legacy 員工 / 沒排班那天)→ schedule_id 不寫入、status=fallback normal', async () => {
    dataByTable.schedules = [];
    const res = makeRes();
    await handler(makeReq({
      employee_id: 'E001', work_date: '2026-04-26',
      clock_in_time: '14:00', clock_out_time: '18:00',
    }), res);

    expect(res.statusCode).toBe(201);
    const ins = calls.inserts.find(i => i.table === 'attendance');
    expect(ins.rows[0].schedule_id).toBeUndefined();
    expect(ins.rows[0].segment_no).toBeUndefined();
    expect(ins.rows[0].late_minutes).toBe(0);
    expect(ins.rows[0].early_leave_minutes).toBe(0);
  });
});
