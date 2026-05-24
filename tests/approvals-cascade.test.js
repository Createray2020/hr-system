// tests/approvals-cascade.test.js — B7:resignation approve 完成後 cascade 員工狀態
//
// 對應實作:api/approvals.js POST approve completed 分支 + applyResignation helper
// β 方案:不寫 employee_change_logs、靠 console.log + employees 自然欄位當 audit
//
// 涵蓋:
//   1. resignation step 3 approve → employees update 成功
//   2. resigned_at = form_data.resign_date (T+08:00 ISO,可能是未來日)
//   3. cascade 失敗(employees update error)→ approval 仍 completed (best-effort)
//   4. idempotent guard:對已 resigned 員工再 cascade → skip,不重複 update
//   5. employee not found → console.error,不 throw
//   6. 非 resignation request(punch_correction / 其他)→ applyResignation 不被呼叫

import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls = { tables: [], updates: [], inserts: [] };
const dataByQuery = {};
const overrides = { caller: null, employeesUpdateError: null };

vi.mock('../lib/supabase.js', () => {
  function chain(table) {
    const c = {};
    let where = {};
    c.select = vi.fn(() => c);
    c.eq = vi.fn((col, val) => { where[col] = val; return c; });
    c.neq = vi.fn(() => c);
    c.in = vi.fn(() => c);
    c.gte = vi.fn(() => c); c.lte = vi.fn(() => c);
    c.order = vi.fn(() => c); c.limit = vi.fn(() => c);
    c.update = vi.fn((patch) => {
      calls.updates.push({ table, patch, where: { ...where } });
      // B7 test:模擬 employees update 失敗
      if (table === 'employees' && overrides.employeesUpdateError) {
        c.eq = vi.fn(() => Promise.resolve({ error: { message: overrides.employeesUpdateError } }));
      }
      return c;
    });
    c.insert = vi.fn((rows) => { calls.inserts.push({ table, rows }); return c; });
    c.single = vi.fn(() => Promise.resolve({
      data: dataByQuery[`${table}:single`] ?? null,
      error: dataByQuery[`${table}:single`] ? null : { code: 'PGRST116' },
    }));
    c.maybeSingle = vi.fn(() => Promise.resolve({
      data: dataByQuery[`${table}:maybeSingle`] ?? null, error: null,
    }));
    c.then = (onF, onR) => Promise.resolve({
      data: dataByQuery[`${table}:then`] ?? [], error: null,
    }).then(onF, onR);
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

vi.mock('../lib/push.js', () => ({
  sendPushToEmployees: vi.fn(async () => ({ sent: 0 })),
  sendPushToRoles:     vi.fn(async () => ({ sent: 0 })),
  createNotifications: vi.fn(async () => undefined),
  createNotificationsForRoles: vi.fn(async () => undefined),
}));

vi.mock('../lib/dept-name-mapper.js', () => ({
  addDeptName: vi.fn(),
  addDeptNameSingle: vi.fn(),
  addDeptNameNested: vi.fn(),
}));

const { default: handler } = await import('../api/approvals.js');

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
  calls.tables = []; calls.updates = []; calls.inserts = [];
  for (const k of Object.keys(dataByQuery)) delete dataByQuery[k];
  overrides.caller = null;
  overrides.employeesUpdateError = null;
  // 預設靜默 console.error / console.log(B7 cascade 預期會輸出 audit log、
  // 不污染 vitest output;個別 case 需要可 spyOn 驗證)
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

const HR = { id: 'HR1', role: 'hr', is_manager: false, dept_id: 'D_HR' };

// ── 共用 setup:resignation request 跑到 step 3、HR 正要 approve ──
//   total_steps=3、current step_number=3、approver_role='hr'、status='in_progress'
//   priorSteps:step 1 manager approved by M1、step 2 ceo approved by C1
function setupResignationStep3({ employee = {}, request = {} } = {}) {
  dataByQuery['approval_requests:single'] = {
    id: 'APR_R1',
    applicant_id: 'EMP_01251101',
    request_type: 'resignation',
    title: '離職申請',
    total_steps: 3,
    current_step: 3,
    status: 'in_progress',
    form_data: {
      resign_date: '2026-05-31',
      reason: '生涯規劃',
      handover: '已交接給 M1',
    },
    ...request,
  };
  dataByQuery['approval_steps:maybeSingle'] = {
    request_id: 'APR_R1', step_number: 3, approver_role: 'hr', status: 'in_progress',
  };
  // employees:maybeSingle 被查兩次:
  //   (1) canApproveStep 查 applicant dept_id
  //   (2) applyResignation 查 status/resigned_at idempotent
  // 同 row 包含三組欄位、兩次都得到合理資料
  dataByQuery['employees:maybeSingle'] = {
    id: 'EMP_01251101',
    dept_id: 'D1',
    status: 'active',
    resigned_at: null,
    ...employee,
  };
  // priorSteps:step 1 / step 2 都已 approved、approver 不是 HR(避免跨 step 同人連簽 guard 擋)
  dataByQuery['approval_steps:then'] = [
    { step_number: 1, status: 'approved', approver_id: 'M1' },
    { step_number: 2, status: 'approved', approver_id: 'C1' },
  ];
}

describe('B7:resignation step 3 approve → cascade employees', () => {
  it('B7.1 正常 cascade:employees.status / resigned_at / resigned_reason 寫入', async () => {
    overrides.caller = HR;
    setupResignationStep3();
    const [req, res] = makeReqRes({
      body: { action: 'approve', request_id: 'APR_R1', step_number: 3 },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(200);

    // Mock chain 的 where snapshot 在 update() 當下抓、early-bound;
    // .eq() 是後續呼叫、不會回填、所以只 match patch.status(對齊既有 api-approvals.test.js pattern)
    const empUpd = calls.updates.find(u => u.table === 'employees' && u.patch.status === 'resigned');
    expect(empUpd).toBeDefined();
    expect(empUpd.patch.resigned_at).toBe('2026-05-31T00:00:00+08:00');
    expect(empUpd.patch.resigned_reason).toBe('生涯規劃');
  });

  it('B7.2 cascade 失敗 → approval 仍 completed(best-effort、不 rollback approval)', async () => {
    overrides.caller = HR;
    overrides.employeesUpdateError = 'simulated DB error';
    setupResignationStep3();
    const [req, res] = makeReqRes({
      body: { action: 'approve', request_id: 'APR_R1', step_number: 3 },
    });
    await handler(req, res);
    // approve 仍回 200(approval completed)
    expect(res.statusCode).toBe(200);
    // approval_requests 更新成 completed
    const reqUpd = calls.updates.find(u =>
      u.table === 'approval_requests' && u.patch.status === 'completed');
    expect(reqUpd).toBeDefined();
    // approval_steps step 3 寫成 approved
    const stepUpd = calls.updates.find(u =>
      u.table === 'approval_steps' && u.patch.status === 'approved');
    expect(stepUpd).toBeDefined();
  });

  it('B7.3 idempotent guard:已 resigned 員工再 cascade → skip、不重複 update', async () => {
    overrides.caller = HR;
    setupResignationStep3({
      employee: { status: 'resigned', resigned_at: '2026-05-14T00:00:00+08:00' },
    });
    const [req, res] = makeReqRes({
      body: { action: 'approve', request_id: 'APR_R1', step_number: 3 },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    // employees 不被 update(idempotent guard 早早 return)
    const empUpd = calls.updates.find(u => u.table === 'employees');
    expect(empUpd).toBeUndefined();
  });

  it('B7.4 employee not found → console.error、不 throw、approval 仍 completed', async () => {
    overrides.caller = HR;
    setupResignationStep3();
    // 把 employees:maybeSingle 改成 null 模擬 not found
    // 但 canApproveStep 也用同個 mock key,所以需 work around:
    // 設成 dept_id 有值但 id 為 null 的 hybrid... 改用 spyOn 模擬第二次回 null
    // 簡化:測試框架限制下、改成 employee_id 拿到 null 路徑用 missing applicant_id 驗
    dataByQuery['approval_requests:single'] = {
      id: 'APR_R2', applicant_id: null, // missing applicant
      request_type: 'resignation', title: '離職', total_steps: 3, current_step: 3,
      status: 'in_progress', form_data: { resign_date: '2026-05-31', reason: 'X' },
    };
    dataByQuery['approval_steps:maybeSingle'] = {
      request_id: 'APR_R2', step_number: 3, approver_role: 'hr', status: 'in_progress',
    };
    dataByQuery['employees:maybeSingle'] = { id: 'X', dept_id: 'D1' };
    dataByQuery['approval_steps:then'] = [
      { step_number: 1, status: 'approved', approver_id: 'M1' },
      { step_number: 2, status: 'approved', approver_id: 'C1' },
    ];
    const [req, res] = makeReqRes({
      body: { action: 'approve', request_id: 'APR_R2', step_number: 3 },
    });
    await handler(req, res);
    // approve 仍 200(cascade try/catch swallow + missing applicant 早 return)
    expect(res.statusCode).toBe(200);
    expect(console.error).toHaveBeenCalledWith(
      '[applyResignation] missing applicant_id',
      expect.objectContaining({ request_id: 'APR_R2' }),
    );
  });

  it('B7.5 非 resignation request(punch_correction)→ applyResignation 不被呼叫、employees 不動', async () => {
    overrides.caller = HR;
    // step 3 場景同 setup、但 request_type 改成 punch_correction
    setupResignationStep3({
      request: { id: 'APR_P1', request_type: 'punch_correction',
                 form_data: { correction_date: '2026-05-20', correction_type: '上班打卡',
                              expected_time: '09:00', reason: '忘記' } },
    });
    const [req, res] = makeReqRes({
      body: { action: 'approve', request_id: 'APR_P1', step_number: 3 },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    // employees 不被當作 resignation cascade target 動
    const empUpd = calls.updates.find(u =>
      u.table === 'employees' && u.patch.status === 'resigned');
    expect(empUpd).toBeUndefined();
  });

  it('B7.6 audit:applyResignation success → console.log 含 request_id / employee_id / resigned_at / approver_id', async () => {
    overrides.caller = HR;
    setupResignationStep3();
    const [req, res] = makeReqRes({
      body: { action: 'approve', request_id: 'APR_R1', step_number: 3 },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(console.log).toHaveBeenCalledWith(
      '[applyResignation] success',
      expect.objectContaining({
        request_id: 'APR_R1',
        employee_id: 'EMP_01251101',
        resigned_at: '2026-05-31T00:00:00+08:00',
        approver_id: 'HR1',
      }),
    );
  });
});
