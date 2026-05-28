// tests/leave-quota.test.js
// 假期管理:quota_summary endpoint 用的 lib/leave/quota.js 純函式 +
// api/leaves/_repo.js 新 method sumLeaveDaysByTypeInYear 整合測試。
//
// 6 case 覆蓋:
//   1. 正常:sick 3 張單共 5 天 → used_count=3, used_days=5
//   2. 邊界:12/31 算當年、1/1 算隔年(驗證 start_at 半開區間值傳對)
//   3. 排除 status:rejected / cancelled / pending_mgr 不計入(走 .in('status',...))
//   4. 排除 deleted_at IS NOT NULL(走 .is('deleted_at', null)、B7 教訓的 .is mock 補齊)
//   5. 半天:days=0.5 正確累加
//   6. 空:零單 → used_count=0、used_days=0(非 null、白名單 code 仍要回 row)

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock supabase(供 _repo.js 用)─────────────────────────────
const sbCalls = { from: [], select: [], eq: [], in: [], gte: [], lt: [], is: [] };
let mockSelectResult = { data: [], error: null };

vi.mock('../lib/supabase.js', () => {
  function chain(table) {
    const c = {};
    c.select = vi.fn((cols) => { sbCalls.select.push({ table, cols }); return c; });
    c.eq    = vi.fn((col, val)  => { sbCalls.eq.push({ table, col, val });   return c; });
    c.in    = vi.fn((col, vals) => { sbCalls.in.push({ table, col, vals }); return c; });
    c.gte   = vi.fn((col, val)  => { sbCalls.gte.push({ table, col, val });  return c; });
    c.lt    = vi.fn((col, val)  => { sbCalls.lt.push({ table, col, val });   return c; });
    c.is    = vi.fn((col, val)  => { sbCalls.is.push({ table, col, val });   return c; });
    c.order = vi.fn(() => c);
    c.limit = vi.fn(() => c);
    c.maybeSingle = vi.fn(() => Promise.resolve({ data: null, error: null }));
    c.single = vi.fn(() => Promise.resolve({ data: null, error: null }));
    // thenable:await q resolves to mockSelectResult
    c.then = (onF, onR) => Promise.resolve(mockSelectResult).then(onF, onR);
    return c;
  }
  const client = { from: vi.fn((t) => { sbCalls.from.push(t); return chain(t); }) };
  return { supabase: client, supabaseAdmin: client };
});

const { calculateAccumulatingUsage, ACCUMULATING_LEAVE_CODES, getCurrentYearInTaipei } =
  await import('../lib/leave/quota.js');
const { makeLeaveRepo } = await import('../api/leaves/_repo.js');

beforeEach(() => {
  Object.keys(sbCalls).forEach((k) => { sbCalls[k] = []; });
  mockSelectResult = { data: [], error: null };
});

// ═══════════════════════════════════════════════════════════
describe('lib/leave/quota.js — 匯出常數與小 helper', () => {
  it('ACCUMULATING_LEAVE_CODES 只含 sick + personal', () => {
    expect(ACCUMULATING_LEAVE_CODES).toEqual(['sick', 'personal']);
  });

  it('getCurrentYearInTaipei 回 4 位數 number', () => {
    const y = getCurrentYearInTaipei();
    expect(typeof y).toBe('number');
    expect(y).toBeGreaterThan(2000);
    expect(y).toBeLessThan(2100);
  });
});

// ═══════════════════════════════════════════════════════════
describe('lib/leave/quota.js — calculateAccumulatingUsage', () => {
  let mockRepo;
  beforeEach(() => {
    mockRepo = { sumLeaveDaysByTypeInYear: vi.fn() };
  });

  // Case 2:邊界值傳對 — 帶 Taipei +08:00 offset 防 PG cast 成 UTC 半夜歸錯年度
  it('Case 2:傳給 repo 的邊界值是 YYYY-01-01T00:00:00+08:00 半開區間', async () => {
    mockRepo.sumLeaveDaysByTypeInYear.mockResolvedValue([]);
    await calculateAccumulatingUsage(mockRepo, {
      employee_id: 'E001', year: 2026, codes: ['sick', 'personal'],
    });
    expect(mockRepo.sumLeaveDaysByTypeInYear).toHaveBeenCalledWith({
      employee_id: 'E001',
      codes: ['sick', 'personal'],
      startInclusive: '2026-01-01T00:00:00+08:00',
      endExclusive: '2027-01-01T00:00:00+08:00',
    });
  });

  // Case 6:空 — repo 沒回任何 row 仍要為每個 code 補 zero(非 null)
  it('Case 6:零單 → 每個 code 都回 { used_days: 0, used_count: 0 }', async () => {
    mockRepo.sumLeaveDaysByTypeInYear.mockResolvedValue([]);
    const result = await calculateAccumulatingUsage(mockRepo, {
      employee_id: 'E001', year: 2026, codes: ['sick', 'personal'],
    });
    expect(result).toEqual([
      { code: 'sick',     used_days: 0, used_count: 0 },
      { code: 'personal', used_days: 0, used_count: 0 },
    ]);
  });

  it('Case 6b:repo 只回部分 code → 缺的 code 補 zero(防 repo 沒對齊 zero-fill 仍 graceful)', async () => {
    mockRepo.sumLeaveDaysByTypeInYear.mockResolvedValue([
      { code: 'sick', used_days: 2, used_count: 1 },
    ]);
    const result = await calculateAccumulatingUsage(mockRepo, {
      employee_id: 'E001', year: 2026, codes: ['sick', 'personal'],
    });
    expect(result).toEqual([
      { code: 'sick',     used_days: 2, used_count: 1 },
      { code: 'personal', used_days: 0, used_count: 0 },
    ]);
  });

  it('throw 若 repo 沒 sumLeaveDaysByTypeInYear method', async () => {
    await expect(
      calculateAccumulatingUsage({}, { employee_id: 'E001', year: 2026, codes: ['sick'] }),
    ).rejects.toThrow();
  });

  it('throw 若缺 employee_id / year / codes', async () => {
    await expect(
      calculateAccumulatingUsage(mockRepo, { year: 2026, codes: ['sick'] }),
    ).rejects.toThrow();
    await expect(
      calculateAccumulatingUsage(mockRepo, { employee_id: 'E001', codes: ['sick'] }),
    ).rejects.toThrow();
    await expect(
      calculateAccumulatingUsage(mockRepo, { employee_id: 'E001', year: 2026, codes: [] }),
    ).rejects.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════
describe('api/leaves/_repo.js — sumLeaveDaysByTypeInYear', () => {
  // Case 1:正常 — sick 3 張單共 5 天
  it('Case 1:sick 3 張單共 5 天 → used_count=3, used_days=5', async () => {
    mockSelectResult = {
      data: [
        { leave_type: 'sick', days: 2,   id: 'L1' },
        { leave_type: 'sick', days: 2.5, id: 'L2' },
        { leave_type: 'sick', days: 0.5, id: 'L3' },
      ],
      error: null,
    };
    const repo = makeLeaveRepo();
    const result = await repo.sumLeaveDaysByTypeInYear({
      employee_id: 'E001',
      codes: ['sick', 'personal'],
      startInclusive: '2026-01-01',
      endExclusive: '2027-01-01',
    });
    // sick 3 張共 5 天
    const sick = result.find(r => r.code === 'sick');
    expect(sick).toEqual({ code: 'sick', used_days: 5, used_count: 3 });
    // personal 零單也要回 row
    const personal = result.find(r => r.code === 'personal');
    expect(personal).toEqual({ code: 'personal', used_days: 0, used_count: 0 });
  });

  // Case 3:排除 status — 走 .in('status', ['approved','archived'])
  it('Case 3:呼叫 .in(status, [approved, archived])(rejected/cancelled/pending 不在白名單)', async () => {
    mockSelectResult = { data: [], error: null };
    const repo = makeLeaveRepo();
    await repo.sumLeaveDaysByTypeInYear({
      employee_id: 'E001',
      codes: ['sick', 'personal'],
      startInclusive: '2026-01-01',
      endExclusive: '2027-01-01',
    });
    const statusFilter = sbCalls.in.find(c => c.col === 'status');
    expect(statusFilter).toBeDefined();
    expect(statusFilter.vals).toEqual(['approved', 'archived']);
  });

  // Case 4:排除 deleted_at — 走 .is('deleted_at', null)
  it('Case 4:呼叫 .is(deleted_at, null)(soft-delete 過濾、B7 教訓)', async () => {
    mockSelectResult = { data: [], error: null };
    const repo = makeLeaveRepo();
    await repo.sumLeaveDaysByTypeInYear({
      employee_id: 'E001',
      codes: ['sick'],
      startInclusive: '2026-01-01',
      endExclusive: '2027-01-01',
    });
    const deletedFilter = sbCalls.is.find(c => c.col === 'deleted_at');
    expect(deletedFilter).toBeDefined();
    expect(deletedFilter.val).toBeNull();
  });

  // Case 5:半天 — days=0.5 正確累加
  it('Case 5:半天 days=0.5 × 3 張 → used_days=1.5、used_count=3', async () => {
    mockSelectResult = {
      data: [
        { leave_type: 'sick', days: 0.5, id: 'L1' },
        { leave_type: 'sick', days: 0.5, id: 'L2' },
        { leave_type: 'sick', days: 0.5, id: 'L3' },
      ],
      error: null,
    };
    const repo = makeLeaveRepo();
    const result = await repo.sumLeaveDaysByTypeInYear({
      employee_id: 'E001',
      codes: ['sick'],
      startInclusive: '2026-01-01',
      endExclusive: '2027-01-01',
    });
    const sick = result.find(r => r.code === 'sick');
    expect(sick).toEqual({ code: 'sick', used_days: 1.5, used_count: 3 });
  });

  // Case 6 (repo 層):零單 — 白名單 code 仍要回 row 不可漏
  it('Case 6:零單 → 仍為每個白名單 code 回 { used_days: 0, used_count: 0 }', async () => {
    mockSelectResult = { data: [], error: null };
    const repo = makeLeaveRepo();
    const result = await repo.sumLeaveDaysByTypeInYear({
      employee_id: 'E001',
      codes: ['sick', 'personal'],
      startInclusive: '2026-01-01',
      endExclusive: '2027-01-01',
    });
    expect(result).toEqual([
      { code: 'sick',     used_days: 0, used_count: 0 },
      { code: 'personal', used_days: 0, used_count: 0 },
    ]);
  });

  it('多 code 混合 rows → 正確 group by leave_type', async () => {
    mockSelectResult = {
      data: [
        { leave_type: 'sick',     days: 2,   id: 'L1' },
        { leave_type: 'personal', days: 1,   id: 'L2' },
        { leave_type: 'sick',     days: 1.5, id: 'L3' },
        { leave_type: 'personal', days: 0.5, id: 'L4' },
      ],
      error: null,
    };
    const repo = makeLeaveRepo();
    const result = await repo.sumLeaveDaysByTypeInYear({
      employee_id: 'E001',
      codes: ['sick', 'personal'],
      startInclusive: '2026-01-01',
      endExclusive: '2027-01-01',
    });
    expect(result.find(r => r.code === 'sick'))
      .toEqual({ code: 'sick',     used_days: 3.5, used_count: 2 });
    expect(result.find(r => r.code === 'personal'))
      .toEqual({ code: 'personal', used_days: 1.5, used_count: 2 });
  });

  it('SQL 五條件 filter 都掛上 — eq employee_id / in leave_type / gte start_at / lt start_at / in status / is deleted_at', async () => {
    mockSelectResult = { data: [], error: null };
    const repo = makeLeaveRepo();
    await repo.sumLeaveDaysByTypeInYear({
      employee_id: 'E001',
      codes: ['sick', 'personal'],
      startInclusive: '2026-01-01',
      endExclusive: '2027-01-01',
    });
    // 走 leave_requests 表
    expect(sbCalls.from).toContain('leave_requests');
    // .eq('employee_id', 'E001')
    expect(sbCalls.eq.some(c => c.col === 'employee_id' && c.val === 'E001')).toBe(true);
    // .in('leave_type', ['sick','personal'])
    expect(sbCalls.in.some(c => c.col === 'leave_type' && c.vals.join(',') === 'sick,personal')).toBe(true);
    // .gte('start_at', '2026-01-01')
    expect(sbCalls.gte.some(c => c.col === 'start_at' && c.val === '2026-01-01')).toBe(true);
    // .lt('start_at', '2027-01-01')
    expect(sbCalls.lt.some(c => c.col === 'start_at' && c.val === '2027-01-01')).toBe(true);
    // .in('status', ['approved','archived'])
    expect(sbCalls.in.some(c => c.col === 'status')).toBe(true);
    // .is('deleted_at', null)
    expect(sbCalls.is.some(c => c.col === 'deleted_at' && c.val === null)).toBe(true);
  });
});
