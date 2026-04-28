// tests/schedule-templates.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../lib/supabase.js', () => ({
  supabaseAdmin: { from: vi.fn() },
}));
vi.mock('../lib/auth.js', () => ({
  requireAuth: vi.fn(),
}));

import indexHandler from '../api/schedule-templates/index.js';
import idHandler from '../api/schedule-templates/[id].js';
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

function makeReq({ method = 'GET', id, query = {}, body = {} } = {}) {
  return { method, query: id ? { ...query, id } : query, body };
}

const validPattern = {
  type: 'weekly',
  shifts: { '0': 'OFF', '1': 'ST001', '2': 'ST001', '3': 'ST002', '4': 'ST002', '5': 'ST001', '6': 'OFF' },
};

describe('POST /api/schedule-templates', () => {
  beforeEach(() => vi.clearAllMocks());

  it('員工 + valid pattern + is_shared=false → 201', async () => {
    requireAuth.mockResolvedValue({ id: 'E001', role: 'employee', is_manager: false });
    const fromMock = vi.fn().mockReturnValue({
      insert: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: { id: 'TPL_x', name: '我的標準班' }, error: null }),
    });
    supabaseAdmin.from.mockImplementation(fromMock);

    const req = makeReq({ method: 'POST', body: { name: '我的標準班', pattern: validPattern } });
    const res = makeRes();
    await indexHandler(req, res);
    expect(res.statusCode).toBe(201);
    expect(res.body.template.id).toBe('TPL_x');
  });

  it('員工 + is_shared=true → 403 CANNOT_SHARE_GLOBALLY', async () => {
    requireAuth.mockResolvedValue({ id: 'E001', role: 'employee', is_manager: false });
    const req = makeReq({ method: 'POST', body: { name: 'x', pattern: validPattern, is_shared: true } });
    const res = makeRes();
    await indexHandler(req, res);
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toBe('CANNOT_SHARE_GLOBALLY');
  });

  it('主管 + is_shared=true → ok', async () => {
    requireAuth.mockResolvedValue({ id: 'M1', role: 'employee', is_manager: true });
    const fromMock = vi.fn().mockReturnValue({
      insert: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: { id: 'TPL_y' }, error: null }),
    });
    supabaseAdmin.from.mockImplementation(fromMock);
    const req = makeReq({ method: 'POST', body: { name: 'x', pattern: validPattern, is_shared: true } });
    const res = makeRes();
    await indexHandler(req, res);
    expect(res.statusCode).toBe(201);
  });

  it('沒帶 name → 400 NAME_REQUIRED', async () => {
    requireAuth.mockResolvedValue({ id: 'E001' });
    const req = makeReq({ method: 'POST', body: { pattern: validPattern } });
    const res = makeRes();
    await indexHandler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('NAME_REQUIRED');
  });

  it('pattern.type !== weekly → 400 PATTERN_TYPE_INVALID', async () => {
    requireAuth.mockResolvedValue({ id: 'E001' });
    const req = makeReq({ method: 'POST', body: { name: 'x', pattern: { type: 'cycle', shifts: [] } } });
    const res = makeRes();
    await indexHandler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('PATTERN_TYPE_INVALID');
  });

  it('pattern.shifts 缺天 → 400 PATTERN_DAY_X_MISSING', async () => {
    requireAuth.mockResolvedValue({ id: 'E001' });
    const incomplete = { type: 'weekly', shifts: { '0': 'OFF', '1': 'ST001' } };
    const req = makeReq({ method: 'POST', body: { name: 'x', pattern: incomplete } });
    const res = makeRes();
    await indexHandler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/PATTERN_DAY_\d_MISSING/);
  });
});

describe('PUT/DELETE /api/schedule-templates/:id', () => {
  beforeEach(() => vi.clearAllMocks());

  function setupMocks(template) {
    const fromMock = vi.fn();
    supabaseAdmin.from.mockImplementation(fromMock);
    // 第一次：撈 template
    fromMock.mockReturnValueOnce({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: template, error: null }),
    });
    // 第二次：update / delete
    fromMock.mockReturnValueOnce({
      update: vi.fn().mockReturnThis(),
      delete: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: { ...template, name: 'updated' }, error: null }),
      then: undefined,
    });
  }

  it('PUT owner → 200', async () => {
    requireAuth.mockResolvedValue({ id: 'E001', role: 'employee', is_manager: false });
    setupMocks({ id: 'TPL_x', owner_id: 'E001', name: 'old' });
    const req = makeReq({ method: 'PUT', id: 'TPL_x', body: { name: 'new' } });
    const res = makeRes();
    await idHandler(req, res);
    expect(res.statusCode).toBe(200);
  });

  it('PUT 非 owner 非 HR → 403', async () => {
    requireAuth.mockResolvedValue({ id: 'OTHER', role: 'employee', is_manager: false });
    setupMocks({ id: 'TPL_x', owner_id: 'E001' });
    const req = makeReq({ method: 'PUT', id: 'TPL_x', body: { name: 'new' } });
    const res = makeRes();
    await idHandler(req, res);
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toBe('NOT_OWNER');
  });

  it('PUT HR 改別人的 → 200（HR override）', async () => {
    requireAuth.mockResolvedValue({ id: 'HR1', role: 'hr', is_manager: false });
    setupMocks({ id: 'TPL_x', owner_id: 'E001' });
    const req = makeReq({ method: 'PUT', id: 'TPL_x', body: { name: 'new' } });
    const res = makeRes();
    await idHandler(req, res);
    expect(res.statusCode).toBe(200);
  });

  it('PUT body 空 → 400 NO_FIELDS', async () => {
    requireAuth.mockResolvedValue({ id: 'E001' });
    setupMocks({ id: 'TPL_x', owner_id: 'E001' });
    const req = makeReq({ method: 'PUT', id: 'TPL_x', body: {} });
    const res = makeRes();
    await idHandler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('NO_FIELDS');
  });

  it('DELETE owner → 200', async () => {
    requireAuth.mockResolvedValue({ id: 'E001' });
    const fromMock = vi.fn();
    supabaseAdmin.from.mockImplementation(fromMock);
    fromMock.mockReturnValueOnce({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'TPL_x', owner_id: 'E001' }, error: null }),
    });
    fromMock.mockReturnValueOnce({
      delete: vi.fn().mockReturnThis(),
      eq: vi.fn().mockResolvedValue({ error: null }),
    });
    const req = makeReq({ method: 'DELETE', id: 'TPL_x' });
    const res = makeRes();
    await idHandler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.deleted).toBe(true);
  });

  it('GET template 不存在 → 404', async () => {
    requireAuth.mockResolvedValue({ id: 'E001' });
    const fromMock = vi.fn().mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    });
    supabaseAdmin.from.mockImplementation(fromMock);
    const req = makeReq({ method: 'GET', id: 'TPL_GHOST' });
    const res = makeRes();
    await idHandler(req, res);
    expect(res.statusCode).toBe(404);
  });
});
