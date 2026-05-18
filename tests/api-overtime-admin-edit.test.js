// tests/api-overtime-admin-edit.test.js — P5.1:overtime_requests admin_edit cascade + audit
//
// 對 api/overtime-requests/[id]/admin-edit.js 覆蓋:
//   C1  hours only + comp_type='overtime_pay' → cascade estimated_pay、audit 含 hours、不含 estimated_pay
//   C2  hours only + comp_type='comp_leave'   → 不 cascade、audit 仍寫
//   C3  compensation_type only(comp_leave→overtime_pay)→ 不 cascade(沒改 hours)
//   C4  hours=0           → 400 invalid hours
//   C5  hours 負數        → 400 invalid hours
//   C6  compensation_type='invalid' → 400 invalid compensation_type
//   C7  黑名單欄位 only(status='approved')→ 過濾後 callerPatch 為空 → 400 no allowed fields
//   C8  caller role='employee' → 403(requireRole 擋)
//   C9  existing.admin_audit_note 已有 → 新 auditLine 在頂 + '\n' 分隔保留原文
//   C10 row 不存在 → 404
//
// Mock 策略(對齊 tests/api-attendance-admin-edit.test.js):
//   supabase: chain mock(實際 repo 被 mock 掉、不會打到 supabase、保留是為防 import 副作用)
//   auth.requireRole: 真實 check role list(對齊 lib/auth.js::requireRole semantics)
//   _repo.js makeOvertimeRepo: 替成 stateful stub
//   lib/overtime/pay-calc.js: 替成 vi.fn 回 overrides.payCalcReturn

import { describe, it, expect, vi, beforeEach } from 'vitest';

const repoState = {
  existing: null,
  monthlySalary: 60000,
  settings: { monthly_work_hours_base: 240,
              weekday_overtime_first_2h_rate: 1.34, weekday_overtime_after_2h_rate: 1.67,
              rest_day_overtime_first_2h_rate: 1.34, rest_day_overtime_after_2h_rate: 1.67 },
  holiday: null,
  updatedPatches: [],
};

const overrides = {
  caller: null,
  payCalcReturn: { amount: 999, breakdown: {} },
  hourlyRate: 250,
};

vi.mock('../lib/supabase.js', () => {
  // 整 chain 給 import 跑過、實際 query 不走這(被 _repo.js mock 攔)
  const c = {
    select: vi.fn(() => c), eq: vi.fn(() => c),
    update: vi.fn(() => c), insert: vi.fn(() => c),
    delete: vi.fn(() => c), maybeSingle: vi.fn(() => Promise.resolve({ data: null, error: null })),
    single: vi.fn(() => Promise.resolve({ data: null, error: null })),
    order: vi.fn(() => c), limit: vi.fn(() => c), or: vi.fn(() => c),
    gte: vi.fn(() => c), lte: vi.fn(() => c), in: vi.fn(() => c),
  };
  const client = { from: vi.fn(() => c) };
  return { supabase: client, supabaseAdmin: client };
});

vi.mock('../lib/auth.js', () => ({
  // 對齊 lib/auth.js::requireRole 真實 semantics:check role list、預設不開 allowManager
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

// stateful overtime repo stub
const mockMakeOvertimeRepo = vi.fn(() => ({
  findOvertimeRequestById: vi.fn(async () => repoState.existing ? { ...repoState.existing } : null),
  findEmployeeMonthlySalary: vi.fn(async () => repoState.monthlySalary),
  getSystemOvertimeSettings: vi.fn(async () => repoState.settings),
  findHolidayByDate: vi.fn(async () => repoState.holiday),
  updateOvertimeRequest: vi.fn(async (id, patch) => {
    repoState.updatedPatches.push({ id, patch });
    return { id, ...(repoState.existing || {}), ...patch };
  }),
}));
vi.mock('../api/overtime-requests/_repo.js', () => ({
  makeOvertimeRepo: mockMakeOvertimeRepo,
}));

// pay-calc lib mock
const mockCalculateOvertimePay = vi.fn(() => ({ ...overrides.payCalcReturn }));
const mockGetHourlyRate = vi.fn(() => overrides.hourlyRate);
vi.mock('../lib/overtime/pay-calc.js', () => ({
  calculateOvertimePay: mockCalculateOvertimePay,
  getHourlyRate: mockGetHourlyRate,
}));

const { default: handler } = await import('../api/overtime-requests/[id]/admin-edit.js');

function makeReqRes({ method = 'PUT', query = { id: 'OT1' }, body = {} } = {}) {
  const res = {
    statusCode: 200, body: undefined,
    status(c) { this.statusCode = c; return this; },
    json(p)   { this.body = p; return this; },
    end()     { return this; },
  };
  return [{ method, query, body, headers: {} }, res];
}

beforeEach(() => {
  repoState.existing = null;
  repoState.holiday = null;
  repoState.updatedPatches = [];
  overrides.caller = { id: 'HR1', role: 'hr', is_manager: false, dept_id: 'D_HR' };
  overrides.payCalcReturn = { amount: 999, breakdown: {} };
  overrides.hourlyRate = 250;
  mockMakeOvertimeRepo.mockClear();
  mockCalculateOvertimePay.mockClear();
  mockGetHourlyRate.mockClear();
});

function setExisting(over = {}) {
  repoState.existing = {
    id: 'OT1', employee_id: 'E1', overtime_date: '2026-05-15',  // weekday (Fri)
    hours: 2, compensation_type: 'overtime_pay',
    estimated_pay: 700, pay_multiplier: 1.34,
    status: 'pending', admin_audit_note: null,
    ...over,
  };
}

// ════════════════════════════════════════════════════════════
describe('PUT /api/overtime-requests/:id/admin-edit', () => {

  it('C1: hours only + comp_type=overtime_pay → cascade estimated_pay、audit 含 hours、不含 estimated_pay', async () => {
    setExisting({ hours: 2, compensation_type: 'overtime_pay', estimated_pay: 700 });
    overrides.payCalcReturn = { amount: 1340, breakdown: {} };

    const [req, res] = makeReqRes({ body: { hours: 4 } });
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(mockCalculateOvertimePay).toHaveBeenCalledTimes(1);
    expect(mockGetHourlyRate).toHaveBeenCalledTimes(1);
    const upd = repoState.updatedPatches[0];
    expect(upd.patch.hours).toBe(4);
    expect(upd.patch.estimated_pay).toBe(1340);
    expect(upd.patch.admin_audit_note).toMatch(/hours 2→4/);
    expect(upd.patch.admin_audit_note).not.toMatch(/estimated_pay/);
  });

  it('C2: hours only + comp_type=comp_leave → 不 cascade estimated_pay、audit 仍寫', async () => {
    setExisting({ hours: 3, compensation_type: 'comp_leave', estimated_pay: 1000 });

    const [req, res] = makeReqRes({ body: { hours: 5 } });
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(mockCalculateOvertimePay).not.toHaveBeenCalled();
    expect(mockGetHourlyRate).not.toHaveBeenCalled();
    const upd = repoState.updatedPatches[0];
    expect(upd.patch.hours).toBe(5);
    expect(upd.patch).not.toHaveProperty('estimated_pay');  // 沒覆寫
    expect(upd.patch.admin_audit_note).toMatch(/hours 3→5/);
  });

  it('C3: compensation_type only(comp_leave→overtime_pay)→ 不 cascade、audit 寫 compensation_type 變化', async () => {
    setExisting({ hours: 3, compensation_type: 'comp_leave' });

    const [req, res] = makeReqRes({ body: { compensation_type: 'overtime_pay' } });
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    // 沒改 hours、不 cascade(即使 finalCompType='overtime_pay')
    expect(mockCalculateOvertimePay).not.toHaveBeenCalled();
    const upd = repoState.updatedPatches[0];
    expect(upd.patch.compensation_type).toBe('overtime_pay');
    expect(upd.patch).not.toHaveProperty('estimated_pay');
    expect(upd.patch.admin_audit_note).toMatch(/compensation_type comp_leave→overtime_pay/);
  });

  it('C4: hours=0 → 400 invalid hours', async () => {
    setExisting({});
    const [req, res] = makeReqRes({ body: { hours: 0 } });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('invalid hours');
    expect(repoState.updatedPatches.length).toBe(0);
  });

  it('C5: hours 負數 → 400 invalid hours', async () => {
    setExisting({});
    const [req, res] = makeReqRes({ body: { hours: -2 } });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('invalid hours');
  });

  it('C6: compensation_type=invalid → 400', async () => {
    setExisting({});
    const [req, res] = makeReqRes({ body: { compensation_type: 'bogus' } });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('invalid compensation_type');
  });

  it('C7: 黑名單欄位 only(status=approved)→ 過濾後 callerPatch 空 → 400 no allowed fields', async () => {
    setExisting({});
    const [req, res] = makeReqRes({ body: { status: 'approved' } });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('no allowed fields to update');
    // 重要:不該動到 DB
    expect(repoState.updatedPatches.length).toBe(0);
  });

  it('C8: caller role=employee → 403(requireRole 擋)', async () => {
    overrides.caller = { id: 'E1', role: 'employee', is_manager: false };
    setExisting({});
    const [req, res] = makeReqRes({ body: { hours: 5 } });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
    expect(repoState.updatedPatches.length).toBe(0);
  });

  it('C9: existing.admin_audit_note 已有 → 新 line 在頂 + \\n 分隔保留原文', async () => {
    setExisting({
      hours: 2,
      admin_audit_note: '[2026-05-15] admin_edit by HR1: compensation_type undecided→overtime_pay',
    });

    const [req, res] = makeReqRes({ body: { hours: 3 } });
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    const upd = repoState.updatedPatches[0];
    const note = upd.patch.admin_audit_note;
    const lines = note.split('\n');
    expect(lines[0]).toMatch(/admin_edit by HR1: hours 2→3/);
    expect(lines[1]).toMatch(/admin_edit by HR1: compensation_type undecided→overtime_pay/);
  });

  it('C10: row 不存在 → 404', async () => {
    repoState.existing = null;
    const [req, res] = makeReqRes({ body: { hours: 5 } });
    await handler(req, res);
    expect(res.statusCode).toBe(404);
    expect(repoState.updatedPatches.length).toBe(0);
  });
});
