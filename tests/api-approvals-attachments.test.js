// tests/api-approvals-attachments.test.js
// Feature A:approval_requests 附件功能 — 兩個新 action 的 spec
//
//   action='sign_attachment_url':簽 60 秒 URL
//   action='add_attachment':append metadata + audit prepend
//
// 共用 OR gate:申請人本人 / backoffice / 該單 current step 的 eligible approver。
//
// 重點:
//   1. 無 auth → 401
//   2. path 不在該單 attachments → 403
//   3. 申請人 / backoffice / same-dept manager 各自 200
//   4. 一般員工 → 403
//   5. add_attachment append 後 attachments 陣列 +1、admin_audit_note prepend 一行
//   6. uploaded_by 強制用 caller.id、不信前端

import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls = { tables: [], updates: [], inserts: [], storage: [] };
const dataByQuery = {};
const overrides = { caller: null };
const storageMock = { signResult: { data: { signedUrl: 'https://signed.example/abc' }, error: null } };

vi.mock('../lib/supabase.js', () => {
  function chain(table) {
    const c = {};
    let where = {};
    c.select = vi.fn(() => c);
    c.eq = vi.fn((col, val) => { where[col] = val; return c; });
    c.neq = vi.fn(() => c);
    c.in  = vi.fn(() => c);
    c.is  = vi.fn(() => c);
    c.order = vi.fn(() => c); c.limit = vi.fn(() => c);
    c.update = vi.fn((patch) => { calls.updates.push({ table, patch }); return c; });
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
  const storage = {
    from: vi.fn((bucket) => ({
      createSignedUrl: vi.fn(async (path, ttl) => {
        calls.storage.push({ bucket, path, ttl });
        return storageMock.signResult;
      }),
    })),
  };
  const client = {
    from: vi.fn((table) => { calls.tables.push(table); return chain(table); }),
    storage,
  };
  return { supabase: client, supabaseAdmin: client };
});

vi.mock('../lib/auth.js', () => ({
  requireAuth: vi.fn(async (req, res) => {
    if (!overrides.caller) { res.status(401).json({ error: 'Unauthorized' }); return null; }
    return overrides.caller;
  }),
}));

vi.mock('../lib/push.js', () => ({
  sendPushToEmployees: vi.fn(async () => ({})),
  sendPushToRoles:     vi.fn(async () => ({})),
  createNotifications: vi.fn(async () => undefined),
  createNotificationsForRoles: vi.fn(async () => undefined),
}));

vi.mock('../lib/dept-name-mapper.js', () => ({
  addDeptName: vi.fn(),
  addDeptNameSingle: vi.fn(),
  addDeptNameNested: vi.fn(),
}));

const { default: handler } = await import('../api/approvals.js');

function makeReqRes({ body = {} } = {}) {
  const res = {
    statusCode: 200, body: undefined,
    status(c) { this.statusCode = c; return this; },
    json(p)   { this.body = p; return this; },
    end()     { return this; },
  };
  return [{ method: 'POST', query: {}, body, headers: {} }, res];
}

beforeEach(() => {
  calls.tables = []; calls.updates = []; calls.inserts = []; calls.storage = [];
  for (const k of Object.keys(dataByQuery)) delete dataByQuery[k];
  overrides.caller = null;
  storageMock.signResult = { data: { signedUrl: 'https://signed.example/abc' }, error: null };
});

const APPLICANT = { id: 'E_APPL', role: 'employee', is_manager: false, dept_id: 'D1' };
const MGR_SAME  = { id: 'E_MGR1', role: 'employee', is_manager: true,  dept_id: 'D1' };
const MGR_OTHER = { id: 'E_MGR2', role: 'employee', is_manager: true,  dept_id: 'D2' };
const HR        = { id: 'E_HR',   role: 'hr',       is_manager: false, dept_id: 'D_HR' };
const CEO       = { id: 'E_CEO',  role: 'ceo',      is_manager: false, dept_id: 'D_EXEC' };
const STRANGER  = { id: 'E_RAND', role: 'employee', is_manager: false, dept_id: 'D9' };

function setupRequest({ attachments = [], current_step = 1, status = 'pending', adminNote = null } = {}) {
  dataByQuery['approval_requests:single'] = {
    id: 'APR_X', applicant_id: 'E_APPL',
    current_step, total_steps: 3, status,
    attachments, admin_audit_note: adminNote,
  };
  // current step row(manager step、給 canApproveStep 判 same-dept)
  dataByQuery['approval_steps:maybeSingle'] = {
    request_id: 'APR_X', step_number: current_step,
    approver_role: 'manager', status: 'in_progress',
  };
  // 申請人 dept_id
  dataByQuery['employees:maybeSingle'] = { dept_id: 'D1' };
}

// ─── action='sign_attachment_url' ────────────────────────────────────────────
describe("POST /api/approvals action='sign_attachment_url'", () => {
  it('無 auth → 401', async () => {
    const [req, res] = makeReqRes({ body: { action: 'sign_attachment_url', request_id: 'APR_X', path: 'p/1' } });
    await handler(req, res);
    expect(res.statusCode).toBe(401);
  });

  it('找不到 request → 404', async () => {
    overrides.caller = APPLICANT;
    // 不 setupRequest、approval_requests:single 為 null
    const [req, res] = makeReqRes({ body: { action: 'sign_attachment_url', request_id: 'APR_X', path: 'p/1' } });
    await handler(req, res);
    expect(res.statusCode).toBe(404);
  });

  it('path 不屬於此 request → 403', async () => {
    overrides.caller = APPLICANT;
    setupRequest({ attachments: [{ path: 'p/REAL.pdf', name: 'r.pdf' }] });
    const [req, res] = makeReqRes({ body: { action: 'sign_attachment_url', request_id: 'APR_X', path: 'p/FAKE.pdf' } });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
    expect(res.body?.error).toContain('不屬於');
  });

  it('申請人本人 → 200 signedUrl', async () => {
    overrides.caller = APPLICANT;
    setupRequest({ attachments: [{ path: 'p/A.pdf', name: 'A.pdf' }] });
    const [req, res] = makeReqRes({ body: { action: 'sign_attachment_url', request_id: 'APR_X', path: 'p/A.pdf' } });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.signedUrl).toBe('https://signed.example/abc');
    expect(calls.storage[0]).toEqual({ bucket: 'leave-attachments', path: 'p/A.pdf', ttl: 60 });
  });

  it('HR(backoffice)→ 200', async () => {
    overrides.caller = HR;
    setupRequest({ attachments: [{ path: 'p/A.pdf', name: 'A.pdf' }] });
    const [req, res] = makeReqRes({ body: { action: 'sign_attachment_url', request_id: 'APR_X', path: 'p/A.pdf' } });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
  });

  it('CEO → 200', async () => {
    overrides.caller = CEO;
    setupRequest({ attachments: [{ path: 'p/A.pdf', name: 'A.pdf' }] });
    const [req, res] = makeReqRes({ body: { action: 'sign_attachment_url', request_id: 'APR_X', path: 'p/A.pdf' } });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
  });

  it('同部門 manager(current step approver) → 200', async () => {
    overrides.caller = MGR_SAME;
    setupRequest({ attachments: [{ path: 'p/A.pdf', name: 'A.pdf' }] });
    const [req, res] = makeReqRes({ body: { action: 'sign_attachment_url', request_id: 'APR_X', path: 'p/A.pdf' } });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
  });

  it('跨部門 manager → 403', async () => {
    overrides.caller = MGR_OTHER;
    setupRequest({ attachments: [{ path: 'p/A.pdf', name: 'A.pdf' }] });
    const [req, res] = makeReqRes({ body: { action: 'sign_attachment_url', request_id: 'APR_X', path: 'p/A.pdf' } });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
  });

  it('陌生員工 → 403', async () => {
    overrides.caller = STRANGER;
    setupRequest({ attachments: [{ path: 'p/A.pdf', name: 'A.pdf' }] });
    const [req, res] = makeReqRes({ body: { action: 'sign_attachment_url', request_id: 'APR_X', path: 'p/A.pdf' } });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
  });
});

// ─── action='add_attachment' ─────────────────────────────────────────────────
describe("POST /api/approvals action='add_attachment'", () => {
  const newAtt = {
    path: 'E_APPL/1717200000000_補件.pdf',
    name: '補件.pdf',
    mime: 'application/pdf',
    size: 2048,
    uploaded_at: '2026-06-01T10:00:00.000Z',
    uploaded_by: 'NOT_TRUSTED',  // 應被覆蓋成 caller.id
  };

  it('無 auth → 401', async () => {
    const [req, res] = makeReqRes({ body: { action: 'add_attachment', request_id: 'APR_X', attachment: newAtt } });
    await handler(req, res);
    expect(res.statusCode).toBe(401);
  });

  it('缺 path/name → 400', async () => {
    overrides.caller = APPLICANT;
    const [req, res] = makeReqRes({ body: { action: 'add_attachment', request_id: 'APR_X', attachment: { name: 'x.pdf' } } });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body?.error).toContain('path');
  });

  it('陌生員工 → 403', async () => {
    overrides.caller = STRANGER;
    setupRequest();
    const [req, res] = makeReqRes({ body: { action: 'add_attachment', request_id: 'APR_X', attachment: newAtt } });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
    expect(calls.updates.length).toBe(0);
  });

  it('申請人本人 → 200、append 後 attachments +1、uploaded_by 強制 caller.id', async () => {
    overrides.caller = APPLICANT;
    setupRequest({ attachments: [{ path: 'old/x.pdf', name: 'x.pdf' }] });
    const [req, res] = makeReqRes({ body: { action: 'add_attachment', request_id: 'APR_X', attachment: newAtt } });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.attachments.length).toBe(2);
    const added = res.body.attachments[1];
    expect(added.name).toBe('補件.pdf');
    expect(added.uploaded_by).toBe('E_APPL');  // ← 覆蓋成 caller.id、不採信 'NOT_TRUSTED'
    expect(added.mime).toBe('application/pdf');
    expect(added.size).toBe(2048);
    // update 同時寫了 attachments + admin_audit_note + updated_at
    const upd = calls.updates.find(u => u.table === 'approval_requests');
    expect(upd?.patch.attachments.length).toBe(2);
    expect(upd?.patch.admin_audit_note).toMatch(/attach by E_APPL: 補件\.pdf/);
  });

  it('HR 補件 + admin_audit_note prepend(新行在前)', async () => {
    overrides.caller = HR;
    setupRequest({ attachments: [], adminNote: '[2026-05-01] 之前的 audit' });
    const [req, res] = makeReqRes({ body: { action: 'add_attachment', request_id: 'APR_X', attachment: newAtt } });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    const upd = calls.updates.find(u => u.table === 'approval_requests');
    const note = upd?.patch.admin_audit_note || '';
    // 新行在第一行
    const firstLine = note.split('\n')[0];
    expect(firstLine).toContain('attach by E_HR: 補件.pdf');
    // 舊的還在第二行
    expect(note).toContain('[2026-05-01] 之前的 audit');
  });

  it('同部門 manager → 200(eligible approver of current step)', async () => {
    overrides.caller = MGR_SAME;
    setupRequest({ attachments: [] });
    const [req, res] = makeReqRes({ body: { action: 'add_attachment', request_id: 'APR_X', attachment: newAtt } });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
  });
});
