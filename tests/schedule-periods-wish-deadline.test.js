// tests/schedule-periods-wish-deadline.test.js
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

import handler from '../api/schedule-periods/[id]/wish-deadline.js';
import { supabaseAdmin } from '../lib/supabase.js';
import { requireAuth } from '../lib/auth.js';
import { logScheduleChange } from '../lib/schedule/change-logger.js';

function makeRes() {
  const res = {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(data) { this.body = data; return this; },
    end() { return this; },
  };
  return res;
}

function makeReq({ method = 'PUT', id = 'P1', body = {} } = {}) {
  return { method, query: { id }, body };
}

function setupSupabaseMocks({ period, updated, periodErr, updateErr } = {}) {
  const fromMock = vi.fn();
  supabaseAdmin.from.mockImplementation(fromMock);

  // 第一次 from() 撈 period
  fromMock.mockReturnValueOnce({
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data: period || null, error: periodErr || null }),
  });

  // 第二次 from() update
  fromMock.mockReturnValueOnce({
    update: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data: updated || period, error: updateErr || null }),
  });
}

describe('PUT /api/schedule-periods/[id]/wish-deadline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('員工 → 403 NOT_BACKOFFICE', async () => {
    requireAuth.mockResolvedValue({ id: 'E001', role: 'employee', is_manager: false });
    const req = makeReq({ body: { wish_deadline: '2026-04-30' } });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toBe('NOT_BACKOFFICE');
  });

  it('部門主管 → 403 NOT_BACKOFFICE', async () => {
    requireAuth.mockResolvedValue({ id: 'M1', role: 'employee', is_manager: true });
    const req = makeReq({ body: { wish_deadline: '2026-04-30' } });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toBe('NOT_BACKOFFICE');
  });

  it('HR + 有效日期 → 200 + update + log', async () => {
    requireAuth.mockResolvedValue({ id: 'HR1', role: 'hr', is_manager: false });
    setupSupabaseMocks({
      period: { id: 'P1', employee_id: 'E001', wish_deadline: '2026-04-25' },
      updated: { id: 'P1', employee_id: 'E001', wish_deadline: '2026-04-30' },
    });
    const req = makeReq({ body: { wish_deadline: '2026-04-30' } });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.period.wish_deadline).toBe('2026-04-30');
    expect(logScheduleChange).toHaveBeenCalled();
    // 驗 change_type 對 + before/after data
    const logCall = logScheduleChange.mock.calls[0][1];
    expect(logCall.change_type).toBe('hr_override_wish_deadline');
    expect(logCall.before_data.wish_deadline).toBe('2026-04-25');
    expect(logCall.after_data.wish_deadline).toBe('2026-04-30');
  });

  it('HR + null（清除截止日）→ 200', async () => {
    requireAuth.mockResolvedValue({ id: 'HR1', role: 'hr', is_manager: false });
    setupSupabaseMocks({
      period: { id: 'P1', employee_id: 'E001', wish_deadline: '2026-04-25' },
      updated: { id: 'P1', employee_id: 'E001', wish_deadline: null },
    });
    const req = makeReq({ body: { wish_deadline: null } });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.period.wish_deadline).toBeNull();
  });

  it('HR + 無效日期格式 → 400 INVALID_WISH_DEADLINE', async () => {
    requireAuth.mockResolvedValue({ id: 'HR1', role: 'hr', is_manager: false });
    const req = makeReq({ body: { wish_deadline: '2026/04/30' } });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('INVALID_WISH_DEADLINE');
  });

  it('HR + period 不存在 → 404 PERIOD_NOT_FOUND', async () => {
    requireAuth.mockResolvedValue({ id: 'HR1', role: 'hr', is_manager: false });
    setupSupabaseMocks({ period: null });
    const req = makeReq({ body: { wish_deadline: '2026-04-30' } });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(404);
    expect(res.body.error).toBe('PERIOD_NOT_FOUND');
  });

  it('Method GET → 405', async () => {
    requireAuth.mockResolvedValue({ id: 'HR1', role: 'hr' });
    const req = makeReq({ method: 'GET' });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(405);
  });
});
