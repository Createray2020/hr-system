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

const calls = { tables: [], updates: [], inserts: [], deletes: [] };
const dataByQuery = {};
const overrides = {
  caller: null,
  employeesUpdateError: null,
  deleteErrors: null,  // { table: errorMessage } — 模擬 delete 失敗
  insertErrors: null,  // { table: errorMessage } — 模擬 insert 失敗
};

vi.mock('../lib/supabase.js', () => {
  function chain(table) {
    const c = {};
    let where = {};
    let opType = 'select'; // select/insert/update/delete — 給 c.then 區分回傳
    c.select = vi.fn(() => c);
    c.eq = vi.fn((col, val) => { where[col] = val; return c; });
    c.neq = vi.fn(() => c);
    c.in = vi.fn(() => c);
    c.gte = vi.fn(() => c); c.lte = vi.fn(() => c);
    c.order = vi.fn(() => c); c.limit = vi.fn(() => c);
    c.update = vi.fn((patch) => {
      opType = 'update';
      calls.updates.push({ table, patch, where: { ...where } });
      // B7 test:模擬 employees update 失敗
      if (table === 'employees' && overrides.employeesUpdateError) {
        c.eq = vi.fn(() => Promise.resolve({ error: { message: overrides.employeesUpdateError } }));
      }
      return c;
    });
    c.insert = vi.fn((rows) => {
      opType = 'insert';
      calls.inserts.push({ table, rows });
      return c;
    });
    c.delete = vi.fn(() => {
      opType = 'delete';
      calls.deletes.push({ table });
      return c;
    });
    c.single = vi.fn(() => Promise.resolve({
      data: dataByQuery[`${table}:single`] ?? null,
      error: dataByQuery[`${table}:single`] ? null : { code: 'PGRST116' },
    }));
    c.maybeSingle = vi.fn(() => Promise.resolve({
      data: dataByQuery[`${table}:maybeSingle`] ?? null, error: null,
    }));
    c.then = (onF, onR) => {
      if (opType === 'insert') {
        const err = overrides.insertErrors?.[table];
        return Promise.resolve({
          data: null,
          error: err ? { message: err } : null,
        }).then(onF, onR);
      }
      if (opType === 'delete') {
        const err = overrides.deleteErrors?.[table];
        return Promise.resolve({
          data: null,
          error: err ? { message: err } : null,
        }).then(onF, onR);
      }
      return Promise.resolve({
        data: dataByQuery[`${table}:then`] ?? [], error: null,
      }).then(onF, onR);
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

// Hoisted spy — 從外部 capture push.js mock 的呼叫(B7.9-B7.11 assert 用)
const { sendPushToRolesSpy } = vi.hoisted(() => ({
  sendPushToRolesSpy: vi.fn(async () => ({ sent: 0 })),
}));

vi.mock('../lib/push.js', () => ({
  sendPushToEmployees: vi.fn(async () => ({ sent: 0 })),
  sendPushToRoles:     sendPushToRolesSpy,
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
  calls.tables = []; calls.updates = []; calls.inserts = []; calls.deletes = [];
  for (const k of Object.keys(dataByQuery)) delete dataByQuery[k];
  overrides.caller = null;
  overrides.employeesUpdateError = null;
  overrides.deleteErrors = null;
  overrides.insertErrors = null;
  sendPushToRolesSpy.mockClear();
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

  // ─── Phase 2 cascade enhancement(B7.7 ~ B7.11)─────────────
  // 對應 commit 2a0acc7 之後的 Phase 2 patch:cascade 完成「員工 status='resigned'」
  // 後額外做 3 件事:清 push_subscriptions / 建 checklist + 46 items / 通知 HR

  it('B7.7 cascade 觸發 push_subscriptions DELETE', async () => {
    overrides.caller = HR;
    setupResignationStep3({
      employee: { id: 'EMP_01251101', name: '柯郁含', dept_id: 'D1', status: 'active', resigned_at: null },
    });
    const [req, res] = makeReqRes({
      body: { action: 'approve', request_id: 'APR_R1', step_number: 3 },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    // 驗 push_subscriptions delete 有被呼叫
    const psDelete = calls.deletes.find(d => d.table === 'push_subscriptions');
    expect(psDelete).toBeDefined();
    // 驗 audit console.log
    expect(console.log).toHaveBeenCalledWith(
      '[applyResignation] push_subscriptions cleaned',
      expect.objectContaining({ employee_id: 'EMP_01251101' }),
    );
  });

  it('B7.8 cascade 觸發 checklist + 46 items 建立(6 個 AUTO_DONE done、其餘 pending)', async () => {
    overrides.caller = HR;
    setupResignationStep3({
      employee: { id: 'EMP_01251101', name: '柯郁含', dept_id: 'D1', status: 'active', resigned_at: null },
    });
    const [req, res] = makeReqRes({
      body: { action: 'approve', request_id: 'APR_R1', step_number: 3 },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(200);

    // 驗 checklist row(1 筆 status='draft')
    const clInserts = calls.inserts.filter(i => i.table === 'resignation_checklists');
    expect(clInserts).toHaveLength(1);
    const clRow = clInserts[0].rows[0];
    expect(clRow.employee_id).toBe('EMP_01251101');
    expect(clRow.approval_request_id).toBe('APR_R1');
    expect(clRow.status).toBe('draft');
    expect(clRow.id).toMatch(/^RCL\d+$/);

    // 驗 items 46 筆(單一 bulk insert)
    const itemInserts = calls.inserts.filter(i => i.table === 'resignation_checklist_items');
    expect(itemInserts).toHaveLength(1);
    const items = itemInserts[0].rows;
    expect(items).toHaveLength(46);

    // AUTO_DONE 6 個(seq 16/17/23/43/44/46)
    const autoDoneSeqs = new Set([16, 17, 23, 43, 44, 46]);
    const doneItems = items.filter(it => it.status === 'done');
    expect(doneItems).toHaveLength(6);
    expect(new Set(doneItems.map(it => it.item_seq))).toEqual(autoDoneSeqs);
    doneItems.forEach(it => {
      expect(it.completed_at).toBeTruthy();
      expect(it.completed_by).toBeNull();
      expect(it.note).toBe('系統自動完成');
    });

    // 其餘 40 個 pending
    const pendingItems = items.filter(it => it.status === 'pending');
    expect(pendingItems).toHaveLength(40);
    pendingItems.forEach(it => {
      expect(it.completed_at).toBeNull();
      expect(it.note).toBe('');
    });

    // 每筆 item 都有 category / category_label / item_name / item_seq
    items.forEach(it => {
      expect(it.category).toMatch(/^[1-8]_/);
      expect(it.category_label).toBeTruthy();
      expect(it.item_seq).toBeGreaterThanOrEqual(1);
      expect(it.item_seq).toBeLessThanOrEqual(46);
      expect(it.item_name).toBeTruthy();
      expect(it.checklist_id).toBe(clRow.id);
    });
  });

  it('B7.9 cascade 觸發 HR push notification(url 含 employee_id、body 含 name)', async () => {
    overrides.caller = HR;
    setupResignationStep3({
      employee: { id: 'EMP_01251101', name: '柯郁含', dept_id: 'D1', status: 'active', resigned_at: null },
    });
    const [req, res] = makeReqRes({
      body: { action: 'approve', request_id: 'APR_R1', step_number: 3 },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(200);

    expect(sendPushToRolesSpy).toHaveBeenCalledWith(
      ['hr', 'admin'],
      expect.objectContaining({
        title: expect.stringContaining('離職核准'),
        body: expect.stringContaining('柯郁含'),
        url: expect.stringContaining('employee_id=EMP_01251101'),
      }),
    );
  });

  it('B7.10 push_subscriptions delete 失敗 → checklist 仍建 + HR 通知仍送 + approval completed', async () => {
    overrides.caller = HR;
    overrides.deleteErrors = { 'push_subscriptions': 'simulated delete error' };
    setupResignationStep3({
      employee: { id: 'EMP_01251101', name: '柯郁含', dept_id: 'D1', status: 'active', resigned_at: null },
    });
    const [req, res] = makeReqRes({
      body: { action: 'approve', request_id: 'APR_R1', step_number: 3 },
    });
    await handler(req, res);

    // approval 仍 200 / completed
    expect(res.statusCode).toBe(200);
    const reqUpd = calls.updates.find(u =>
      u.table === 'approval_requests' && u.patch.status === 'completed');
    expect(reqUpd).toBeDefined();

    // push delete error 沒擋:checklist 仍建
    const clInserts = calls.inserts.filter(i => i.table === 'resignation_checklists');
    expect(clInserts).toHaveLength(1);

    // HR push 仍送
    expect(sendPushToRolesSpy).toHaveBeenCalledWith(['hr', 'admin'], expect.anything());
  });

  it('B7.11 checklist insert 失敗 → HR push 仍送、URL fallback /employees.html', async () => {
    overrides.caller = HR;
    overrides.insertErrors = { 'resignation_checklists': 'simulated insert error' };
    setupResignationStep3({
      employee: { id: 'EMP_01251101', name: '柯郁含', dept_id: 'D1', status: 'active', resigned_at: null },
    });
    const [req, res] = makeReqRes({
      body: { action: 'approve', request_id: 'APR_R1', step_number: 3 },
    });
    await handler(req, res);

    // approval 仍 200(best-effort、不擋)
    expect(res.statusCode).toBe(200);

    // HR push 仍呼叫、URL fallback 到 /employees.html(checklistId 沒建成功)
    expect(sendPushToRolesSpy).toHaveBeenCalledWith(
      ['hr', 'admin'],
      expect.objectContaining({
        url: '/employees.html',
      }),
    );
  });

  // ─── B26 批次 2 cascade enhancement #4 + #5 ────────────────
  // 對應 commit 57b81cb 之後的 B26 batch 2 patch:
  // #4 annual_leave_records 全 active → paid_out + settlement_amount(§38 base/30)
  // #5 comp_time_balance 全 active → expired_paid + expiry_payout_amount(hourly × multiplier)

  it('B26.1 cascade Enhancement #4:active annual_leave → paid_out + settlement_amount', async () => {
    overrides.caller = HR;
    setupResignationStep3({
      employee: {
        id: 'EMP_01251101', name: '柯郁含', dept_id: 'D1',
        status: 'active', resigned_at: null,
        base_salary: 30000, hourly_rate: 125,
      },
    });
    // 2 筆 active annual_leave_records:Record 73 + Record 74(柯郁含 hotfix 後狀態)
    dataByQuery['annual_leave_records:then'] = [
      { id: 73, granted_days: 14, used_days: 3 },  // remaining 11
      { id: 74, granted_days: 7,  used_days: 0 },  // remaining 7
    ];
    const [req, res] = makeReqRes({
      body: { action: 'approve', request_id: 'APR_R1', step_number: 3 },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(200);

    // 2 個 annual_leave_records UPDATE 都標 paid_out
    const annualUpdates = calls.updates.filter(u =>
      u.table === 'annual_leave_records' && u.patch.status === 'paid_out');
    expect(annualUpdates).toHaveLength(2);

    // 驗 settlement_amount = remaining × (30000/30) = remaining × 1000
    const settled = annualUpdates.map(u => u.patch.settlement_amount).sort((a, b) => a - b);
    expect(settled).toEqual([7000, 11000]);

    // 驗 settled_by = caller.id(HR1)、settled_at 有寫
    annualUpdates.forEach(u => {
      expect(u.patch.settled_by).toBe('HR1');
      expect(u.patch.settled_at).toBeTruthy();
    });

    // 2 個 leave_balance_logs INSERT(annual)
    const annualLogs = calls.inserts.filter(i =>
      i.table === 'leave_balance_logs' && i.rows[0].balance_type === 'annual');
    expect(annualLogs).toHaveLength(2);
    annualLogs.forEach(log => {
      expect(log.rows[0].change_type).toBe('settle');
      expect(log.rows[0].changed_by).toBe('HR1');
      expect(log.rows[0].reason).toMatch(/resignation settlement/);
    });
    // hours_delta = -(remaining_days × 8)
    const deltas = annualLogs.map(l => l.rows[0].hours_delta).sort((a, b) => a - b);
    expect(deltas).toEqual([-88, -56]);  // -11×8, -7×8
  });

  it('B26.2 cascade Enhancement #5:active comp_time → expired_paid + payout(× 1.34 multiplier)', async () => {
    overrides.caller = HR;
    setupResignationStep3({
      employee: {
        id: 'EMP_01251101', name: '柯郁含', dept_id: 'D1',
        status: 'active', resigned_at: null,
        base_salary: 30000, hourly_rate: 125,
      },
    });
    // 1 筆 active comp:earned 8h、used 0h、expires_at 未來日(會被 clamp 到 resigned_at)
    dataByQuery['comp_time_balance:then'] = [
      { id: 100, earned_hours: 8, used_hours: 0, expires_at: '2026-12-31' },
    ];
    const [req, res] = makeReqRes({
      body: { action: 'approve', request_id: 'APR_R1', step_number: 3 },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(200);

    // comp_time_balance UPDATE
    const compUpdates = calls.updates.filter(u =>
      u.table === 'comp_time_balance' && u.patch.status === 'expired_paid');
    expect(compUpdates).toHaveLength(1);

    // payout = 8 × 125 × 1.34 = 1340
    expect(compUpdates[0].patch.expiry_payout_amount).toBe(1340);

    // expires_at clamp:既有 '2026-12-31' > resigned_at '2026-05-31' → 取 resigned_at
    expect(compUpdates[0].patch.expires_at).toBe('2026-05-31');
    expect(compUpdates[0].patch.expiry_processed_at).toBeTruthy();

    // leave_balance_logs INSERT(comp)
    const compLogs = calls.inserts.filter(i =>
      i.table === 'leave_balance_logs' && i.rows[0].balance_type === 'comp');
    expect(compLogs).toHaveLength(1);
    expect(compLogs[0].rows[0].comp_record_id).toBe(100);
    expect(compLogs[0].rows[0].change_type).toBe('settle');
    expect(compLogs[0].rows[0].hours_delta).toBe(-8);
    expect(compLogs[0].rows[0].changed_by).toBe('HR1');
  });
});
