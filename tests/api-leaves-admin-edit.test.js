// tests/api-leaves-admin-edit.test.js — P3.1 admin_edit action 覆蓋
//
// 對 api/leaves/[id].js 的 PUT body { action: 'admin_edit' } 路徑做 14 case 覆蓋:
//   - Role gate(hr / admin / ceo / chairman 通過、manager / employee 403)
//   - Forbidden fields(status / 時間 / 員工 / hours 等)
//   - Validation(leave_type 存在、proof_status enum、proof_due_at ISO)
//   - Audit handler_note 格式
//
// Mock 策略:
//   - lib/auth.js 的 requireRole 真實實作 role check(allowedRoles + allowManager opt)
//   - api/leaves/_repo.js mock 成 stateful、case 內覆寫 repoState
//   - lib/push.js no-op
//   - lib/supabase.js 不需 mock(整個 _repo.js 被 mock、其他 lib 純函式 import 無 side effect)

import { describe, it, expect, vi, beforeEach } from 'vitest';

const repoState = {
  leaveRequest: null,
  leaveTypeFinds: {},
  updatedPatches: [],
};
const overrides = { caller: null };

vi.mock('../lib/auth.js', () => ({
  requireAuth: vi.fn(async (req, res) => {
    if (!overrides.caller) { res.status(401).json({ error: 'Unauthorized' }); return null; }
    return overrides.caller;
  }),
  // 真實 role check:對齊 lib/auth.js::requireRole 行為
  requireRole: vi.fn(async (req, res, allowedRoles, opts = {}) => {
    if (!overrides.caller) { res.status(401).json({ error: 'Unauthorized' }); return null; }
    const allowManager = opts.allowManager === true;
    const passByRole = allowedRoles.includes(overrides.caller.role);
    const passByManager = allowManager && overrides.caller.is_manager === true;
    if (!passByRole && !passByManager) {
      res.status(403).json({ error: 'Forbidden: insufficient role' });
      return null;
    }
    return overrides.caller;
  }),
}));

vi.mock('../lib/push.js', () => ({
  sendPushToEmployees: vi.fn(async () => ({ sent: 0 })),
  createNotifications: vi.fn(async () => undefined),
}));

vi.mock('../api/leaves/_repo.js', () => ({
  makeLeaveRepo: () => ({
    findLeaveRequestById: vi.fn(async () => repoState.leaveRequest ? { ...repoState.leaveRequest } : null),
    findLeaveType: vi.fn(async (code) => repoState.leaveTypeFinds[code] || null),
    updateLeaveRequest: vi.fn(async (id, patch) => {
      repoState.updatedPatches.push({ id, patch });
      return { id, ...repoState.leaveRequest, ...patch };
    }),
    // 給 handler 其他 path 預留(本檔只測 admin_edit,但保持完整 shape)
    findEmployeeById: vi.fn(async () => null),
  }),
}));

const { default: handler } = await import('../api/leaves/[id].js');

function makeReqRes({ method = 'PUT', query = { id: 'L1' }, body = {} } = {}) {
  const res = {
    statusCode: 200, body: undefined,
    status(c) { this.statusCode = c; return this; },
    json(p)   { this.body = p; return this; },
  };
  return [{ method, query, body, headers: {} }, res];
}

beforeEach(() => {
  repoState.leaveRequest = {
    id: 'L1', employee_id: 'E1', leave_type: 'annual',
    status: 'approved', proof_status: 'submitted',
    proof_due_at: null, handler_note: null,
  };
  repoState.leaveTypeFinds = {
    personal: { code: 'personal', name_zh: '事假' },
    sick:     { code: 'sick',     name_zh: '病假' },
    annual:   { code: 'annual',   name_zh: '特休' },
  };
  repoState.updatedPatches = [];
  overrides.caller = null;
});

const HR  = { id: 'HR1', role: 'hr',       is_manager: false };
const ADM = { id: 'A1',  role: 'admin',    is_manager: false };
const CEO = { id: 'C1',  role: 'ceo',      is_manager: false };
const CHR = { id: 'CH1', role: 'chairman', is_manager: false };
const MGR = { id: 'M1',  role: 'employee', is_manager: true };
const EMP = { id: 'E1',  role: 'employee', is_manager: false };

// ════════════════════════════════════════════════════════════
// Cases 1-4: backoffice roles 通過、欄位寫入 + audit 正確
// ════════════════════════════════════════════════════════════
describe('admin_edit — 4 個 backoffice roles 通過', () => {
  it('Case 1: HR + leave_type=personal → 200, audit 含 leave_type annual→personal', async () => {
    overrides.caller = HR;
    const [req, res] = makeReqRes({ body: { action: 'admin_edit', leave_type: 'personal' } });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.audit).toMatch(/HR1 admin_edit: leave_type annual→personal/);
    const { patch } = repoState.updatedPatches[0];
    expect(patch.leave_type).toBe('personal');
    expect(patch.handler_note).toMatch(/^\[\d{4}-\d{2}-\d{2}\] HR1 admin_edit: leave_type annual→personal$/);
  });

  it('Case 2: admin + proof_status=not_required → 200, audit 含 proof_status submitted→not_required', async () => {
    overrides.caller = ADM;
    const [req, res] = makeReqRes({ body: { action: 'admin_edit', proof_status: 'not_required' } });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.audit).toMatch(/A1 admin_edit: proof_status submitted→not_required/);
    expect(repoState.updatedPatches[0].patch.proof_status).toBe('not_required');
  });

  it('Case 3: ceo + proof_due_at=2026-06-01T00:00:00+08:00 → 200, audit 含 null→ISO', async () => {
    overrides.caller = CEO;
    const newDue = '2026-06-01T00:00:00+08:00';
    const [req, res] = makeReqRes({ body: { action: 'admin_edit', proof_due_at: newDue } });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.audit).toMatch(/C1 admin_edit: proof_due_at null→/);
    expect(repoState.updatedPatches[0].patch.proof_due_at).toBe(newDue);
  });

  it('Case 4: chairman + leave_type=sick → 200', async () => {
    overrides.caller = CHR;
    const [req, res] = makeReqRes({ body: { action: 'admin_edit', leave_type: 'sick' } });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.audit).toMatch(/CH1 admin_edit: leave_type annual→sick/);
    expect(repoState.updatedPatches[0].patch.leave_type).toBe('sick');
  });
});

// ════════════════════════════════════════════════════════════
// Cases 5-6: non-backoffice roles 被 role gate 擋
// ════════════════════════════════════════════════════════════
describe('admin_edit — role gate 擋下 manager / employee', () => {
  it('Case 5: manager(is_manager=true、role=employee)→ 403(admin_edit 不開 allowManager)', async () => {
    overrides.caller = MGR;
    const [req, res] = makeReqRes({ body: { action: 'admin_edit', leave_type: 'sick' } });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
    expect(repoState.updatedPatches.length).toBe(0);
  });

  it('Case 6: employee → 403', async () => {
    overrides.caller = EMP;
    const [req, res] = makeReqRes({ body: { action: 'admin_edit', leave_type: 'sick' } });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
    expect(repoState.updatedPatches.length).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════
// Cases 7-10: FORBIDDEN_FIELDS defense in depth
// ════════════════════════════════════════════════════════════
describe('admin_edit — FORBIDDEN_FIELDS 擋下', () => {
  it('Case 7: HR + status=approved → 400 FORBIDDEN_FIELD', async () => {
    overrides.caller = HR;
    const [req, res] = makeReqRes({ body: { action: 'admin_edit', status: 'approved' } });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('FORBIDDEN_FIELD');
    expect(res.body.detail).toMatch(/status/);
    expect(repoState.updatedPatches.length).toBe(0);
  });

  it('Case 8: HR + start_at=... → 400 FORBIDDEN_FIELD', async () => {
    overrides.caller = HR;
    const [req, res] = makeReqRes({ body: { action: 'admin_edit', start_at: '2026-06-01T09:00:00+08:00' } });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('FORBIDDEN_FIELD');
    expect(res.body.detail).toMatch(/start_at/);
  });

  it('Case 9: HR + hours=8 → 400 FORBIDDEN_FIELD', async () => {
    overrides.caller = HR;
    const [req, res] = makeReqRes({ body: { action: 'admin_edit', hours: 8 } });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('FORBIDDEN_FIELD');
    expect(res.body.detail).toMatch(/hours/);
  });

  it('Case 10: HR + employee_id=EMP_99 → 400 FORBIDDEN_FIELD', async () => {
    overrides.caller = HR;
    const [req, res] = makeReqRes({ body: { action: 'admin_edit', employee_id: 'EMP_99' } });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('FORBIDDEN_FIELD');
    expect(res.body.detail).toMatch(/employee_id/);
  });
});

// ════════════════════════════════════════════════════════════
// Cases 11-13: Validation + NO_CHANGES
// ════════════════════════════════════════════════════════════
describe('admin_edit — validation', () => {
  it('Case 11: HR + leave_type=nonexistent → 400 INVALID_LEAVE_TYPE', async () => {
    overrides.caller = HR;
    const [req, res] = makeReqRes({ body: { action: 'admin_edit', leave_type: 'nonexistent' } });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('INVALID_LEAVE_TYPE');
    expect(repoState.updatedPatches.length).toBe(0);
  });

  it('Case 12: HR + proof_status=bad → 400 INVALID_PROOF_STATUS', async () => {
    overrides.caller = HR;
    const [req, res] = makeReqRes({ body: { action: 'admin_edit', proof_status: 'bad' } });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('INVALID_PROOF_STATUS');
    expect(repoState.updatedPatches.length).toBe(0);
  });

  it('Case 13: HR + body 無允許欄位 → 400 NO_CHANGES', async () => {
    overrides.caller = HR;
    const [req, res] = makeReqRes({ body: { action: 'admin_edit' } });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('NO_CHANGES');
    expect(repoState.updatedPatches.length).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════
// Case 14: 一次改多欄位、audit 都印出
// ════════════════════════════════════════════════════════════
describe('admin_edit — multi-field', () => {
  it('Case 14: HR + leave_type=sick + proof_status=not_required → audit 含兩欄位', async () => {
    overrides.caller = HR;
    const [req, res] = makeReqRes({ body: {
      action: 'admin_edit', leave_type: 'sick', proof_status: 'not_required',
    } });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.audit).toMatch(/leave_type annual→sick/);
    expect(res.body.audit).toMatch(/proof_status submitted→not_required/);
    const { patch } = repoState.updatedPatches[0];
    expect(patch.leave_type).toBe('sick');
    expect(patch.proof_status).toBe('not_required');
    // handler_note 同時含兩個欄位的記錄(用「、」分隔)
    expect(patch.handler_note).toMatch(/leave_type annual→sick、proof_status submitted→not_required/);
  });
});
