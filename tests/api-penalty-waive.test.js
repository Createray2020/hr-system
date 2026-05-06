// tests/api-penalty-waive.test.js — Phase 2.x.4 self-guard
//
// 重點:HR 不可豁免自己的 penalty record(防權力濫用)。
// 既有 BACKOFFICE_ROLES gate 維持、純加 self-approval guard。

import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls = { updates: [] };
const dataByQuery = {};
const overrides = { caller: null };

vi.mock('../api/attendance-penalties/_repo.js', () => ({
  makeAttendancePenaltyRepo: vi.fn(() => ({
    findPenaltyRecordById: vi.fn(async () => dataByQuery['record'] || null),
    updatePenaltyRecord: vi.fn(async (id, patch) => {
      calls.updates.push({ id, patch });
      return { id, ...dataByQuery['record'], ...patch };
    }),
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

const { default: handler } = await import('../api/attendance-penalty-records/[id]/waive.js');

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
  calls.updates = [];
  for (const k of Object.keys(dataByQuery)) delete dataByQuery[k];
  overrides.caller = null;
});

describe('/api/attendance-penalty-records/:id/waive — Phase 2.x.4 self-guard', () => {
  it('未登入 → 401', async () => {
    const [req, res] = makeReqRes({
      query: { id: 'PR1' }, body: { waive_reason: '無' },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(401);
  });

  it('一般員工 → 403(BACKOFFICE_ROLES gate)', async () => {
    overrides.caller = { id: 'E1', role: 'employee' };
    const [req, res] = makeReqRes({
      query: { id: 'PR1' }, body: { waive_reason: '無' },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
  });

  it('HR 豁免別人的 penalty → 200 + waived_by=caller.id', async () => {
    overrides.caller = { id: 'HR1', role: 'hr' };
    dataByQuery['record'] = { id: 'PR1', employee_id: 'E1', status: 'pending' };
    const [req, res] = makeReqRes({
      query: { id: 'PR1' }, body: { waive_reason: '主管確認情況屬實' },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    const upd = calls.updates[0];
    expect(upd.patch.waived_by).toBe('HR1');
    expect(upd.patch.status).toBe('waived');
  });

  it('HR 豁免自己的 penalty → 403(self-guard)', async () => {
    overrides.caller = { id: 'HR1', role: 'hr' };
    dataByQuery['record'] = { id: 'PR1', employee_id: 'HR1', status: 'pending' };
    const [req, res] = makeReqRes({
      query: { id: 'PR1' }, body: { waive_reason: '我自己有事' },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
    expect(res.body?.error).toBe('CANNOT_WAIVE_OWN_PENALTY');
    // 不該寫入
    expect(calls.updates.length).toBe(0);
  });

  it('admin 豁免自己 → 403(同 self-guard)', async () => {
    overrides.caller = { id: 'A1', role: 'admin' };
    dataByQuery['record'] = { id: 'PR1', employee_id: 'A1', status: 'pending' };
    const [req, res] = makeReqRes({
      query: { id: 'PR1' }, body: { waive_reason: 'X' },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
  });

  it('record 找不到 → 404', async () => {
    overrides.caller = { id: 'HR1', role: 'hr' };
    const [req, res] = makeReqRes({
      query: { id: 'PR_404' }, body: { waive_reason: 'X' },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(404);
  });
});
