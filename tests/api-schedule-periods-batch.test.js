// tests/api-schedule-periods-batch.test.js — 批次建 period 權限分支 + idempotent 行為
//
// 覆蓋:
//   1. 無 auth → 401
//   2. 純員工 → 403 NOT_MANAGER_OR_HR
//   3. 主管 → 鎖自己 dept_id、忽略 body.dept_id
//   4. HR 帶 dept_id → 用該 dept
//   5. HR 不帶 dept_id → 全公司 active
//   6. 已存在者 → skipped_existing、upsert 只送未存在者
//   7. month/year invalid → 400 INVALID_PERIOD

import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls = { tables: [], eqs: [], ins: [], upserts: [] };
const dataByQuery = {};
const overrides = { caller: null };

vi.mock('../lib/supabase.js', () => {
  function chain(table) {
    const c = {};
    let isWriteOp = false;
    c.select = vi.fn(() => c);
    c.eq = vi.fn((col, val) => { calls.eqs.push({ table, col, val }); return c; });
    c.in = vi.fn((col, vals) => { calls.ins.push({ table, col, vals }); return c; });
    c.neq = vi.fn(() => c);
    c.upsert = vi.fn((rows, opts) => {
      isWriteOp = true;
      calls.upserts.push({ table, rows, opts });
      return c;
    });
    c.then = (onFulfilled, onRejected) => {
      if (isWriteOp) {
        return Promise.resolve({ data: null, error: null }).then(onFulfilled, onRejected);
      }
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

const { default: handler } = await import('../api/schedule-periods/batch.js');

function makeReqRes({ method = 'POST', body = {} } = {}) {
  const res = {
    statusCode: 200, body: undefined,
    status(c) { this.statusCode = c; return this; },
    json(p)   { this.body = p; return this; },
    end()     { return this; },
  };
  return [{ method, body, headers: {} }, res];
}

beforeEach(() => {
  calls.tables = []; calls.eqs = []; calls.ins = []; calls.upserts = [];
  for (const k of Object.keys(dataByQuery)) delete dataByQuery[k];
  overrides.caller = null;
});

const E1   = { id: 'E1',  role: 'employee', is_manager: false, dept_id: 'D1' };
const MGR  = { id: 'M1',  role: 'employee', is_manager: true,  dept_id: 'D1' };
const HR   = { id: 'HR1', role: 'hr',       is_manager: false, dept_id: 'D_HR' };

describe('POST /api/schedule-periods/batch', () => {
  it('無 auth → 401', async () => {
    const [req, res] = makeReqRes({ body: { year: 2026, month: 6 } });
    await handler(req, res);
    expect(res.statusCode).toBe(401);
  });

  it('純員工 → 403 NOT_MANAGER_OR_HR', async () => {
    overrides.caller = E1;
    const [req, res] = makeReqRes({ body: { year: 2026, month: 6 } });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
    expect(res.body?.error).toBe('NOT_MANAGER_OR_HR');
  });

  it('month/year invalid → 400 INVALID_PERIOD', async () => {
    overrides.caller = MGR;
    const [req, res] = makeReqRes({ body: { year: 2026, month: 13 } });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body?.error).toBe('INVALID_PERIOD');
  });

  it('主管 → 鎖自己 dept_id、忽略 body.dept_id', async () => {
    overrides.caller = MGR;
    dataByQuery['employees:list'] = [{ id: 'E1' }, { id: 'E2' }];
    dataByQuery['schedule_periods:list'] = []; // 都還沒建
    const [req, res] = makeReqRes({ body: { year: 2026, month: 6, dept_id: 'D_OTHER' } });
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    // 員工查詢用 caller.dept_id='D1'、不是 body.dept_id='D_OTHER'
    const empDeptEq = calls.eqs.find(e => e.table === 'employees' && e.col === 'dept_id');
    expect(empDeptEq?.val).toBe('D1');
    expect(res.body.created).toEqual(['E1', 'E2']);
    expect(res.body.skipped_existing).toEqual([]);
    expect(res.body.total).toBe(2);
    // upsert 兩筆、row 形狀對齊 index.js
    expect(calls.upserts.length).toBe(1);
    expect(calls.upserts[0].rows.length).toBe(2);
    expect(calls.upserts[0].rows[0]).toMatchObject({
      id: 's_period_E1_2026_06',
      employee_id: 'E1',
      period_year: 2026, period_month: 6,
      period_start: '2026-06-01', period_end: '2026-06-30',
      status: 'draft',
      start_date: '2026-06-01', end_date: '2026-06-30',
      created_by: 'M1',
    });
    expect(calls.upserts[0].opts).toMatchObject({
      onConflict: 'employee_id,period_year,period_month',
      ignoreDuplicates: true,
    });
  });

  it('HR 帶 dept_id → 用該 dept', async () => {
    overrides.caller = HR;
    dataByQuery['employees:list'] = [{ id: 'A1' }];
    dataByQuery['schedule_periods:list'] = [];
    const [req, res] = makeReqRes({ body: { year: 2026, month: 7, dept_id: 'D9' } });
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    const empDeptEq = calls.eqs.find(e => e.table === 'employees' && e.col === 'dept_id');
    expect(empDeptEq?.val).toBe('D9');
    expect(res.body.created).toEqual(['A1']);
  });

  it('HR 不帶 dept_id → 全公司 active(不對 employees 下 dept_id eq)', async () => {
    overrides.caller = HR;
    dataByQuery['employees:list'] = [{ id: 'X1' }, { id: 'X2' }, { id: 'X3' }];
    dataByQuery['schedule_periods:list'] = [];
    const [req, res] = makeReqRes({ body: { year: 2026, month: 6 } });
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    const empDeptEq = calls.eqs.find(e => e.table === 'employees' && e.col === 'dept_id');
    expect(empDeptEq).toBeUndefined();
    // employees 查詢應有 status=active
    const empStatusEq = calls.eqs.find(e => e.table === 'employees' && e.col === 'status');
    expect(empStatusEq?.val).toBe('active');
    expect(res.body.created).toEqual(['X1', 'X2', 'X3']);
    expect(res.body.total).toBe(3);
  });

  it('已存在者 → skipped_existing、upsert 只送未存在者', async () => {
    overrides.caller = MGR;
    dataByQuery['employees:list'] = [{ id: 'E1' }, { id: 'E2' }, { id: 'E3' }];
    dataByQuery['schedule_periods:list'] = [{ employee_id: 'E2' }];
    const [req, res] = makeReqRes({ body: { year: 2026, month: 6 } });
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.created).toEqual(['E1', 'E3']);
    expect(res.body.skipped_existing).toEqual(['E2']);
    expect(res.body.total).toBe(3);
    // upsert 只送 E1、E3
    const ids = calls.upserts[0].rows.map(r => r.employee_id);
    expect(ids).toEqual(['E1', 'E3']);
  });

  it('全員都已存在 → 不呼叫 upsert', async () => {
    overrides.caller = MGR;
    dataByQuery['employees:list'] = [{ id: 'E1' }, { id: 'E2' }];
    dataByQuery['schedule_periods:list'] = [{ employee_id: 'E1' }, { employee_id: 'E2' }];
    const [req, res] = makeReqRes({ body: { year: 2026, month: 6 } });
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.created).toEqual([]);
    expect(res.body.skipped_existing).toEqual(['E1', 'E2']);
    expect(res.body.total).toBe(2);
    expect(calls.upserts.length).toBe(0);
  });

  it('部門無 active 員工 → total=0、不查 schedule_periods、不 upsert', async () => {
    overrides.caller = MGR;
    dataByQuery['employees:list'] = [];
    const [req, res] = makeReqRes({ body: { year: 2026, month: 6 } });
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.total).toBe(0);
    expect(res.body.created).toEqual([]);
    expect(calls.upserts.length).toBe(0);
  });
});
