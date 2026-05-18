import { describe, it, expect, vi } from 'vitest';
import {
  calculateLeaveHours,
  submitLeaveRequest, approveLeaveRequest,
  rejectLeaveRequest, cancelLeaveRequest,
} from '../lib/leave/request-flow.js';

// Phase 1.2 加 advance/proof 欄位、預設值設成「最寬鬆」(advance_hours=0、不需證明)
// 避免 submitLeaveRequest 改造後既有 case 踩到前置時間 / 證明邏輯
const SEED_LT = {
  annual:    { code:'annual',    name_zh:'特休', is_paid:true,  has_balance:true,  is_active:true,
               advance_hours:0, advance_rule:'soft', requires_proof:false, proof_grace_days:0 },
  sick:      { code:'sick',      name_zh:'病假', is_paid:true,  has_balance:false, is_active:true,
               advance_hours:0, advance_rule:'soft', requires_proof:false, proof_grace_days:0 },
  personal:  { code:'personal',  name_zh:'事假', is_paid:false, has_balance:false, is_active:true,
               advance_hours:0, advance_rule:'soft', requires_proof:false, proof_grace_days:0 },
  comp:      { code:'comp',      name_zh:'補休', is_paid:true,  has_balance:true,  is_active:true,
               advance_hours:0, advance_rule:'soft', requires_proof:false, proof_grace_days:0 },
};

function makeRepo(over = {}) {
  const _now = '2026-04-26T12:00:00.000Z';
  const repo = {
    nowIso: () => _now,
    findLeaveType: vi.fn(async (code) => SEED_LT[code] || null),
    listActiveLeaveTypes: vi.fn(async () => Object.values(SEED_LT)),
    findSchedulesInRange: vi.fn(async () => []),
    findActiveAnnualRecord: vi.fn(async () => null),
    findEmployeeById: vi.fn(async (id) => ({ id, role: 'employee', is_manager: false, manager_id: 'M1' })),
    lockAndIncrementUsedDays: vi.fn(async () => ({ ok: true, record: { id: 1 } })),
    insertBalanceLog: vi.fn(async () => ({ id: 1 })),
    insertLeaveRequest: vi.fn(async (row) => ({ ...row })),
    findLeaveRequestById: vi.fn(async () => null),
    updateLeaveRequest: vi.fn(async (id, patch) => ({ id, ...patch })),
    ...over,
  };
  return repo;
}

const dayShift = (over = {}) => ({
  id: 'S1', employee_id: 'E001', work_date: '2026-04-27',
  start_time: '09:00', end_time: '18:00',
  crosses_midnight: false, scheduled_work_minutes: 480, // 9h-1h break
  // 2026-05-05 加:fixed break window(ST001 風格)
  break_start: '13:00', break_end: '14:00', break_minutes: 60,
  ...over,
});

describe('calculateLeaveHours', () => {
  it('整段請假涵蓋整段排班 → 8 hours(扣 break)', async () => {
    const repo = makeRepo({ findSchedulesInRange: vi.fn(async () => [dayShift()]) });
    const h = await calculateLeaveHours(repo, {
      employee_id: 'E001',
      start_at: '2026-04-27T09:00:00+08:00',
      end_at:   '2026-04-27T18:00:00+08:00',
    });
    expect(h).toBe(8);
  });

  it('半天請假(9-13)→ 4 hours(fixed break,午休 13-14 不在請假區間)', async () => {
    const repo = makeRepo({ findSchedulesInRange: vi.fn(async () => [dayShift()]) });
    const h = await calculateLeaveHours(repo, {
      employee_id: 'E001',
      start_at: '2026-04-27T09:00:00+08:00',
      end_at:   '2026-04-27T13:00:00+08:00',
    });
    // ST001 風格:break_start=13:00 break_end=14:00、請假 09-13 完全不跨午休
    // overlap = 4h、breakOverlap = 0、結果 = 4h
    // (原本 3.5h 是 ratio 攤算守 bug、2026-05-05 修)
    expect(h).toBe(4);
  });

  it('多段班(早+晚)各請半段 → 加總', async () => {
    const segs = [
      dayShift({ id:'S1', start_time:'09:00', end_time:'12:00', scheduled_work_minutes: 180 }),
      dayShift({ id:'S2', start_time:'14:00', end_time:'18:00', scheduled_work_minutes: 240 }),
    ];
    const repo = makeRepo({ findSchedulesInRange: vi.fn(async () => segs) });
    const h = await calculateLeaveHours(repo, {
      employee_id: 'E001',
      start_at: '2026-04-27T09:00:00+08:00',
      end_at:   '2026-04-27T18:00:00+08:00',
    });
    // S1 全段 180min + S2 全段 240min = 420 min = 7 hours
    expect(h).toBe(7);
  });

  it('沒排班 → 0 hours', async () => {
    const h = await calculateLeaveHours(makeRepo(), {
      employee_id: 'E001',
      start_at: '2026-04-27T09:00:00+08:00',
      end_at:   '2026-04-27T18:00:00+08:00',
    });
    expect(h).toBe(0);
  });

  it('end_at <= start_at → throw', async () => {
    await expect(calculateLeaveHours(makeRepo(), {
      employee_id: 'E001',
      start_at: '2026-04-27T18:00:00+08:00',
      end_at:   '2026-04-27T09:00:00+08:00',
    })).rejects.toThrow();
  });
});

describe('submitLeaveRequest', () => {
  it('annual + 餘額足夠 → 建立 pending', async () => {
    const repo = makeRepo({
      findSchedulesInRange: vi.fn(async () => [dayShift()]),
      findActiveAnnualRecord: vi.fn(async () => ({ id: 1, granted_days: 14, used_days: 0 })),
    });
    const r = await submitLeaveRequest(repo, {
      employee_id: 'E001', leave_type: 'annual',
      start_at: '2026-04-27T09:00:00+08:00',
      end_at:   '2026-04-27T18:00:00+08:00',
      reason: '出國',
    });
    expect(r.ok).toBe(true);
    expect(r.request.status).toBe('pending_mgr'); // Phase 1.2: 一般員工初始 stage
    expect(r.request.hours).toBe(8);
    expect(r.request.finalized_hours).toBe(null);
    expect(r.request.days).toBe(1); // legacy 欄位
  });

  it('annual + 餘額不足 → ok:false INSUFFICIENT_BALANCE', async () => {
    const repo = makeRepo({
      findSchedulesInRange: vi.fn(async () => [dayShift()]),
      findActiveAnnualRecord: vi.fn(async () => ({ id: 1, granted_days: 0.5, used_days: 0 })),
    });
    const r = await submitLeaveRequest(repo, {
      employee_id: 'E001', leave_type: 'annual',
      start_at: '2026-04-27T09:00:00+08:00',
      end_at:   '2026-04-27T18:00:00+08:00',
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('INSUFFICIENT_BALANCE');
  });

  it('annual + 沒 active record → NO_ACTIVE_ANNUAL_RECORD', async () => {
    const repo = makeRepo({
      findSchedulesInRange: vi.fn(async () => [dayShift()]),
    });
    const r = await submitLeaveRequest(repo, {
      employee_id: 'E001', leave_type: 'annual',
      start_at: '2026-04-27T09:00:00+08:00',
      end_at:   '2026-04-27T18:00:00+08:00',
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('NO_ACTIVE_ANNUAL_RECORD');
  });

  it('personal(不扣餘額)→ 不檢查 annual record,直接建', async () => {
    const repo = makeRepo({
      findSchedulesInRange: vi.fn(async () => [dayShift()]),
    });
    const r = await submitLeaveRequest(repo, {
      employee_id: 'E001', leave_type: 'personal',
      start_at: '2026-04-27T09:00:00+08:00',
      end_at:   '2026-04-27T18:00:00+08:00',
    });
    expect(r.ok).toBe(true);
    expect(repo.findActiveAnnualRecord).not.toHaveBeenCalled();
  });

  it('comp + 餘額足夠 → 建 pending', async () => {
    const repo = makeRepo({
      findSchedulesInRange: vi.fn(async () => [dayShift()]),
      findActiveCompBalances: vi.fn(async () => [
        { id: 1, earned_hours: 10, used_hours: 0, expires_at: '2026-12-31', earned_at: '2026-01-01T00:00:00Z' },
      ]),
    });
    const r = await submitLeaveRequest(repo, {
      employee_id: 'E001', leave_type: 'comp',
      start_at: '2026-04-27T09:00:00+08:00',
      end_at:   '2026-04-27T18:00:00+08:00',
    });
    expect(r.ok).toBe(true);
    expect(r.request.leave_type).toBe('comp');
  });

  it('comp + 餘額不足 → INSUFFICIENT_COMP_BALANCE', async () => {
    const repo = makeRepo({
      findSchedulesInRange: vi.fn(async () => [dayShift()]),
      findActiveCompBalances: vi.fn(async () => [
        { id: 1, earned_hours: 4, used_hours: 0, expires_at: '2026-12-31', earned_at: '2026-01-01T00:00:00Z' },
      ]),
    });
    const r = await submitLeaveRequest(repo, {
      employee_id: 'E001', leave_type: 'comp',
      start_at: '2026-04-27T09:00:00+08:00',
      end_at:   '2026-04-27T18:00:00+08:00',
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('INSUFFICIENT_COMP_BALANCE');
  });

  it('未知 leave_type → throw', async () => {
    await expect(submitLeaveRequest(makeRepo(), {
      employee_id: 'E001', leave_type: 'NOPE',
      start_at: '2026-04-27T09:00:00+08:00',
      end_at:   '2026-04-27T18:00:00+08:00',
    })).rejects.toThrow(/leave_type/);
  });
});

describe('approveLeaveRequest', () => {
  it('annual:重算時數,扣餘額,寫 finalized_hours', async () => {
    const req = {
      id: 'L1', employee_id: 'E001', leave_type: 'annual',
      start_at: '2026-04-27T09:00:00+08:00', end_at: '2026-04-27T18:00:00+08:00',
      hours: 8, finalized_hours: null, status: 'pending',
    };
    const repo = makeRepo({
      findLeaveRequestById: vi.fn(async () => req),
      findSchedulesInRange: vi.fn(async () => [dayShift()]),
      findActiveAnnualRecord: vi.fn(async () => ({ id: 1, granted_days: 14, used_days: 0 })),
    });
    const r = await approveLeaveRequest(repo, { request_id: 'L1', approved_by: 'M001' });
    expect(r.ok).toBe(true);
    expect(repo.lockAndIncrementUsedDays).toHaveBeenCalledWith({
      record_id: 1, delta_days: 1, allow_negative: false,
    });
    expect(repo.updateLeaveRequest).toHaveBeenCalled();
    const patch = repo.updateLeaveRequest.mock.calls[0][1];
    expect(patch.status).toBe('approved');
    expect(patch.finalized_hours).toBe(8);
  });

  it('comp:扣 comp_time_balance(FIFO),不扣 annual', async () => {
    const req = {
      id: 'L2', employee_id: 'E001', leave_type: 'comp',
      start_at: '2026-04-27T09:00:00+08:00', end_at: '2026-04-27T18:00:00+08:00',
      hours: 8, finalized_hours: null, status: 'pending',
    };
    const repo = makeRepo({
      findLeaveRequestById: vi.fn(async () => req),
      findSchedulesInRange: vi.fn(async () => [dayShift()]),
      findActiveCompBalances: vi.fn(async () => [
        { id: 1, earned_hours: 10, used_hours: 0, expires_at: '2026-12-31', earned_at: '2026-01-01T00:00:00Z' },
      ]),
      lockAndIncrementCompUsedHours: vi.fn(async () => ({ ok: true, record: { id: 1 } })),
    });
    const r = await approveLeaveRequest(repo, { request_id: 'L2', approved_by: 'M001' });
    expect(r.ok).toBe(true);
    expect(repo.lockAndIncrementUsedDays).not.toHaveBeenCalled(); // 不扣 annual
    expect(repo.lockAndIncrementCompUsedHours).toHaveBeenCalledWith({
      comp_id: 1, delta_hours: 8, allow_negative: false,
    });
    expect(repo.updateLeaveRequest.mock.calls[0][1].status).toBe('approved');
  });

  it('comp:跨多筆 FIFO 扣餘額(8h 跨兩筆 5+5)', async () => {
    const req = {
      id: 'L3', employee_id: 'E001', leave_type: 'comp',
      start_at: '2026-04-27T09:00:00+08:00', end_at: '2026-04-27T18:00:00+08:00',
      hours: 8, finalized_hours: null, status: 'pending',
    };
    const repo = makeRepo({
      findLeaveRequestById: vi.fn(async () => req),
      findSchedulesInRange: vi.fn(async () => [dayShift()]),
      findActiveCompBalances: vi.fn(async () => [
        { id: 10, earned_hours: 5, used_hours: 0, expires_at: '2026-06-30', earned_at: '2025-06-30T00:00:00Z' },
        { id: 11, earned_hours: 5, used_hours: 0, expires_at: '2026-12-31', earned_at: '2025-12-31T00:00:00Z' },
      ]),
      lockAndIncrementCompUsedHours: vi.fn(async () => ({ ok: true })),
    });
    const r = await approveLeaveRequest(repo, { request_id: 'L3', approved_by: 'M001' });
    expect(r.ok).toBe(true);
    // 第一筆扣 5h(全扣完),第二筆扣 3h
    expect(repo.lockAndIncrementCompUsedHours).toHaveBeenCalledTimes(2);
    expect(repo.lockAndIncrementCompUsedHours.mock.calls[0][0]).toEqual({
      comp_id: 10, delta_hours: 5, allow_negative: false,
    });
    expect(repo.lockAndIncrementCompUsedHours.mock.calls[1][0]).toEqual({
      comp_id: 11, delta_hours: 3, allow_negative: false,
    });
  });

  it('NOT_FOUND → 拒絕', async () => {
    const r = await approveLeaveRequest(makeRepo(), { request_id: 'L99', approved_by: 'HR1' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('NOT_FOUND');
  });

  it('已 approved 的不能再 approve', async () => {
    const repo = makeRepo({
      findLeaveRequestById: vi.fn(async () => ({ id: 'L1', status: 'approved', leave_type: 'annual' })),
    });
    const r = await approveLeaveRequest(repo, { request_id: 'L1', approved_by: 'HR1' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('NOT_PENDING');
  });
});

describe('rejectLeaveRequest', () => {
  it('reason 必填', async () => {
    const repo = makeRepo({
      findLeaveRequestById: vi.fn(async () => ({ id:'L1', status:'pending', leave_type:'annual' })),
    });
    const r = await rejectLeaveRequest(repo, { request_id: 'L1', rejected_by: 'HR1', reject_reason: '' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('REJECT_REASON_REQUIRED');
  });

  it('成功駁回 → status=rejected,不扣餘額', async () => {
    const repo = makeRepo({
      findLeaveRequestById: vi.fn(async () => ({ id:'L1', status:'pending', leave_type:'annual' })),
    });
    const r = await rejectLeaveRequest(repo, {
      request_id: 'L1', rejected_by: 'HR1', reject_reason: '資料不全',
    });
    expect(r.ok).toBe(true);
    expect(repo.updateLeaveRequest.mock.calls[0][1].status).toBe('rejected');
    expect(repo.lockAndIncrementUsedDays).not.toHaveBeenCalled();
  });
});

describe('cancelLeaveRequest', () => {
  it('本人 + pending → 撤回成功', async () => {
    const repo = makeRepo({
      findLeaveRequestById: vi.fn(async () => ({ id:'L1', employee_id:'E001', status:'pending' })),
    });
    const r = await cancelLeaveRequest(repo, { request_id: 'L1', cancelled_by: 'E001' });
    expect(r.ok).toBe(true);
    expect(repo.updateLeaveRequest.mock.calls[0][1].status).toBe('cancelled');
  });

  it('approved 之後不能撤回', async () => {
    const repo = makeRepo({
      findLeaveRequestById: vi.fn(async () => ({ id:'L1', employee_id:'E001', status:'approved' })),
    });
    const r = await cancelLeaveRequest(repo, { request_id: 'L1', cancelled_by: 'E001' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('NOT_PENDING');
  });

  it('別人不能撤本人的假', async () => {
    const repo = makeRepo({
      findLeaveRequestById: vi.fn(async () => ({ id:'L1', employee_id:'E001', status:'pending' })),
    });
    const r = await cancelLeaveRequest(repo, { request_id: 'L1', cancelled_by: 'E999' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('NOT_OWN_REQUEST');
  });

  // P3.1:cancel 同時清 proof_status='not_required'、防 cancelled row 被 cron 撈到
  it("撤回 pending_mgr → patch 含 proof_status='not_required'(defense in depth)", async () => {
    const repo = makeRepo({
      findLeaveRequestById: vi.fn(async () => ({ id:'L1', employee_id:'E001', status:'pending_mgr', proof_status: 'required' })),
    });
    const r = await cancelLeaveRequest(repo, { request_id: 'L1', cancelled_by: 'E001' });
    expect(r.ok).toBe(true);
    const patch = repo.updateLeaveRequest.mock.calls[0][1];
    expect(patch.status).toBe('cancelled');
    expect(patch.proof_status).toBe('not_required');
  });

  it("撤回 pending_ceo + proof_status='submitted' → 保留 submitted(歷史狀態不洗)", async () => {
    const repo = makeRepo({
      findLeaveRequestById: vi.fn(async () => ({ id:'L2', employee_id:'E001', status:'pending_ceo', proof_status: 'submitted' })),
    });
    const r = await cancelLeaveRequest(repo, { request_id: 'L2', cancelled_by: 'E001' });
    expect(r.ok).toBe(true);
    const patch = repo.updateLeaveRequest.mock.calls[0][1];
    expect(patch.status).toBe('cancelled');
    expect(patch.proof_status).toBeUndefined();  // 沒 set、保留原值
  });
});

// 三類 shift break 演算覆蓋(對應 lib/schedule/break-overlap.js 的 fixed/flexible/none 分流)
// 對應 prod Bug A(半天切點)+ Bug B(自訂時段多扣 break)、防退化
describe('submitLeaveRequest — 三類 shift break 演算覆蓋', () => {
  // ── fixed break (ST001 風格:break_start/end 有值)──
  it('fixed break:自訂 15:00-18:00 不跨午休 → hours=3、days=0.375', async () => {
    // dayShift 預設 ST001 風格(9-18、break 13-14)
    const repo = makeRepo({ findSchedulesInRange: vi.fn(async () => [dayShift()]) });
    const r = await submitLeaveRequest(repo, {
      employee_id: 'E001', leave_type: 'personal',
      start_at: '2026-04-27T15:00:00+08:00',
      end_at:   '2026-04-27T18:00:00+08:00',
    });
    expect(r.ok).toBe(true);
    // overlap=3h、午休 13-14 不在 15-18 內 → breakOverlap=0、結果 3h
    expect(r.request.hours).toBe(3);
    expect(r.request.days).toBe(0.375);
  });

  it('fixed break:上半段 09:00-13:00 → hours=4、days=0.5', async () => {
    const repo = makeRepo({ findSchedulesInRange: vi.fn(async () => [dayShift()]) });
    const r = await submitLeaveRequest(repo, {
      employee_id: 'E001', leave_type: 'personal',
      start_at: '2026-04-27T09:00:00+08:00',
      end_at:   '2026-04-27T13:00:00+08:00',
    });
    expect(r.ok).toBe(true);
    expect(r.request.hours).toBe(4);
    expect(r.request.days).toBe(0.5);
  });

  it('fixed break:下半段 14:00-18:00 → hours=4、days=0.5', async () => {
    const repo = makeRepo({ findSchedulesInRange: vi.fn(async () => [dayShift()]) });
    const r = await submitLeaveRequest(repo, {
      employee_id: 'E001', leave_type: 'personal',
      start_at: '2026-04-27T14:00:00+08:00',
      end_at:   '2026-04-27T18:00:00+08:00',
    });
    expect(r.ok).toBe(true);
    expect(r.request.hours).toBe(4);
    expect(r.request.days).toBe(0.5);
  });

  it('fixed break:跨午休 12:00-15:00 → hours=2(扣 13-14 那 1 小時)', async () => {
    const repo = makeRepo({ findSchedulesInRange: vi.fn(async () => [dayShift()]) });
    const r = await submitLeaveRequest(repo, {
      employee_id: 'E001', leave_type: 'personal',
      start_at: '2026-04-27T12:00:00+08:00',
      end_at:   '2026-04-27T15:00:00+08:00',
    });
    expect(r.ok).toBe(true);
    // overlap=3h、午休 13-14 完整落在 12-15 內 → breakOverlap=1h、結果 2h
    expect(r.request.hours).toBe(2);
    expect(r.request.days).toBe(0.25);
  });

  // ── flexible break (ST005 風格:break_minutes>0、無 break_start/end)──
  it('flexible break:自訂 15:00-18:00 → hours=2.5(按比例攤、沿用現行為)', async () => {
    const flex = dayShift({ break_start: null, break_end: null, break_minutes: 60 });
    const repo = makeRepo({ findSchedulesInRange: vi.fn(async () => [flex]) });
    const r = await submitLeaveRequest(repo, {
      employee_id: 'E001', leave_type: 'personal',
      start_at: '2026-04-27T15:00:00+08:00',
      end_at:   '2026-04-27T18:00:00+08:00',
    });
    expect(r.ok).toBe(true);
    // 540 span、work 480、ratio=480/540、3h × ratio ≈ 2.667 → round 0.5 = 2.5
    expect(r.request.hours).toBe(2.5);
  });

  it('flexible break:整天 10:00-19:00 → hours=8(span 540、break 60)', async () => {
    const flex = dayShift({
      start_time: '10:00', end_time: '19:00', scheduled_work_minutes: 480,
      break_start: null, break_end: null, break_minutes: 60,
    });
    const repo = makeRepo({ findSchedulesInRange: vi.fn(async () => [flex]) });
    const r = await submitLeaveRequest(repo, {
      employee_id: 'E001', leave_type: 'personal',
      start_at: '2026-04-27T10:00:00+08:00',
      end_at:   '2026-04-27T19:00:00+08:00',
    });
    expect(r.ok).toBe(true);
    expect(r.request.hours).toBe(8);
  });

  // ── no break (ST006 風格:break_minutes=0、無 break_start/end)──
  it('no break:自訂 18:00-21:00 → hours=3、無扣減', async () => {
    const noBreak = dayShift({
      start_time: '18:00', end_time: '22:00', scheduled_work_minutes: 240,
      break_start: null, break_end: null, break_minutes: 0,
    });
    const repo = makeRepo({ findSchedulesInRange: vi.fn(async () => [noBreak]) });
    const r = await submitLeaveRequest(repo, {
      employee_id: 'E001', leave_type: 'personal',
      start_at: '2026-04-27T18:00:00+08:00',
      end_at:   '2026-04-27T21:00:00+08:00',
    });
    expect(r.ok).toBe(true);
    expect(r.request.hours).toBe(3);
    expect(r.request.days).toBe(0.375);
  });
});

// 退化測試:原本 leave_requests.days 為 INTEGER、寫入 0.5 會 PG syntax error。
// schema 已改 NUMERIC(5,2)、本區塊確保 lib 層產出小數 days、未來若有人把欄位
// 退回 INT 或在 lib 加 parseInt 會被擋下。
describe('submitLeaveRequest — 半天 / 小數 days(NUMERIC 退化測試)', () => {
  it('personal 半天 4h(09-13)→ request.days=0.5、hours=4、不 throw', async () => {
    const halfDayShift = dayShift({
      start_time: '09:00', end_time: '13:00',
      scheduled_work_minutes: 240, // 4h、無 break
    });
    const repo = makeRepo({
      findSchedulesInRange: vi.fn(async () => [halfDayShift]),
    });
    const r = await submitLeaveRequest(repo, {
      employee_id: 'E001', leave_type: 'personal',
      start_at: '2026-04-27T09:00:00+08:00',
      end_at:   '2026-04-27T13:00:00+08:00',
      reason: '看醫生',
    });
    expect(r.ok).toBe(true);
    expect(r.request.hours).toBe(4);
    expect(r.request.days).toBe(0.5);
    // 守住小數型態:若 lib 退化加 parseInt / Math.floor、會被這條擋下
    expect(Number.isInteger(r.request.days)).toBe(false);
  });
});
