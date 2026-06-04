// tests/api-leaves-quota-summary-comp-records.test.js
// 2026-06-05:quota_summary 補休段加 records[] 逐筆給 leave-admin detail modal 用
//
// 鎖定 contract:
//   - comp.records 為陣列、長度 = findActiveCompBalances 回的筆數
//   - 每筆含 { id, earned_at, earned_hours, expires_at, used_hours, remaining_hours, status }
//   - 順序維持 repo 既有 expires_at ASC, earned_at ASC(最早到期在前)
//   - 既有 total_remaining_hours / total_earned_hours / total_used_hours / earliest_expires_at 不變
//   - records 只含 active(沿用 findActiveCompBalances 範圍、本函式不過濾)

import { describe, it, expect, vi, beforeEach } from 'vitest';

const overrides = { caller: null, compBalances: [] };

// ─── mocks ────────────────────────────────────────────────────
vi.mock('../lib/supabase.js', () => {
  function chain(table) {
    const c = {};
    c.select = vi.fn(() => c);
    c.eq = vi.fn(() => c);
    c.in = vi.fn(() => c);
    c.is = vi.fn(() => c);
    c.neq = vi.fn(() => c);
    c.gte = vi.fn(() => c);
    c.lte = vi.fn(() => c);
    c.lt = vi.fn(() => c);
    c.gt = vi.fn(() => c);
    c.or = vi.fn(() => c);
    c.order = vi.fn(() => c);
    c.limit = vi.fn(() => c);
    c.single = vi.fn(() => Promise.resolve({ data: null, error: null }));
    c.maybeSingle = vi.fn(() => Promise.resolve({ data: null, error: null }));
    // handleQuotaSummary 對 leave_types 跑 .in('code', ...) 查 meta;回零陣列即可
    c.then = (onF, onR) => Promise.resolve({ data: [], error: null }).then(onF, onR);
    return c;
  }
  const client = { from: vi.fn((t) => chain(t)) };
  return { supabase: client, supabaseAdmin: client };
});

vi.mock('../lib/auth.js', () => ({
  requireAuth: vi.fn(async (req, res) => {
    if (!overrides.caller) { res.status(401).json({ error: 'Unauthorized' }); return null; }
    return overrides.caller;
  }),
  requireRole: vi.fn(async () => overrides.caller),
}));

// scope:本測試只測 comp.records 結構,讓 canSeeEmployee 一律 true 簡化
vi.mock('../lib/auth-scope.js', () => ({
  resolveAuthScopeWithDeptIds: vi.fn(async () => ({ mode: 'all' })),
  makeDeptEmpIdsRepo: vi.fn(() => ({})),
  canSeeEmployee: vi.fn(() => true),
}));

// getAnnualBalance:回固定 stub、不影響 comp 段
vi.mock('../lib/leave/balance.js', () => ({
  getAnnualBalance: vi.fn(async () => ({
    has_record: false,
    legal_days: 0, granted_days: 0, used_days: 0, remaining_days: 0,
    period_start: null, period_end: null,
  })),
}));

// 累積型 stub、不影響本 case
vi.mock('../lib/leave/quota.js', () => ({
  ACCUMULATING_LEAVE_CODES: ['sick', 'personal', 'menstrual', 'family_care'],
  calculateAccumulatingUsage: vi.fn(async () => []),
  getCurrentYearInTaipei: vi.fn(() => 2026),
}));

vi.mock('../lib/dept-name-mapper.js', () => ({
  addDeptName: vi.fn(),
  addDeptNameSingle: vi.fn(),
  addDeptNameNested: vi.fn(),
  attachManagerNames: vi.fn(async (rows) => rows),
}));

vi.mock('../lib/push.js', () => ({
  sendPushToEmployees: vi.fn(),
  sendPushToRoles: vi.fn(),
  createNotification: vi.fn(),
  createNotifications: vi.fn(),
  createNotificationsForRoles: vi.fn(),
}));

vi.mock('../api/leaves/_repo.js', () => ({
  makeLeaveRepo: vi.fn(() => ({
    findActiveCompBalances: vi.fn(async () => overrides.compBalances),
    // getAnnualBalance contract requires findAnnualRecordCoveringDate;
    // 但我們已 mock getAnnualBalance 整支、不會走到 repo,留空 noop 防呆
    findAnnualRecordCoveringDate: vi.fn(async () => null),
    sumLeaveDaysByTypeInYear: vi.fn(async () => []),
  })),
}));

const { default: handler } = await import('../api/leaves/index.js');

function makeReqRes({ query = {} } = {}) {
  const res = {
    statusCode: 200, body: undefined,
    status(c) { this.statusCode = c; return this; },
    json(p) { this.body = p; return this; },
    end() { return this; },
  };
  return [{ method: 'GET', query, body: null, headers: {} }, res];
}

beforeEach(() => {
  overrides.caller = { id: 'HR1', role: 'hr', is_manager: false, dept_id: null };
  overrides.compBalances = [];
});

// ═══════════════════════════════════════════════════════════
describe('handleQuotaSummary — comp.records 逐筆契約', () => {
  it('多筆 active comp_time_balance → records 為陣列、長度=3、每筆欄位齊全', async () => {
    overrides.compBalances = [
      // 已 repo expires_at ASC, earned_at ASC 排序
      { id: 32, earned_at: '2025-01-15T16:00:00+00:00', earned_hours: 142.5, expires_at: '2026-12-10', used_hours: 0,   remaining_hours: 142.5, status: 'active' },
      { id: 51, earned_at: '2025-10-11T16:00:00+00:00', earned_hours: 45.5,  expires_at: '2026-09-30', used_hours: 44,  remaining_hours: 1.5,   status: 'active' },
      { id: 52, earned_at: '2026-01-02T16:00:00+00:00', earned_hours: 7.5,   expires_at: '2026-10-02', used_hours: 6.13, remaining_hours: 1.37,  status: 'active' },
    ];
    const [req, res] = makeReqRes({ query: { _resource: 'quota_summary', employee_id: 'EMP_01191201' } });
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body.comp.records)).toBe(true);
    expect(res.body.comp.records).toHaveLength(3);
    // 順序維持 repo 既有
    expect(res.body.comp.records.map(r => r.id)).toEqual([32, 51, 52]);
    // 每筆欄位齊全
    for (const r of res.body.comp.records) {
      expect(r).toHaveProperty('id');
      expect(r).toHaveProperty('earned_at');
      expect(r).toHaveProperty('earned_hours');
      expect(r).toHaveProperty('expires_at');
      expect(r).toHaveProperty('used_hours');
      expect(r).toHaveProperty('remaining_hours');
      expect(r).toHaveProperty('status');
    }
    // 第一筆抽樣驗實值
    expect(res.body.comp.records[0]).toMatchObject({
      id: 32,
      earned_at: '2025-01-15T16:00:00+00:00',
      earned_hours: 142.5,
      expires_at: '2026-12-10',
      used_hours: 0,
      remaining_hours: 142.5,
      status: 'active',
    });
  });

  it('既有 total_* / active_balances_count / earliest_expires_at 不被破壞', async () => {
    overrides.compBalances = [
      { id: 51, earned_at: '2025-10-11T16:00:00+00:00', earned_hours: 45.5, expires_at: '2026-09-30', used_hours: 44,   remaining_hours: 1.5,  status: 'active' },
      { id: 52, earned_at: '2026-01-02T16:00:00+00:00', earned_hours: 7.5,  expires_at: '2026-10-02', used_hours: 6.13, remaining_hours: 1.37, status: 'active' },
    ];
    const [req, res] = makeReqRes({ query: { _resource: 'quota_summary', employee_id: 'EMP_01251001' } });
    await handler(req, res);

    expect(res.body.comp.active_balances_count).toBe(2);
    expect(res.body.comp.total_earned_hours).toBe(45.5 + 7.5);
    expect(res.body.comp.total_used_hours).toBe(44 + 6.13);
    // 不可因 records 加入而把總和算錯
    expect(res.body.comp.total_remaining_hours).toBeCloseTo(45.5 + 7.5 - 44 - 6.13, 5);
    // earliest_expires_at = 第一筆(repo 已 expires_at ASC)
    expect(res.body.comp.earliest_expires_at).toBe('2026-09-30');
  });

  it('空陣列(零 active 補休)→ records=[] 但欄位仍存在(前端可安全 iterate)', async () => {
    overrides.compBalances = [];
    const [req, res] = makeReqRes({ query: { _resource: 'quota_summary', employee_id: 'EMP_X' } });
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.comp.records).toEqual([]);
    expect(res.body.comp.active_balances_count).toBe(0);
    expect(res.body.comp.total_remaining_hours).toBe(0);
    expect(res.body.comp.earliest_expires_at).toBeNull();
  });

  it('Number 強轉:repo 回字串型數字仍 normalise 成 number', async () => {
    overrides.compBalances = [
      { id: 99, earned_at: '2026-01-01T00:00:00+00:00', earned_hours: '8', expires_at: '2027-01-01', used_hours: '2', remaining_hours: '6', status: 'active' },
    ];
    const [req, res] = makeReqRes({ query: { _resource: 'quota_summary', employee_id: 'EMP_Y' } });
    await handler(req, res);

    const rec = res.body.comp.records[0];
    expect(typeof rec.earned_hours).toBe('number');
    expect(typeof rec.used_hours).toBe('number');
    expect(typeof rec.remaining_hours).toBe('number');
    expect(rec.earned_hours).toBe(8);
    expect(rec.used_hours).toBe(2);
    expect(rec.remaining_hours).toBe(6);
  });

  it('未授權 → 401、不曝 records', async () => {
    overrides.caller = null;
    const [req, res] = makeReqRes({ query: { _resource: 'quota_summary', employee_id: 'X' } });
    await handler(req, res);
    expect(res.statusCode).toBe(401);
    expect(res.body?.comp).toBeUndefined();
  });
});
