// tests/api-resigned-archive.test.js — Phase 1.7 MVP 離職員工檔案 endpoint
//
// 重點:
//   1. role gate hr/admin/ceo/chairman OK、一般員工 / 主管 → 403
//   2. 列表 SQL chain 正確(.eq('status', 'resigned') + .order resigned_at DESC)
//   3. Detail SQL 多 source 平行撈、用 resigned_at 倒推 6 個月時間範圍
//   4. employee.status !== 'resigned' → 400(在職員工不該走這個 endpoint)

import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls = { tables: [], selects: [], eqs: [], gtes: [], ltes: [], orders: [] };
const dataByTable = {};
const dataByQuery = {};   // 'employees:single' 用、控制 detail 的員工 row 回傳
const overrides = { caller: null };

vi.mock('../lib/supabase.js', () => {
  function chain(table) {
    const c = {};
    c.select = vi.fn((str) => { calls.selects.push({ table, str }); return c; });
    c.eq = vi.fn((col, val) => { calls.eqs.push({ table, col, val }); return c; });
    c.gte = vi.fn((col, val) => { calls.gtes.push({ table, col, val }); return c; });
    c.lte = vi.fn((col, val) => { calls.ltes.push({ table, col, val }); return c; });
    c.order = vi.fn((col, opts) => { calls.orders.push({ table, col, opts }); return c; });
    c.limit = vi.fn(() => c);
    c.in = vi.fn(() => c);
    c.is = vi.fn(() => c);    // 對齊 8c44806 soft-delete 加的 .is('deleted_at', null) filter
    c.maybeSingle = vi.fn(() => Promise.resolve({
      data: dataByQuery[`${table}:maybeSingle`] ?? null, error: null,
    }));
    c.single = vi.fn(() => Promise.resolve({
      data: dataByQuery[`${table}:single`] ?? null, error: null,
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
  requireAuth: vi.fn(async (req, res) => {
    if (!overrides.caller) { res.status(401).json({ error: 'Unauthorized' }); return null; }
    return overrides.caller;
  }),
  requireRole: vi.fn(async (req, res, allowedRoles) => {
    if (!overrides.caller) { res.status(401).json({ error: 'Unauthorized' }); return null; }
    if (!allowedRoles.includes(overrides.caller.role)) {
      res.status(403).json({ error: 'Forbidden' });
      return null;
    }
    return overrides.caller;
  }),
}));

vi.mock('../lib/dept-name-mapper.js', () => ({
  addDeptName: vi.fn(),
  addDeptNameSingle: vi.fn(),
}));

const { default: handler } = await import('../api/resigned-archive.js');

function makeReqRes({ query = {} } = {}) {
  const res = {
    statusCode: 200, body: undefined,
    status(c) { this.statusCode = c; return this; },
    json(p)   { this.body = p; return this; },
    end()     { return this; },
  };
  return [{ method: 'GET', query, headers: {} }, res];
}

beforeEach(() => {
  calls.tables = []; calls.selects = []; calls.eqs = [];
  calls.gtes = []; calls.ltes = []; calls.orders = [];
  for (const k of Object.keys(dataByTable)) delete dataByTable[k];
  for (const k of Object.keys(dataByQuery)) delete dataByQuery[k];
  overrides.caller = null;
});

const HR        = { id: 'HR1', role: 'hr',       is_manager: false, dept_id: 'D_HR' };
const ADMIN     = { id: 'A1',  role: 'admin',    is_manager: false, dept_id: 'D_HR' };
const CEO       = { id: 'C1',  role: 'ceo',      is_manager: false, dept_id: 'D_EXEC' };
const CHAIRMAN  = { id: 'CH1', role: 'chairman', is_manager: false, dept_id: 'D_EXEC' };
const MGR       = { id: 'M1',  role: 'employee', is_manager: true,  dept_id: 'D1' };
const EMP       = { id: 'E1',  role: 'employee', is_manager: false, dept_id: 'D1' };

// ════════════════════════════════════════════════════════════
// Role gate
// ════════════════════════════════════════════════════════════
describe('/api/resigned-archive — role gate', () => {
  it('未登入 → 401', async () => {
    const [req, res] = makeReqRes();
    await handler(req, res);
    expect(res.statusCode).toBe(401);
  });

  it('一般員工 → 403', async () => {
    overrides.caller = EMP;
    const [req, res] = makeReqRes();
    await handler(req, res);
    expect(res.statusCode).toBe(403);
  });

  it('一般主管(is_manager=true、role=employee)→ 403(離職資料涉個資、純 backoffice)', async () => {
    overrides.caller = MGR;
    const [req, res] = makeReqRes();
    await handler(req, res);
    expect(res.statusCode).toBe(403);
  });

  it('HR → 200', async () => {
    overrides.caller = HR;
    const [req, res] = makeReqRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
  });

  it('admin → 200', async () => {
    overrides.caller = ADMIN;
    const [req, res] = makeReqRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
  });

  it('CEO → 200', async () => {
    overrides.caller = CEO;
    const [req, res] = makeReqRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
  });

  it('chairman → 200', async () => {
    overrides.caller = CHAIRMAN;
    const [req, res] = makeReqRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
  });
});

// ════════════════════════════════════════════════════════════
// 非 GET method
// ════════════════════════════════════════════════════════════
describe('/api/resigned-archive — method 限定 GET', () => {
  it('POST → 405', async () => {
    overrides.caller = HR;
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(p)   { this.body = p; return this; },
    };
    await handler({ method: 'POST', query: {}, headers: {} }, res);
    expect(res.statusCode).toBe(405);
  });
});

// ════════════════════════════════════════════════════════════
// 列表 SQL chain
// ════════════════════════════════════════════════════════════
describe('/api/resigned-archive — 列表 SQL chain', () => {
  it('SELECT employees + .eq(status, resigned) + .order(resigned_at DESC)', async () => {
    overrides.caller = HR;
    const [req, res] = makeReqRes();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(calls.tables).toContain('employees');
    const statusEq = calls.eqs.find(e => e.table === 'employees' && e.col === 'status');
    expect(statusEq?.val).toBe('resigned');
    const resignedOrder = calls.orders.find(o => o.table === 'employees' && o.col === 'resigned_at');
    expect(resignedOrder).toBeDefined();
    expect(resignedOrder.opts.ascending).toBe(false);
  });

  it('回傳 200 + array(空 list 也 OK)', async () => {
    overrides.caller = HR;
    const [req, res] = makeReqRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════
// Detail SQL chain + 6 個月時間範圍
// ════════════════════════════════════════════════════════════
describe('/api/resigned-archive?id=X — detail SQL chain', () => {
  it('員工 status !== resigned → 400(在職員工不該走 archive)', async () => {
    overrides.caller = HR;
    dataByQuery['employees:maybeSingle'] = { id: 'E_active', status: 'active', name: 'Alice' };
    const [req, res] = makeReqRes({ query: { id: 'E_active' } });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body?.error).toMatch(/not resigned/);
  });

  it('員工不存在 → 404', async () => {
    overrides.caller = HR;
    dataByQuery['employees:maybeSingle'] = null;
    const [req, res] = makeReqRes({ query: { id: 'E_404' } });
    await handler(req, res);
    expect(res.statusCode).toBe(404);
  });

  it('離職員工 detail → 撈 5 個 history source、6 個月時間範圍正確', async () => {
    overrides.caller = HR;
    dataByQuery['employees:maybeSingle'] = {
      id: 'E_resigned',
      status: 'resigned',
      name: 'Bob',
      resigned_at: '2026-04-01T00:00:00.000Z',  // 倒推 6 個月 → 2025-10-01
      hire_date: '2023-01-01',
    };
    const [req, res] = makeReqRes({ query: { id: 'E_resigned' } });
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.employee.id).toBe('E_resigned');
    expect(res.body.history).toBeDefined();
    expect(res.body.history.window.end.startsWith('2026-04')).toBe(true);
    expect(res.body.history.window.start.startsWith('2025-10')).toBe(true);

    // 撈了 5 個 history table
    expect(calls.tables).toContain('salary_records');
    expect(calls.tables).toContain('attendance');
    expect(calls.tables).toContain('leave_requests');
    expect(calls.tables).toContain('overtime_requests');
    expect(calls.tables).toContain('comp_time_balance');

    // employee_id filter 都套到位
    const salaryEq    = calls.eqs.find(e => e.table === 'salary_records' && e.col === 'employee_id');
    const attEq       = calls.eqs.find(e => e.table === 'attendance' && e.col === 'employee_id');
    const leaveEq     = calls.eqs.find(e => e.table === 'leave_requests' && e.col === 'employee_id');
    const overtimeEq  = calls.eqs.find(e => e.table === 'overtime_requests' && e.col === 'employee_id');
    const compEq      = calls.eqs.find(e => e.table === 'comp_time_balance' && e.col === 'employee_id');
    expect(salaryEq?.val).toBe('E_resigned');
    expect(attEq?.val).toBe('E_resigned');
    expect(leaveEq?.val).toBe('E_resigned');
    expect(overtimeEq?.val).toBe('E_resigned');
    expect(compEq?.val).toBe('E_resigned');

    // attendance / leave_requests 用日期範圍 filter
    const attGte = calls.gtes.find(e => e.table === 'attendance' && e.col === 'work_date');
    const attLte = calls.ltes.find(e => e.table === 'attendance' && e.col === 'work_date');
    expect(attGte?.val.startsWith('2025-10')).toBe(true);
    expect(attLte?.val.startsWith('2026-04')).toBe(true);

    const leaveGte = calls.gtes.find(e => e.table === 'leave_requests' && e.col === 'start_date');
    expect(leaveGte?.val.startsWith('2025-10')).toBe(true);
  });

  it('resigned_at null → fallback 用 updated_at 當 anchor', async () => {
    overrides.caller = HR;
    dataByQuery['employees:maybeSingle'] = {
      id: 'E_legacy',
      status: 'resigned',
      resigned_at: null,
      updated_at: '2026-03-01T00:00:00.000Z',  // 倒推 6 個月 → 2025-09-01
      hire_date: '2022-01-01',
    };
    const [req, res] = makeReqRes({ query: { id: 'E_legacy' } });
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.history.window.end.startsWith('2026-03')).toBe(true);
    expect(res.body.history.window.start.startsWith('2025-09')).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════
// Phase 1.7.2:離職時部門(employee_change_logs 回推)
// ════════════════════════════════════════════════════════════
describe('/api/resigned-archive?id=X — Phase 1.7.2 dept_at_resignation', () => {
  // 注意:當 dataByQuery['employees:maybeSingle'] 同時被「員工 row」跟「departments
  // dept name 撈」共用時、要用獨立 key。但 supabase mock chain 是共用、實際 prod 有分。
  // 本測試:focus on log-driven dept、不細分 departments 撈(handler 內部的 best-effort)。

  it('無 dept 變更 log → fallback 當前 dept_id、is_historical=false', async () => {
    overrides.caller = HR;
    dataByQuery['employees:maybeSingle'] = {
      id: 'E_no_log', status: 'resigned',
      name: 'Alice', dept_id: 'D_CURRENT',
      resigned_at: '2026-04-01T00:00:00.000Z',
    };
    // employee_change_logs:maybeSingle = null(無 log)
    dataByQuery['employee_change_logs:maybeSingle'] = null;
    const [req, res] = makeReqRes({ query: { id: 'E_no_log' } });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.dept_at_resignation).toEqual({
      dept_id: 'D_CURRENT',
      dept_name: null,  // addDeptNameSingle 是 mock、不寫 dept_name、handler 用 || null fallback
      is_historical: false,
    });
  });

  it('有 dept 變更 log → 用 audit after_value、is_historical=true', async () => {
    overrides.caller = HR;
    // 第一次 maybeSingle → employees row;之後 employee_change_logs / departments
    // 同份 dataByQuery key、最後寫的覆蓋。實作上要分 key 才精準。
    // 本測試 cover 幹道:log 存在 → resigned 時 dept = log.after_value
    dataByQuery['employees:maybeSingle'] = {
      id: 'E_with_log', status: 'resigned',
      name: 'Bob', dept_id: 'D_CURRENT',
      resigned_at: '2026-04-01T00:00:00.000Z',
    };
    // 注意:本 mock chain 共用 maybeSingle key、會被後撈的 departments 蓋過。
    // 但 supabase.from('employee_change_logs').select(...).maybeSingle() 在前、
    // departments 在後;後者不會影響 dept_at_resignation 計算(已在 log 抓到時固定)。
    dataByQuery['employee_change_logs:maybeSingle'] = {
      after_value: 'D_RESIGNED', changed_at: '2026-03-15T00:00:00.000Z',
    };
    const [req, res] = makeReqRes({ query: { id: 'E_with_log' } });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.dept_at_resignation.dept_id).toBe('D_RESIGNED');
    expect(res.body.dept_at_resignation.is_historical).toBe(true);
  });

  it('log table 撈失敗(prod migration 沒跑、try 吞掉)→ fallback 當前 dept', async () => {
    overrides.caller = HR;
    dataByQuery['employees:maybeSingle'] = {
      id: 'E_no_table', status: 'resigned',
      name: 'C', dept_id: 'D_FALLBACK',
      resigned_at: '2026-04-01T00:00:00.000Z',
    };
    // mock 預設 maybeSingle 回 null(沒拋 error)、handler 視同無 log
    const [req, res] = makeReqRes({ query: { id: 'E_no_table' } });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.dept_at_resignation.is_historical).toBe(false);
    expect(res.body.dept_at_resignation.dept_id).toBe('D_FALLBACK');
  });
});
