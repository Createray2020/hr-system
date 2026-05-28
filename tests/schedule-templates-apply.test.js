// tests/schedule-templates-apply.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../lib/supabase.js', () => ({
  supabaseAdmin: { from: vi.fn() },
}));
vi.mock('../lib/auth.js', () => ({
  requireAuth: vi.fn(),
}));
const { mockSendPushToEmployees, mockCreateNotifications } = vi.hoisted(() => ({
  mockSendPushToEmployees: vi.fn(),
  mockCreateNotifications: vi.fn(),
}));
vi.mock('../lib/push.js', () => ({
  sendPushToEmployees: mockSendPushToEmployees,
  createNotifications: mockCreateNotifications,
}));

import handler from '../api/schedule-templates/[id]/apply.js';
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

function makeReq({ method = 'POST', id, body = {} } = {}) {
  return { method, query: { id }, body };
}

function setupMocks({ template, period, shiftTypes, existingOffDates = [] }) {
  const fromMock = vi.fn();
  supabaseAdmin.from.mockImplementation(fromMock);

  // 1. 撈 template
  fromMock.mockReturnValueOnce({
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data: template || null, error: null }),
  });

  // 2. 撈 period
  fromMock.mockReturnValueOnce({
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data: period || null, error: null }),
  });

  // 3. 撈 shift_types
  fromMock.mockReturnValueOnce({
    select: vi.fn().mockResolvedValue({ data: shiftTypes || [], error: null }),
  });

  // 4. 撈本 period 已有的員工 __OFF__ 日（default []、永遠 queue 以對應
  //     apply.js 無條件 fetch；早早 bail 的 test 此 mock 不會被消費）
  fromMock.mockReturnValueOnce({
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    then: (onF, onR) => Promise.resolve({
      data: existingOffDates.map(d => ({ work_date: d })),
      error: null,
    }).then(onF, onR),
  });

  // 5. upsert schedules
  fromMock.mockReturnValueOnce({
    upsert: vi.fn().mockResolvedValue({ error: null }),
  });
}

const validTemplate = {
  id: 'TPL_x', owner_id: 'E001', name: '我的班',
  pattern: { type: 'weekly', shifts: { '0': 'OFF', '1': 'ST001', '2': 'ST001', '3': 'ST001', '4': 'ST001', '5': 'ST001', '6': 'OFF' } },
};

// NOTE: validPeriod uses far-future dates (2099) to avoid time-bomb
// failures — apply.js compares period_start to real `new Date()`.
// If a test needs to exercise "period already started" logic, use a
// separate fixture with past dates.
const validPeriod = {
  id: 'P_E001_2026_05', employee_id: 'E001', status: 'draft',
  period_start: '2099-01-01', period_end: '2099-01-07',
};

const validShiftTypes = [
  { id: 'ST001', start_time: '09:00', end_time: '18:00', break_minutes: 60 },
  { id: 'ST002', start_time: '14:00', end_time: '23:00', break_minutes: 60 },
  { id: 'ST003', start_time: null, end_time: null, break_minutes: 0 },
];

describe('POST /api/schedule-templates/:id/apply', () => {
  beforeEach(() => vi.clearAllMocks());

  it('員工 + 自己 template 套自己 period → 200', async () => {
    requireAuth.mockResolvedValue({ id: 'E001', role: 'employee', is_manager: false });
    setupMocks({ template: validTemplate, period: validPeriod, shiftTypes: validShiftTypes });
    const req = makeReq({ id: 'TPL_x', body: { period_id: 'P_E001_2026_05' } });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.applied).toBeGreaterThan(0);
  });

  it('員工 + 別人的 template → 403 NOT_OWNER', async () => {
    requireAuth.mockResolvedValue({ id: 'OTHER', role: 'employee', is_manager: false });
    setupMocks({ template: validTemplate, period: validPeriod, shiftTypes: validShiftTypes });
    const req = makeReq({ id: 'TPL_x', body: { period_id: 'P_E001_2026_05' } });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toBe('NOT_OWNER');
  });

  it('員工 + period 不是 draft → 403 NOT_DRAFT', async () => {
    requireAuth.mockResolvedValue({ id: 'E001', role: 'employee', is_manager: false });
    setupMocks({
      template: validTemplate,
      period: { ...validPeriod, status: 'submitted' },
      shiftTypes: validShiftTypes,
    });
    const req = makeReq({ id: 'TPL_x', body: { period_id: 'P_E001_2026_05' } });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toBe('NOT_DRAFT');
  });

  it('沒帶 period_id → 400', async () => {
    requireAuth.mockResolvedValue({ id: 'E001' });
    const req = makeReq({ id: 'TPL_x', body: {} });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('NO_PERIOD_ID');
  });

  it('template 不存在 → 404', async () => {
    requireAuth.mockResolvedValue({ id: 'E001' });
    setupMocks({ template: null });
    const req = makeReq({ id: 'TPL_GHOST', body: { period_id: 'P_E001_2026_05' } });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(404);
    expect(res.body.error).toBe('TEMPLATE_NOT_FOUND');
  });

  it('pattern.type 不是 weekly → 400 PATTERN_INVALID', async () => {
    requireAuth.mockResolvedValue({ id: 'E001' });
    setupMocks({
      template: { ...validTemplate, pattern: { type: 'cycle' } },
    });
    const req = makeReq({ id: 'TPL_x', body: { period_id: 'P_E001_2026_05' } });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('PATTERN_INVALID');
  });

  it('Method GET → 405', async () => {
    requireAuth.mockResolvedValue({ id: 'E001' });
    const req = makeReq({ method: 'GET', id: 'TPL_x' });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(405);
  });

  // ── 員工已標 OFF 的日要跳過、不被範本覆蓋 ──────────────
  it('員工自套 + 無 existing OFF → applied=7, skipped_existing_off=0', async () => {
    requireAuth.mockResolvedValue({ id: 'E001', role: 'employee', is_manager: false });
    setupMocks({
      template: validTemplate,
      period: validPeriod,
      shiftTypes: validShiftTypes,
      existingOffDates: [],
    });
    const req = makeReq({ id: 'TPL_x', body: { period_id: 'P_E001_2026_05' } });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.applied).toBe(7);
    expect(res.body.skipped_existing_off).toBe(0);
  });

  it('員工自套 + 1 個 existing OFF 日 → 跳過該日', async () => {
    requireAuth.mockResolvedValue({ id: 'E001', role: 'employee', is_manager: false });
    setupMocks({
      template: validTemplate,
      period: validPeriod,
      shiftTypes: validShiftTypes,
      existingOffDates: ['2099-01-03'],
    });
    const req = makeReq({ id: 'TPL_x', body: { period_id: 'P_E001_2026_05' } });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.applied).toBe(6);
    expect(res.body.skipped_existing_off).toBe(1);
  });

  it('員工自套 + 多個 existing OFF 日 → 全跳過', async () => {
    requireAuth.mockResolvedValue({ id: 'E001', role: 'employee', is_manager: false });
    setupMocks({
      template: validTemplate,
      period: validPeriod,
      shiftTypes: validShiftTypes,
      existingOffDates: ['2099-01-02', '2099-01-05'],
    });
    const req = makeReq({ id: 'TPL_x', body: { period_id: 'P_E001_2026_05' } });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.applied).toBe(5);
    expect(res.body.skipped_existing_off).toBe(2);
  });

  it('HR 套全 OFF → applied=0、total=0、不發通知（早回值前置）', async () => {
    requireAuth.mockResolvedValue({ id: 'HR001', role: 'hr', is_manager: false });
    setupMocks({
      template: validTemplate,
      period: validPeriod,
      shiftTypes: validShiftTypes,
      existingOffDates: [
        '2099-01-01', '2099-01-02', '2099-01-03', '2099-01-04',
        '2099-01-05', '2099-01-06', '2099-01-07',
      ],
    });
    const req = makeReq({ id: 'TPL_x', body: { period_id: 'P_E001_2026_05' } });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.applied).toBe(0);
    expect(res.body.skipped_existing_off).toBe(7);
    expect(res.body.total).toBe(0);
    expect(mockSendPushToEmployees).not.toHaveBeenCalled();
    expect(mockCreateNotifications).not.toHaveBeenCalled();
  });
});
