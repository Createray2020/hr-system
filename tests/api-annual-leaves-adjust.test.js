// tests/api-annual-leaves-adjust.test.js — Phase 2.x.4 self-guard
//
// 重點:HR 不可調整自己的特休 record(防自肥)。
// 既有 BACKOFFICE_ROLES gate 維持、純加 self-approval guard。

import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls = { updates: [], logs: [] };
const dataByQuery = {};
const overrides = { caller: null };

vi.mock('../api/leaves/_repo.js', () => ({
  makeLeaveRepo: vi.fn(() => ({
    listAnnualRecords: vi.fn(async () => dataByQuery['records'] || []),
    updateAnnualRecord: vi.fn(async (id, patch) => {
      calls.updates.push({ id, patch });
      const cur = (dataByQuery['records'] || []).find(r => r.id === id) || {};
      return { ...cur, ...patch };
    }),
    insertBalanceLog: vi.fn(async (row) => { calls.logs.push(row); return row; }),
  })),
}));

vi.mock('../lib/auth.js', () => ({
  requireRole: vi.fn(async (req, res, allowedRoles) => {
    if (!overrides.caller) { res.status(401).json({ error: 'Unauthorized' }); return null; }
    if (!allowedRoles.includes(overrides.caller.role)) {
      res.status(403).json({ error: 'Forbidden' });
      return null;
    }
    return overrides.caller;
  }),
}));

const { default: handler } = await import('../api/annual-leaves/[id].js');

function makeReqRes({ method = 'PUT', query = {}, body = {} } = {}) {
  const res = {
    statusCode: 200, body: undefined,
    status(c) { this.statusCode = c; return this; },
    json(p)   { this.body = p; return this; },
    end()     { return this; },
  };
  return [{ method, query, body, headers: {} }, res];
}

beforeEach(() => {
  calls.updates = []; calls.logs = [];
  for (const k of Object.keys(dataByQuery)) delete dataByQuery[k];
  overrides.caller = null;
});

describe('/api/annual-leaves/:id PUT — Phase 2.x.4 self-guard', () => {
  it('未登入 → 401', async () => {
    const [req, res] = makeReqRes({
      query: { id: '1' }, body: { granted_days: 14 },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(401);
  });

  it('一般員工 → 403(BACKOFFICE_ROLES gate)', async () => {
    overrides.caller = { id: 'E1', role: 'employee' };
    const [req, res] = makeReqRes({
      query: { id: '1' }, body: { granted_days: 14 },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
  });

  it('HR 調整別人的 granted_days → 200 + log 寫 changed_by=caller.id', async () => {
    overrides.caller = { id: 'HR1', role: 'hr' };
    dataByQuery['records'] = [{
      id: 1, employee_id: 'E1', granted_days: 14, used_days: 5, status: 'active',
    }];
    const [req, res] = makeReqRes({
      query: { id: '1' }, body: { granted_days: 16 },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    const upd = calls.updates[0];
    expect(upd.patch.granted_days).toBe(16);
    const log = calls.logs[0];
    expect(log.changed_by).toBe('HR1');
    expect(log.change_type).toBe('manual_adjust');
  });

  it('HR 調整自己 granted_days → 403(self-guard)', async () => {
    overrides.caller = { id: 'HR1', role: 'hr' };
    dataByQuery['records'] = [{
      id: 1, employee_id: 'HR1', granted_days: 14, used_days: 5, status: 'active',
    }];
    const [req, res] = makeReqRes({
      query: { id: '1' }, body: { granted_days: 20 },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
    expect(res.body?.error).toBe('CANNOT_ADJUST_OWN_ANNUAL_LEAVE');
    expect(calls.updates.length).toBe(0);
    expect(calls.logs.length).toBe(0);
  });

  it('HR 結算自己的 annual record(settle=true)→ 403(self-guard 也擋 settle)', async () => {
    overrides.caller = { id: 'HR1', role: 'hr' };
    dataByQuery['records'] = [{
      id: 1, employee_id: 'HR1', granted_days: 14, used_days: 5, status: 'active',
    }];
    const [req, res] = makeReqRes({
      query: { id: '1' }, body: { settle: true },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
    expect(res.body?.error).toBe('CANNOT_ADJUST_OWN_ANNUAL_LEAVE');
  });

  it('admin 調整自己 → 403', async () => {
    overrides.caller = { id: 'A1', role: 'admin' };
    dataByQuery['records'] = [{
      id: 1, employee_id: 'A1', granted_days: 14, used_days: 5, status: 'active',
    }];
    const [req, res] = makeReqRes({
      query: { id: '1' }, body: { granted_days: 20 },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
  });

  it('record 找不到 → 404', async () => {
    overrides.caller = { id: 'HR1', role: 'hr' };
    dataByQuery['records'] = [];
    const [req, res] = makeReqRes({
      query: { id: '999' }, body: { granted_days: 16 },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(404);
  });
});
