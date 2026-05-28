// tests/pending-approvals.test.js — Phase 1:pending-approvals facade endpoint
//
// 覆蓋 spec 15 個 case:
//   1-2  403:employee / admin (非 backoffice approver)
//   3-4  manager + approvals(dept-scope filter, JS-side)
//   5-6  manager + leaves   (dept-scope filter, supabase .in())
//   7    manager + 兩 source merge + 排序
//   8-9  ceo / chairman 路徑(都對 step=2 role=ceo / pending_ceo)
//   10   hr 路徑(只撈 approvals step=3 role=hr、leaves 永遠空)
//   11-12 leave 的 expired proof / late_application 仍出現
//   13-14 supabase query error → 500
//   15   ceo 但 is_manager=true → 視為 manager(callerEffRole = is_manager ? 'manager' : role)
//
// Mock 策略(對齊既有 tests/api-approvals.test.js + api-leaves-manager-name.test.js):
//   supabase chain: 每個 table 獨立、用 tableState[table_then] 控制 array、tableState[table_err] 控 error
//   auth: overrides.caller = null → 401(沒用到、本檔聚焦 403/200);有值就直接回
//   auth-scope: vi.fn(async () => scopeOverride)、case 內 reset
//   dept-name-mapper: no-op(不驗 dept name 串接、那是 dept-name-mapper.test.js 的事)
//
// nested join shape:直接餵已 nested 好的 row(對齊 supabase-js 真實返回)、
// E2E 由 prod smoke test 驗。

import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls = { tables: [], eqs: [], ins: [] };
const tableState = {
  approval_steps_then: [],
  approval_steps_err: null,
  leave_requests_then: [],
  leave_requests_err: null,
};
const overrides = {
  caller: null,
  scope: { mode: 'all', selfId: 'X', deptEmpIds: [] },
};

vi.mock('../lib/supabase.js', () => {
  function chain(table) {
    const c = {};
    c.select = vi.fn(() => c);
    c.eq = vi.fn((col, val) => { calls.eqs.push({ table, col, val }); return c; });
    c.neq = vi.fn(() => c);
    c.in = vi.fn((col, vals) => { calls.ins.push({ table, col, vals }); return c; });
    c.is = vi.fn(() => c);    // 對齊 8c44806 soft-delete 加的 .is('deleted_at', null) filter
    c.gte = vi.fn(() => c); c.lte = vi.fn(() => c);
    c.order = vi.fn(() => c); c.limit = vi.fn(() => c);
    c.single = vi.fn(() => Promise.resolve({ data: null, error: null }));
    c.maybeSingle = vi.fn(() => Promise.resolve({ data: null, error: null }));
    c.then = (onF, onR) => {
      let data = null, error = null;
      if (table === 'approval_steps') {
        data  = tableState.approval_steps_then;
        error = tableState.approval_steps_err;
      } else if (table === 'leave_requests') {
        data  = tableState.leave_requests_then;
        error = tableState.leave_requests_err;
      } else {
        data = [];
      }
      return Promise.resolve({ data, error }).then(onF, onR);
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

vi.mock('../lib/auth-scope.js', () => ({
  resolveAuthScopeWithDeptIds: vi.fn(async () => overrides.scope),
  makeDeptEmpIdsRepo: vi.fn(() => ({})),
  canSeeEmployee: vi.fn(() => true),
}));

vi.mock('../lib/dept-name-mapper.js', () => ({
  addDeptName: vi.fn(),
  addDeptNameSingle: vi.fn(),
  addDeptNameNested: vi.fn(),
}));

const { default: handler } = await import('../api/pending-approvals.js');

function makeReqRes({ method = 'GET', query = {}, body = {} } = {}) {
  const res = {
    statusCode: 200, body: undefined,
    status(c) { this.statusCode = c; return this; },
    json(p)   { this.body = p; return this; },
    end()     { return this; },
  };
  return [{ method, query, body, headers: {} }, res];
}

beforeEach(() => {
  calls.tables = []; calls.eqs = []; calls.ins = [];
  tableState.approval_steps_then = [];
  tableState.approval_steps_err = null;
  tableState.leave_requests_then = [];
  tableState.leave_requests_err = null;
  overrides.caller = null;
  overrides.scope = { mode: 'all', selfId: 'X', deptEmpIds: [] };
});

// ─── fixtures ────────────────────────────────────────────────
const EMP = { id: 'E1',  role: 'employee', is_manager: false, dept_id: 'D1' };
const ADM = { id: 'A1',  role: 'admin',    is_manager: false, dept_id: 'D_HR' };
const MGR = { id: 'M1',  role: 'employee', is_manager: true,  dept_id: 'D1' };
const HR  = { id: 'HR1', role: 'hr',       is_manager: false, dept_id: 'D_HR' };
const CEO = { id: 'C1',  role: 'ceo',      is_manager: false, dept_id: 'D_EXEC' };
const CHR = { id: 'CH1', role: 'chairman', is_manager: false, dept_id: 'D_EXEC' };
const CEO_MGR = { id: 'C2', role: 'ceo',   is_manager: true,  dept_id: 'D1' };

function approvalStep({
  id = 'STEP1', request_id = 'APR1', step_number = 1, step_name = '主管審核',
  approver_role = 'manager', applicant_id = 'E1', applicant_name = '小明',
  request_type = 'punch_correction', title = '補打卡申請',
  created_at = '2026-05-15T10:00:00+08:00', dept_id = 'D1',
} = {}) {
  return {
    id, request_id, step_number, step_name, approver_role, status: 'in_progress',
    approval_requests: {
      id: request_id, request_type, title, applicant_id, created_at,
      employees: { name: applicant_name, dept_id, position: '工程師', avatar: null,
                   departments: { name: '研發部' } },
    },
  };
}

function leaveRow({
  id = 'L1', employee_id = 'E1', leave_type = 'annual',
  start_at = '2026-05-20T09:00:00+08:00', end_at = '2026-05-20T18:00:00+08:00',
  hours = 8, applied_at = '2026-05-15T11:00:00+08:00',
  status = 'pending_mgr', reason = '休假', late_application = false,
  proof_status = null, proof_due_at = null, attachment_url = null,
  applicant_name = '小明', dept_id = 'D1',
} = {}) {
  return {
    id, employee_id, leave_type, start_at, end_at, hours, applied_at, status,
    reason, late_application, proof_status, proof_due_at, attachment_url,
    employees: { name: applicant_name, dept_id, position: '工程師', avatar: null,
                 departments: { name: '研發部' } },
  };
}

// ════════════════════════════════════════════════════════════
// Case 1-2: 403 — employee / admin
// ════════════════════════════════════════════════════════════
describe('canViewPending gate', () => {
  it('Case 1: caller=employee → 403', async () => {
    overrides.caller = EMP;
    const [req, res] = makeReqRes();
    await handler(req, res);
    expect(res.statusCode).toBe(403);
    expect(res.body?.error).toMatch(/Forbidden/);
  });

  it('Case 2: caller=admin (is_manager=false) → 403', async () => {
    overrides.caller = ADM;
    const [req, res] = makeReqRes();
    await handler(req, res);
    expect(res.statusCode).toBe(403);
  });
});

// ════════════════════════════════════════════════════════════
// Case 3-4: manager + approvals dept-scope (JS-side filter)
// ════════════════════════════════════════════════════════════
describe('manager — approval_steps source', () => {
  it('Case 3: applicant 在 dept 內 → 回 1 筆 source=approval', async () => {
    overrides.caller = MGR;
    overrides.scope = { mode: 'dept', selfId: 'M1', deptEmpIds: ['E1', 'E2'] };
    tableState.approval_steps_then = [approvalStep({ applicant_id: 'E1' })];
    const [req, res] = makeReqRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(1);
    const r = res.body[0];
    expect(r.source).toBe('approval');
    expect(r.request_id).toBe('APR1');
    expect(r.applicant_name).toBe('小明');
    expect(r.created_at).toBe('2026-05-15T10:00:00+08:00');
    expect(r.step_number).toBe(1);
    expect(r.step_name).toBe('主管審核');
    // 驗 step_num + approver_role 對 (manager → step 1, role manager)
    const stepNumEq = calls.eqs.find(e => e.table === 'approval_steps' && e.col === 'step_number');
    const stepRoleEq = calls.eqs.find(e => e.table === 'approval_steps' && e.col === 'approver_role');
    expect(stepNumEq?.val).toBe(1);
    expect(stepRoleEq?.val).toBe('manager');
  });

  it('Case 4: applicant 在別部門 → JS filter 過濾掉、回 []', async () => {
    overrides.caller = MGR;
    overrides.scope = { mode: 'dept', selfId: 'M1', deptEmpIds: ['E1'] };
    // applicant_id='OTHER' 不在 [M1, E1] 內 → 過濾掉
    tableState.approval_steps_then = [approvalStep({ applicant_id: 'OTHER' })];
    const [req, res] = makeReqRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    // approval 被 filter 掉、leave 也空(default empty)、最終 []
    expect(res.body.length).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════
// Case 5-6: manager + leave_requests dept-scope (supabase .in)
// ════════════════════════════════════════════════════════════
describe('manager — leave_requests source', () => {
  it('Case 5: leave 在 dept 內 → 回 1 筆 source=leave + 帶 stage / hours', async () => {
    overrides.caller = MGR;
    overrides.scope = { mode: 'dept', selfId: 'M1', deptEmpIds: ['E1'] };
    tableState.leave_requests_then = [leaveRow({ employee_id: 'E1' })];
    const [req, res] = makeReqRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.length).toBe(1);
    const r = res.body[0];
    expect(r.source).toBe('leave');
    expect(r.request_id).toBe('L1');
    expect(r.applicant_name).toBe('小明');
    expect(r.created_at).toBe('2026-05-15T11:00:00+08:00');
    expect(r.stage).toBe('pending_mgr');
    expect(r.hours).toBe(8);
    // 驗 leave_requests status=pending_mgr 已套 + .in('employee_id', [M1, E1])
    const stageEq = calls.eqs.find(e => e.table === 'leave_requests' && e.col === 'status');
    expect(stageEq?.val).toBe('pending_mgr');
    const inCall = calls.ins.find(i => i.table === 'leave_requests' && i.col === 'employee_id');
    expect(inCall?.vals).toEqual(['M1', 'E1']);
  });

  it('Case 6: leave applicant 別部門 → 不在 .in 範圍、supabase 回 [](mock)、最終 []', async () => {
    overrides.caller = MGR;
    overrides.scope = { mode: 'dept', selfId: 'M1', deptEmpIds: ['E1'] };
    // supabase 端真的會 filter 掉 'OTHER',mock 模擬 filter 後結果為空
    tableState.leave_requests_then = [];
    const [req, res] = makeReqRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.length).toBe(0);
    // 但仍要驗 .in 確實有被叫、且不含 OTHER
    const inCall = calls.ins.find(i => i.table === 'leave_requests' && i.col === 'employee_id');
    expect(inCall?.vals).toEqual(['M1', 'E1']);
    expect(inCall?.vals.includes('OTHER')).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════
// Case 7: manager + 兩 source merge + created_at DESC
// ════════════════════════════════════════════════════════════
describe('merge + 排序', () => {
  it('Case 7: approval(10:00) + leave(12:00) → 排序後 leave(12:00) 先', async () => {
    overrides.caller = MGR;
    overrides.scope = { mode: 'dept', selfId: 'M1', deptEmpIds: ['E1', 'E2'] };
    tableState.approval_steps_then = [
      approvalStep({ id: 'STEP_A', request_id: 'APR_A', applicant_id: 'E1',
                     created_at: '2026-05-15T10:00:00+08:00' }),
    ];
    tableState.leave_requests_then = [
      leaveRow({ id: 'L_B', employee_id: 'E2',
                 applied_at: '2026-05-15T12:00:00+08:00' }),
    ];
    const [req, res] = makeReqRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.length).toBe(2);
    // 12:00 > 10:00 → leave 先
    expect(res.body[0].source).toBe('leave');
    expect(res.body[0].created_at).toBe('2026-05-15T12:00:00+08:00');
    expect(res.body[1].source).toBe('approval');
    expect(res.body[1].created_at).toBe('2026-05-15T10:00:00+08:00');
  });
});

// ════════════════════════════════════════════════════════════
// Case 8-9: ceo / chairman
// ════════════════════════════════════════════════════════════
describe('ceo / chairman 路徑', () => {
  it('Case 8: ceo → step=2 role=ceo + leave stage=pending_ceo', async () => {
    overrides.caller = CEO;
    tableState.approval_steps_then = [approvalStep({
      id: 'STEP_C', request_id: 'APR_C', step_number: 2, step_name: '執行長審核',
      approver_role: 'ceo',
    })];
    tableState.leave_requests_then = [leaveRow({
      id: 'L_C', status: 'pending_ceo',
    })];
    const [req, res] = makeReqRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.length).toBe(2);
    // 驗 query 對:approval step=2 role=ceo / leave status=pending_ceo
    expect(calls.eqs.find(e => e.table === 'approval_steps' && e.col === 'step_number')?.val).toBe(2);
    expect(calls.eqs.find(e => e.table === 'approval_steps' && e.col === 'approver_role')?.val).toBe('ceo');
    expect(calls.eqs.find(e => e.table === 'leave_requests' && e.col === 'status')?.val).toBe('pending_ceo');
    // 驗 response shape
    const leaveItem = res.body.find(x => x.source === 'leave');
    expect(leaveItem.stage).toBe('pending_ceo');
  });

  it('Case 9: chairman → step=2 approver_role=ceo (chairman→ceo) + leave pending_ceo', async () => {
    overrides.caller = CHR;
    tableState.approval_steps_then = [approvalStep({ step_number: 2, approver_role: 'ceo' })];
    tableState.leave_requests_then = [leaveRow({ status: 'pending_ceo' })];
    const [req, res] = makeReqRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    // 關鍵:approver_role 必須是 'ceo'、不是 'chairman'
    expect(calls.eqs.find(e => e.table === 'approval_steps' && e.col === 'approver_role')?.val).toBe('ceo');
    expect(calls.eqs.find(e => e.table === 'approval_steps' && e.col === 'step_number')?.val).toBe(2);
    expect(calls.eqs.find(e => e.table === 'leave_requests' && e.col === 'status')?.val).toBe('pending_ceo');
  });
});

// ════════════════════════════════════════════════════════════
// Case 10: hr 路徑(只 approvals step=3 role=hr、leave 永遠空)
// ════════════════════════════════════════════════════════════
describe('hr 路徑', () => {
  it('Case 10: hr → step=3 role=hr,不撈 leave_requests', async () => {
    overrides.caller = HR;
    tableState.approval_steps_then = [approvalStep({
      step_number: 3, step_name: 'HR 審核', approver_role: 'hr',
    })];
    // 即使 leave_requests 有資料、hr 路徑也不該撈
    tableState.leave_requests_then = [leaveRow({ status: 'pending_mgr' })];
    const [req, res] = makeReqRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.length).toBe(1); // 只有 approval
    expect(res.body[0].source).toBe('approval');
    expect(res.body[0].step_number).toBe(3);
    // 驗:leave_requests 完全沒被 query
    expect(calls.tables.includes('leave_requests')).toBe(false);
    expect(calls.eqs.find(e => e.table === 'approval_steps' && e.col === 'step_number')?.val).toBe(3);
    expect(calls.eqs.find(e => e.table === 'approval_steps' && e.col === 'approver_role')?.val).toBe('hr');
  });
});

// ════════════════════════════════════════════════════════════
// Case 11-12: expired proof / late_application 仍出現
// ════════════════════════════════════════════════════════════
describe('leave 特殊欄位帶到 response', () => {
  it('Case 11: proof_status=expired 的 leave 仍出現、欄位帶到', async () => {
    overrides.caller = MGR;
    overrides.scope = { mode: 'dept', selfId: 'M1', deptEmpIds: ['E1'] };
    tableState.leave_requests_then = [leaveRow({
      employee_id: 'E1', proof_status: 'expired',
      proof_due_at: '2026-05-10T23:59:59+08:00',
    })];
    const [req, res] = makeReqRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.length).toBe(1);
    expect(res.body[0].source).toBe('leave');
    expect(res.body[0].proof_status).toBe('expired');
    expect(res.body[0].proof_due_at).toBe('2026-05-10T23:59:59+08:00');
  });

  it('Case 12: late_application=true 的 leave 仍出現、欄位帶到', async () => {
    overrides.caller = MGR;
    overrides.scope = { mode: 'dept', selfId: 'M1', deptEmpIds: ['E1'] };
    tableState.leave_requests_then = [leaveRow({
      employee_id: 'E1', late_application: true,
    })];
    const [req, res] = makeReqRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.length).toBe(1);
    expect(res.body[0].late_application).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════
// Case 13-14: supabase query error → 500
// ════════════════════════════════════════════════════════════
describe('supabase error → 500', () => {
  it('Case 13: approval_steps query error → 500 + approvals query failed', async () => {
    overrides.caller = MGR;
    overrides.scope = { mode: 'dept', selfId: 'M1', deptEmpIds: ['E1'] };
    tableState.approval_steps_err = { message: 'DB down' };
    const [req, res] = makeReqRes();
    await handler(req, res);
    expect(res.statusCode).toBe(500);
    expect(res.body?.error).toMatch(/approvals query failed/);
    expect(res.body?.error).toMatch(/DB down/);
  });

  it('Case 14: leave_requests query error → 500 + leaves query failed', async () => {
    overrides.caller = MGR;
    overrides.scope = { mode: 'dept', selfId: 'M1', deptEmpIds: ['E1'] };
    tableState.leave_requests_err = { message: 'leave table down' };
    const [req, res] = makeReqRes();
    await handler(req, res);
    expect(res.statusCode).toBe(500);
    expect(res.body?.error).toMatch(/leaves query failed/);
    expect(res.body?.error).toMatch(/leave table down/);
  });
});

// ════════════════════════════════════════════════════════════
// Case 15: ceo + is_manager=true → 視為 manager
// ════════════════════════════════════════════════════════════
describe('callerEffRole 邊角', () => {
  it('Case 15: ceo role 但 is_manager=true → 視為 manager(step=1 role=manager / pending_mgr)', async () => {
    overrides.caller = CEO_MGR;
    overrides.scope = { mode: 'dept', selfId: 'C2', deptEmpIds: ['E1'] };
    tableState.approval_steps_then = [approvalStep({ applicant_id: 'E1' })];
    tableState.leave_requests_then = [leaveRow({ employee_id: 'E1' })];
    const [req, res] = makeReqRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    // 關鍵:is_manager=true 蓋過 role=ceo
    expect(calls.eqs.find(e => e.table === 'approval_steps' && e.col === 'step_number')?.val).toBe(1);
    expect(calls.eqs.find(e => e.table === 'approval_steps' && e.col === 'approver_role')?.val).toBe('manager');
    expect(calls.eqs.find(e => e.table === 'leave_requests' && e.col === 'status')?.val).toBe('pending_mgr');
    // 而且 leave .in() 也應該有套 dept-scope
    const inCall = calls.ins.find(i => i.table === 'leave_requests' && i.col === 'employee_id');
    expect(inCall?.vals).toEqual(['C2', 'E1']);
  });
});
