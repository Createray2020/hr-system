// tests/api-approvals.test.js — Phase 2.x.1:approvals_v2 auth hotfix
//
// 重點:原本 handler 完全無 requireAuth、approver_id 由 client 傳、可亂簽。
// 修補後:
//   1. 無 auth → 401
//   2. self-approval(申請人本人簽自己)→ 403
//   3. role 不對 → 403
//   4. 跨 step 同人連簽 → 403
//   5. 偽造 approver_id(client 傳 != caller.id)→ 寫 caller.id、忽略 client
//   6. cancel:申請人本人 OK、其他 role → 403
//   7. chairman 視同 ceo OK、admin 不視同(嚴格 spec)
//   8. 'manager' step 用 dept+is_manager(對齊 leave Phase 2.x)

import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls = { tables: [], updates: [], inserts: [] };
const dataByQuery = {};      // 'table:single' / 'table:maybeSingle' / 'table:then' 控制
const overrides = { caller: null };

vi.mock('../lib/supabase.js', () => {
  function chain(table) {
    const c = {};
    let where = {};
    c.select = vi.fn(() => c);
    c.eq = vi.fn((col, val) => { where[col] = val; return c; });
    c.neq = vi.fn(() => c);
    c.in = vi.fn(() => c);
    c.is = vi.fn(() => c);    // 對齊 8c44806 soft-delete 加的 .is('deleted_at', null) filter
    c.gte = vi.fn(() => c); c.lte = vi.fn(() => c);
    c.order = vi.fn(() => c); c.limit = vi.fn(() => c);
    c.update = vi.fn((patch) => {
      calls.updates.push({ table, patch, where: { ...where } });
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
});

const E1   = { id: 'E1', role: 'employee', is_manager: false, dept_id: 'D1' };
const MGR  = { id: 'M1', role: 'employee', is_manager: true,  dept_id: 'D1' };
const MGR2 = { id: 'M2', role: 'employee', is_manager: true,  dept_id: 'D2' };
const HR   = { id: 'HR1', role: 'hr', is_manager: false, dept_id: 'D_HR' };
const CEO  = { id: 'C1', role: 'ceo', is_manager: false, dept_id: 'D_EXEC' };
const CHR  = { id: 'CH1', role: 'chairman', is_manager: false, dept_id: 'D_EXEC' };
const ADM  = { id: 'A1', role: 'admin', is_manager: false, dept_id: 'D_HR' };

// ════════════════════════════════════════════════════════════
// 整支 handler 加 requireAuth
// ════════════════════════════════════════════════════════════
describe('/api/approvals — 整支加 requireAuth', () => {
  it('GET 無 auth → 401', async () => {
    const [req, res] = makeReqRes({ method: 'GET' });
    await handler(req, res);
    expect(res.statusCode).toBe(401);
  });

  it('POST approve 無 auth → 401', async () => {
    const [req, res] = makeReqRes({
      body: { action: 'approve', request_id: 'APR1', step_number: 1 },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(401);
  });

  it('POST cancel 無 auth → 401', async () => {
    const [req, res] = makeReqRes({
      body: { action: 'cancel', request_id: 'APR1' },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(401);
  });
});

// ════════════════════════════════════════════════════════════
// approve action gate
// ════════════════════════════════════════════════════════════
describe('/api/approvals approve — gate', () => {
  // 預設場景:applicant=E1(dept_id=D1)、step 1 manager 階、in_progress
  function setupManagerStep(over = {}) {
    dataByQuery['approval_requests:single'] = {
      id: 'APR1', applicant_id: 'E1', total_steps: 2, status: 'pending',
      title: '補打卡', request_type: 'punch_correction', form_data: {},
      ...over.request,
    };
    dataByQuery['approval_steps:maybeSingle'] = {
      request_id: 'APR1', step_number: 1, approver_role: 'manager', status: 'in_progress',
      ...over.step,
    };
    dataByQuery['employees:maybeSingle'] = { dept_id: 'D1' };  // applicant dept
    dataByQuery['approval_steps:then'] = over.priorSteps || [];
  }

  it('申請人自己批 → 403(self-approval)', async () => {
    overrides.caller = E1;
    setupManagerStep();
    const [req, res] = makeReqRes({
      body: { action: 'approve', request_id: 'APR1', step_number: 1 },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
    expect(res.body?.error).toMatch(/不可審核自己/);
  });

  it('別部門主管批 manager 階 → 403(dept 不對、對齊 leave Phase 2.x)', async () => {
    overrides.caller = MGR2;  // dept_id=D2
    setupManagerStep();        // applicant dept=D1
    const [req, res] = makeReqRes({
      body: { action: 'approve', request_id: 'APR1', step_number: 1 },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
    expect(res.body?.error).toMatch(/無權審核/);
  });

  it('同部門主管批 manager 階 → 200 + approver_id=caller.id', async () => {
    overrides.caller = MGR;    // dept_id=D1
    setupManagerStep();
    const [req, res] = makeReqRes({
      body: { action: 'approve', request_id: 'APR1', step_number: 1, note: 'OK' },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    const upd = calls.updates.find(u => u.table === 'approval_steps' && u.patch.status === 'approved');
    expect(upd).toBeDefined();
    expect(upd.patch.approver_id).toBe('M1');
  });

  it('偽造 approver_id(client 傳 != caller.id)→ 仍寫 caller.id、忽略 client', async () => {
    overrides.caller = MGR;
    setupManagerStep();
    const [req, res] = makeReqRes({
      body: { action: 'approve', request_id: 'APR1', step_number: 1,
              approver_id: 'FAKE_BOSS', note: '' },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    const upd = calls.updates.find(u => u.table === 'approval_steps' && u.patch.status === 'approved');
    expect(upd.patch.approver_id).toBe('M1');
    expect(upd.patch.approver_id).not.toBe('FAKE_BOSS');
  });

  it('HR 批 manager 階 → 403(嚴格 spec、HR 不視同 manager 跨部門 bypass)', async () => {
    overrides.caller = HR;
    setupManagerStep();
    const [req, res] = makeReqRes({
      body: { action: 'approve', request_id: 'APR1', step_number: 1 },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
  });

  it('chairman 批 ceo 階 → 200(視同 ceo)', async () => {
    overrides.caller = CHR;
    setupManagerStep({
      step: { approver_role: 'ceo', step_number: 2 },
    });
    const [req, res] = makeReqRes({
      body: { action: 'approve', request_id: 'APR1', step_number: 2 },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
  });

  it('admin 批 ceo 階 → 403(嚴格 spec、admin 不視同 ceo)', async () => {
    overrides.caller = ADM;
    setupManagerStep({
      step: { approver_role: 'ceo', step_number: 2 },
    });
    const [req, res] = makeReqRes({
      body: { action: 'approve', request_id: 'APR1', step_number: 2 },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
  });

  it('admin 批 hr 階 → 403(admin 不視同 hr)', async () => {
    overrides.caller = ADM;
    setupManagerStep({
      step: { approver_role: 'hr', step_number: 2 },
    });
    const [req, res] = makeReqRes({
      body: { action: 'approve', request_id: 'APR1', step_number: 2 },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
  });

  it('CEO 批 ceo 階 → 200', async () => {
    overrides.caller = CEO;
    setupManagerStep({
      step: { approver_role: 'ceo', step_number: 2 },
    });
    const [req, res] = makeReqRes({
      body: { action: 'approve', request_id: 'APR1', step_number: 2 },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
  });

  it('step 已 approved → 409(此步驟非進行中)', async () => {
    overrides.caller = MGR;
    setupManagerStep({
      step: { status: 'approved' },
    });
    const [req, res] = makeReqRes({
      body: { action: 'approve', request_id: 'APR1', step_number: 1 },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(409);
  });

  it('跨 step 同人連簽 → 403(同 caller.id 已在 step 1 簽過、不能再簽 step 2)', async () => {
    overrides.caller = CEO;  // 假設 CEO 既是 step1 manager 也想簽 step2 ceo(極端 case、防雙簽)
    setupManagerStep({
      request: { total_steps: 2 },
      step: { approver_role: 'ceo', step_number: 2 },
      priorSteps: [
        { step_number: 1, status: 'approved', approver_id: 'C1' },
      ],
    });
    const [req, res] = makeReqRes({
      body: { action: 'approve', request_id: 'APR1', step_number: 2 },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
    expect(res.body?.error).toMatch(/不可跨 step 連簽/);
  });

  // ─── B32:CEO/chairman 可代簽 HR step(中小企業老闆兼 HR)──────────
  it('B32.1 CEO 批 hr 階(step 3、無前 step 連簽)→ 200 + step.note 含 CEO 代簽', async () => {
    overrides.caller = CEO;
    setupManagerStep({
      request: { total_steps: 3 },
      step: { approver_role: 'hr', step_number: 3 },
      priorSteps: [
        { step_number: 1, status: 'approved', approver_id: 'M1' },
        { step_number: 2, status: 'approved', approver_id: 'OTHER_CEO' }, // 不同人簽 step 2
      ],
    });
    const [req, res] = makeReqRes({
      body: { action: 'approve', request_id: 'APR1', step_number: 3 },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    const stepUpd = calls.updates.find(u =>
      u.table === 'approval_steps' && u.patch.status === 'approved');
    expect(stepUpd).toBeDefined();
    expect(stepUpd.patch.approver_id).toBe('C1');
    expect(stepUpd.patch.note).toMatch(/CEO 代簽 HR step/);
  });

  it('B32.2 chairman 批 hr 階(同人 step 2 已簽)→ 200(放寬跨 step guard)+ audit note', async () => {
    overrides.caller = CHR;
    setupManagerStep({
      request: { total_steps: 3 },
      step: { approver_role: 'hr', step_number: 3 },
      priorSteps: [
        { step_number: 1, status: 'approved', approver_id: 'M1' },
        { step_number: 2, status: 'approved', approver_id: 'CH1' }, // chairman 已簽 step 2
      ],
    });
    const [req, res] = makeReqRes({
      body: { action: 'approve', request_id: 'APR1', step_number: 3 },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    const stepUpd = calls.updates.find(u =>
      u.table === 'approval_steps' && u.patch.status === 'approved');
    expect(stepUpd.patch.note).toMatch(/CEO 代簽 HR step/);
  });

  it('B32.3 純 employee 批 hr 階 → 403', async () => {
    overrides.caller = E1;
    setupManagerStep({
      request: { applicant_id: 'OTHER_EMP', total_steps: 3 },  // 避開 self-approval guard
      step: { approver_role: 'hr', step_number: 3 },
    });
    dataByQuery['employees:maybeSingle'] = { dept_id: 'D2' };  // applicant 別 dept
    const [req, res] = makeReqRes({
      body: { action: 'approve', request_id: 'APR1', step_number: 3 },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
  });

  it('B32.4 GET ?type=pending&role=ceo 撈 step 2 + step 3 in_progress', async () => {
    overrides.caller = CEO;
    dataByQuery['approval_steps:then'] = [
      { request_id: 'APR_A', step_number: 2, approver_role: 'ceo', status: 'in_progress',
        approval_requests: { id: 'APR_A', applicant_id: 'E_a', employees: { dept_id: 'D1' } } },
      { request_id: 'APR_B', step_number: 3, approver_role: 'hr',  status: 'in_progress',
        approval_requests: { id: 'APR_B', applicant_id: 'E_b', employees: { dept_id: 'D2' } } },
    ];
    const [req, res] = makeReqRes({
      method: 'GET',
      query: { type: 'pending', role: 'ceo' },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveLength(2);
    const stepNums = res.body.map(s => s.step_number).sort();
    expect(stepNums).toEqual([2, 3]);
  });
});

// ════════════════════════════════════════════════════════════
// reject action gate(同 approve、self-guard + role gate)
// ════════════════════════════════════════════════════════════
describe('/api/approvals reject — gate', () => {
  it('申請人自己退回 → 403', async () => {
    overrides.caller = E1;
    dataByQuery['approval_requests:single'] = {
      id: 'APR1', applicant_id: 'E1', title: 'X', total_steps: 2,
    };
    const [req, res] = makeReqRes({
      body: { action: 'reject', request_id: 'APR1', step_number: 1 },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
  });

  it('合法 reviewer reject → 200 + approver_id=caller.id', async () => {
    overrides.caller = MGR;
    dataByQuery['approval_requests:single'] = {
      id: 'APR1', applicant_id: 'E1', title: 'X', total_steps: 2,
    };
    dataByQuery['approval_steps:maybeSingle'] = {
      request_id: 'APR1', step_number: 1, approver_role: 'manager', status: 'in_progress',
    };
    dataByQuery['employees:maybeSingle'] = { dept_id: 'D1' };
    const [req, res] = makeReqRes({
      body: { action: 'reject', request_id: 'APR1', step_number: 1, note: '時間不對' },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    const stepUpd = calls.updates.find(u => u.table === 'approval_steps' && u.patch.status === 'rejected');
    expect(stepUpd?.patch.approver_id).toBe('M1');
  });
});

// ════════════════════════════════════════════════════════════
// cancel action(申請人本人嚴守)
// ════════════════════════════════════════════════════════════
describe('/api/approvals cancel — 申請人本人嚴守', () => {
  it('申請人本人 cancel → 200', async () => {
    overrides.caller = E1;
    dataByQuery['approval_requests:maybeSingle'] = {
      id: 'APR1', applicant_id: 'E1', status: 'pending',
    };
    const [req, res] = makeReqRes({
      body: { action: 'cancel', request_id: 'APR1' },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
  });

  it('其他 employee cancel → 403', async () => {
    overrides.caller = { id: 'E2', role: 'employee' };
    dataByQuery['approval_requests:maybeSingle'] = {
      id: 'APR1', applicant_id: 'E1', status: 'pending',
    };
    const [req, res] = makeReqRes({
      body: { action: 'cancel', request_id: 'APR1' },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
  });

  it('HR cancel 別人的 → 403(HR 不能 bypass 申請人 own-check)', async () => {
    overrides.caller = HR;
    dataByQuery['approval_requests:maybeSingle'] = {
      id: 'APR1', applicant_id: 'E1', status: 'pending',
    };
    const [req, res] = makeReqRes({
      body: { action: 'cancel', request_id: 'APR1' },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
  });

  it('已 completed status cancel → 409', async () => {
    overrides.caller = E1;
    dataByQuery['approval_requests:maybeSingle'] = {
      id: 'APR1', applicant_id: 'E1', status: 'completed',
    };
    const [req, res] = makeReqRes({
      body: { action: 'cancel', request_id: 'APR1' },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(409);
  });
});

// ════════════════════════════════════════════════════════════
// create action — applicant_id 不可代他人
// ════════════════════════════════════════════════════════════
describe('/api/approvals create — applicant_id 強制 caller.id', () => {
  it('client 傳 applicant_id 跟 caller 不同 → 403', async () => {
    overrides.caller = E1;
    const [req, res] = makeReqRes({
      body: { action: 'create', request_type: 'punch_correction', applicant_id: 'OTHER_EMP' },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
    expect(res.body?.error).toMatch(/不可代他人/);
  });
});

// ════════════════════════════════════════════════════════════
// update_config — hr/admin only
// ════════════════════════════════════════════════════════════
describe('/api/approvals update_config — hr/admin only', () => {
  it('一般員工 → 403', async () => {
    overrides.caller = E1;
    const [req, res] = makeReqRes({
      body: { action: 'update_config', config_id: 1, steps: [] },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
  });

  it('CEO → 403(規範:只 hr/admin 改流程設定)', async () => {
    overrides.caller = CEO;
    const [req, res] = makeReqRes({
      body: { action: 'update_config', config_id: 1, steps: [] },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
  });

  it('HR → 200', async () => {
    overrides.caller = HR;
    const [req, res] = makeReqRes({
      body: { action: 'update_config', config_id: 1, steps: [] },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
  });
});

// ════════════════════════════════════════════════════════════
// P7.1: admin_edit action — backoffice 修正 form_data / attachments + audit
// ════════════════════════════════════════════════════════════
describe('/api/approvals admin_edit — backoffice only + audit', () => {
  function setupExisting(over = {}) {
    dataByQuery['approval_requests:maybeSingle'] = {
      id: 'APR1', applicant_id: 'E1', request_type: 'expense',
      title: '報銷', status: 'in_progress', current_step: 2, total_steps: 3,
      form_data: { amount: 1000, location: '台北' },
      attachments: [{ name: 'r1.pdf', url: 'u1' }],
      note: '', admin_audit_note: null,
      ...over,
    };
  }

  it('AE1: HR 改 form_data(amount + location)→ 200、audit 列 form_data.{amount, location} updated', async () => {
    overrides.caller = HR;
    setupExisting();
    const [req, res] = makeReqRes({
      body: { action: 'admin_edit', id: 'APR1',
              form_data: { amount: 2000, location: '高雄' } },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    const upd = calls.updates.find(u => u.table === 'approval_requests');
    expect(upd.patch.form_data).toEqual({ amount: 2000, location: '高雄' });
    expect(upd.patch.admin_audit_note).toMatch(/admin_edit by HR1: form_data\.\{amount, location\} updated/);
  });

  it('AE2: HR 改 attachments(漏附補) → 200、audit 列 attachments updated', async () => {
    overrides.caller = HR;
    setupExisting();
    const newAtt = [{ name: 'r1.pdf', url: 'u1' }, { name: 'r2.pdf', url: 'u2' }];
    const [req, res] = makeReqRes({
      body: { action: 'admin_edit', id: 'APR1', attachments: newAtt },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    const upd = calls.updates.find(u => u.table === 'approval_requests');
    expect(upd.patch.attachments).toEqual(newAtt);
    expect(upd.patch.admin_audit_note).toMatch(/admin_edit by HR1: attachments updated/);
  });

  it('AE3: HR 同時改 form_data + attachments → audit 同行含兩者', async () => {
    overrides.caller = HR;
    setupExisting();
    const [req, res] = makeReqRes({
      body: { action: 'admin_edit', id: 'APR1',
              form_data: { amount: 1500, location: '台北' },  // 只 amount 變
              attachments: [{ name: 'r2.pdf', url: 'u2' }] },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    const upd = calls.updates.find(u => u.table === 'approval_requests');
    expect(upd.patch.admin_audit_note).toMatch(/form_data\.\{amount\} updated/);
    expect(upd.patch.admin_audit_note).toMatch(/attachments updated/);
  });

  it('AE4: form_data 跟 existing 相同 → 400 no actual changes', async () => {
    overrides.caller = HR;
    setupExisting();
    const [req, res] = makeReqRes({
      body: { action: 'admin_edit', id: 'APR1',
              form_data: { amount: 1000, location: '台北' } },  // 同值
    });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('no actual changes');
    expect(calls.updates.find(u => u.table === 'approval_requests')).toBeUndefined();
  });

  it('AE5: caller role=employee → 403', async () => {
    overrides.caller = E1;
    setupExisting();
    const [req, res] = makeReqRes({
      body: { action: 'admin_edit', id: 'APR1', form_data: { amount: 2000 } },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
    expect(calls.updates.find(u => u.table === 'approval_requests')).toBeUndefined();
  });

  it('AE6: row 不存在 → 404', async () => {
    overrides.caller = HR;
    // dataByQuery['approval_requests:maybeSingle'] 不 set → null
    const [req, res] = makeReqRes({
      body: { action: 'admin_edit', id: 'NOT_EXIST', form_data: { amount: 1 } },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(404);
    expect(calls.updates.find(u => u.table === 'approval_requests')).toBeUndefined();
  });

  it('AE7: existing.admin_audit_note 已有 → 新 line 在頂 + \\n 分隔保留原文', async () => {
    overrides.caller = HR;
    setupExisting({
      admin_audit_note: '[2026-05-15] admin_edit by HR1: form_data.{location} updated',
    });
    const [req, res] = makeReqRes({
      body: { action: 'admin_edit', id: 'APR1', form_data: { amount: 3000, location: '台北' } },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    const upd = calls.updates.find(u => u.table === 'approval_requests');
    const lines = upd.patch.admin_audit_note.split('\n');
    expect(lines[0]).toMatch(/admin_edit by HR1: form_data\.\{amount\} updated/);
    expect(lines[1]).toMatch(/admin_edit by HR1: form_data\.\{location\} updated/);
  });
});

// ════════════════════════════════════════════════════════════
// B12: sole-manager dept self-approval skip
//   申請建立時、若 applicant 是 manager 且本部門無其他 active manager,
//   step 1 manager 自動標 status='skipped' + approver_id=null + audit note。
//   採 C 案(step row 留著、語義 'skipped' 對齊 schema 預留 enum)。
// ════════════════════════════════════════════════════════════
describe('/api/approvals create — B12 sole-manager dept self-approval skip', () => {
  // 共用 setup:approval_flow_configs.steps 對齊 prod punch_correction 3-step
  function setupCreateFlow({ applicant, otherMgrs = [] }) {
    dataByQuery['approval_flow_configs:single'] = {
      request_type: 'punch_correction',
      type_name: '補打卡',
      steps: [
        { step: 1, name: '主管審核',  role: 'manager' },
        { step: 2, name: '執行長核准', role: 'ceo' },
        { step: 3, name: 'HR 確認',   role: 'hr' },
      ],
    };
    dataByQuery['employees:maybeSingle'] = applicant;
    // findOtherActiveManagersInDept query 走 .then(回 array)
    dataByQuery['employees:then'] = otherMgrs;
  }

  function getStepInserts() {
    return calls.inserts.filter(i => i.table === 'approval_steps').map(i => i.rows[0]);
  }
  function getReqInsert() {
    return calls.inserts.find(i => i.table === 'approval_requests')?.rows[0];
  }

  it('B12.1 manager 自己送、dept 只有自己一個 manager → step 1 skipped、step 2 in_progress、current_step=2', async () => {
    overrides.caller = { id: 'M_SOLE', role: 'employee', is_manager: true, dept_id: 'D_SOLE' };
    setupCreateFlow({
      applicant: { id: 'M_SOLE', dept_id: 'D_SOLE', is_manager: true },
      otherMgrs: [],
    });
    const [req, res] = makeReqRes({
      body: { action: 'create', request_type: 'punch_correction', form_data: {} },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(201);
    expect(res.body.skipped_manager_step).toBe(true);

    const stepRows = getStepInserts();
    expect(stepRows).toHaveLength(3);

    // step 1: skipped + audit
    expect(stepRows[0].status).toBe('skipped');
    expect(stepRows[0].approver_id).toBeNull();
    expect(stepRows[0].handled_at).toBeTruthy();
    expect(stepRows[0].note).toMatch(/B12.*sole manager/);

    // step 2: in_progress(自動接手)
    expect(stepRows[1].status).toBe('in_progress');
    expect(stepRows[1].handled_at).toBeNull();

    // step 3: 仍 waiting
    expect(stepRows[2].status).toBe('waiting');

    // approval_requests.current_step = 2
    expect(getReqInsert().current_step).toBe(2);
    expect(getReqInsert().total_steps).toBe(3);
  });

  it('B12.2 manager 自己送、dept 還有其他 active manager → step 1 保持 in_progress(不 skip)', async () => {
    overrides.caller = { id: 'M1', role: 'employee', is_manager: true, dept_id: 'D_MULTI' };
    setupCreateFlow({
      applicant: { id: 'M1', dept_id: 'D_MULTI', is_manager: true },
      otherMgrs: [{ id: 'M2' }],  // 另一 active manager
    });
    const [req, res] = makeReqRes({
      body: { action: 'create', request_type: 'punch_correction', form_data: {} },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(201);
    expect(res.body.skipped_manager_step).toBe(false);

    const stepRows = getStepInserts();
    expect(stepRows[0].status).toBe('in_progress');
    expect(stepRows[0].note).toBe('');
    expect(stepRows[0].handled_at).toBeNull();
    expect(stepRows[1].status).toBe('waiting');
    expect(getReqInsert().current_step).toBe(1);
  });

  it('B12.3 employee 送(is_manager=false)→ step 1 正常 in_progress、不跑 sole-manager 偵測', async () => {
    overrides.caller = { id: 'E1', role: 'employee', is_manager: false, dept_id: 'D1' };
    setupCreateFlow({
      applicant: { id: 'E1', dept_id: 'D1', is_manager: false },
      otherMgrs: [],  // 不會被讀到(is_manager=false 路徑跳過 helper)
    });
    const [req, res] = makeReqRes({
      body: { action: 'create', request_type: 'punch_correction', form_data: {} },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(201);
    expect(res.body.skipped_manager_step).toBe(false);

    const stepRows = getStepInserts();
    expect(stepRows[0].status).toBe('in_progress');
    expect(stepRows[0].note).toBe('');
    expect(getReqInsert().current_step).toBe(1);
  });

  it('B12.4 manager 自己送、其他 manager 都 inactive/resigned → step 1 skipped(視同 sole)', async () => {
    overrides.caller = { id: 'M_LAST', role: 'employee', is_manager: true, dept_id: 'D_FADED' };
    setupCreateFlow({
      applicant: { id: 'M_LAST', dept_id: 'D_FADED', is_manager: true },
      otherMgrs: [],  // findOtherActiveManagersInDept WHERE status='active' filter 後回 []
    });
    const [req, res] = makeReqRes({
      body: { action: 'create', request_type: 'punch_correction', form_data: {} },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(201);
    expect(res.body.skipped_manager_step).toBe(true);

    const stepRows = getStepInserts();
    expect(stepRows[0].status).toBe('skipped');
    expect(stepRows[1].status).toBe('in_progress');
    expect(getReqInsert().current_step).toBe(2);
  });

  it('B12.5 multi-manager dept、其中一人 resigned 但另一人仍 active → 不 skip', async () => {
    overrides.caller = { id: 'M_ALIVE', role: 'employee', is_manager: true, dept_id: 'D_HALF' };
    setupCreateFlow({
      applicant: { id: 'M_ALIVE', dept_id: 'D_HALF', is_manager: true },
      otherMgrs: [{ id: 'M_OTHER_ALIVE' }],  // 對方還在
    });
    const [req, res] = makeReqRes({
      body: { action: 'create', request_type: 'punch_correction', form_data: {} },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(201);
    expect(res.body.skipped_manager_step).toBe(false);

    const stepRows = getStepInserts();
    expect(stepRows[0].status).toBe('in_progress');
    expect(getReqInsert().current_step).toBe(1);
  });
});
