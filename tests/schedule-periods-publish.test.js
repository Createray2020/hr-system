// tests/schedule-periods-publish.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../lib/supabase.js', () => ({
  supabaseAdmin: { from: vi.fn() },
}));
vi.mock('../lib/auth.js', () => ({
  requireAuth: vi.fn(),
}));
vi.mock('../lib/schedule/change-logger.js', () => ({
  logScheduleChange: vi.fn(),
}));
vi.mock('../lib/push.js', () => ({
  sendPushToEmployees: vi.fn(),
  createNotifications: vi.fn(),
}));

import handler from '../api/schedule-periods/[id]/publish.js';
import { supabaseAdmin } from '../lib/supabase.js';
import { requireAuth } from '../lib/auth.js';

function makeRes() {
  return {
    statusCode: null, body: null,
    status(c) { this.statusCode = c; return this; },
    json(d) { this.body = d; return this; },
    end() { return this; },
  };
}

function makeReq({ method = 'POST', id = 'P1' } = {}) {
  return { method, query: { id }, body: {} };
}

function setupMocks({ period, updated, empDeptId, withDeptLookup = false, withUpdate = false }) {
  const fromMock = vi.fn();
  supabaseAdmin.from.mockImplementation(fromMock);

  // 1. 撈 period（總是有）
  fromMock.mockReturnValueOnce({
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data: period || null, error: null }),
  });

  // 2. 撈 emp dept_id（只有 caller is_manager + dept_id 才會撈）
  if (withDeptLookup) {
    fromMock.mockReturnValueOnce({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: empDeptId !== undefined ? { dept_id: empDeptId } : null, error: null }),
    });
  }

  // 3. update status（只有 transition ok 才會走到）
  if (withUpdate) {
    fromMock.mockReturnValueOnce({
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: updated || period, error: null }),
    });
  }
}

describe('POST /api/schedule-periods/:id/publish — Phase 2.x.3 嚴格 spec', () => {
  beforeEach(() => vi.clearAllMocks());

  it('HR(is_manager=false)→ 403 NOT_MANAGER(原 isBackofficeRole bypass 拔)', async () => {
    requireAuth.mockResolvedValue({ id: 'HR1', role: 'hr', is_manager: false });
    setupMocks({
      period: { id: 'P1', employee_id: 'E001', status: 'approved' },
    });
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toBe('NOT_MANAGER');
  });

  it('同部門主管 + approved → 200', async () => {
    requireAuth.mockResolvedValue({ id: 'M1', role: 'employee', is_manager: true, dept_id: 'D1' });
    setupMocks({
      period: { id: 'P1', employee_id: 'E001', status: 'approved' },
      updated: { id: 'P1', status: 'published' },
      empDeptId: 'D1',
      withDeptLookup: true,
      withUpdate: true,
    });
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.statusCode).toBe(200);
  });

  it('非同部門主管 → 403 NOT_SAME_DEPT(原 NOT_MANAGER_OR_HR rename)', async () => {
    requireAuth.mockResolvedValue({ id: 'M2', role: 'employee', is_manager: true, dept_id: 'D2' });
    setupMocks({
      period: { id: 'P1', employee_id: 'E001', status: 'approved' },
      empDeptId: 'D1',
      withDeptLookup: true,
    });
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toBe('NOT_SAME_DEPT');
  });

  it('一般員工 → 403 NOT_MANAGER', async () => {
    requireAuth.mockResolvedValue({ id: 'E002', role: 'employee', is_manager: false });
    setupMocks({
      period: { id: 'P1', employee_id: 'E001', status: 'approved' },
    });
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toBe('NOT_MANAGER');
  });

  it('period status=submitted + 真主管 → 409 INVALID_TRANSITION(approve 才 submitted→approved、publish 只接 approved)', async () => {
    requireAuth.mockResolvedValue({ id: 'M1', role: 'employee', is_manager: true, dept_id: 'D1' });
    setupMocks({
      period: { id: 'P1', employee_id: 'E001', status: 'submitted' },
      empDeptId: 'D1',
      withDeptLookup: true,
    });
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.statusCode).toBe(409);
  });

  it('period 不存在 → 404(auth 雖過、period 沒撈到)', async () => {
    requireAuth.mockResolvedValue({ id: 'M1', role: 'employee', is_manager: true, dept_id: 'D1' });
    setupMocks({ period: null });
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.statusCode).toBe(404);
  });

  it('Method GET → 405', async () => {
    requireAuth.mockResolvedValue({ id: 'M1', role: 'employee', is_manager: true, dept_id: 'D1' });
    const res = makeRes();
    await handler(makeReq({ method: 'GET' }), res);
    expect(res.statusCode).toBe(405);
  });
});
