// tests/leave-multi-stage.test.js — Phase 1.3 e2e 流程覆蓋
//
// 對應改動:
//   lib/leave/request-flow.js: submitLeaveRequest stage-aware、approve/reject 接 expected_status / patch_extras
//   lib/leave/stages.js / advance-time.js / proof.js: Phase 1.2 加的純函式
//   api/leaves/[id].js: multi-stage handler (本檔不直接測 handler、是測 lib 組合層 e2e)
//
// 七條主流程:A 一般員工→mgr→ceo→archived / B 主管自批跳階 / C 拒絕 / D 員工撤回
// E 證明文件 / F 前置時間 / G Override

import { describe, it, expect, vi } from 'vitest';
import { submitLeaveRequest, approveLeaveRequest, rejectLeaveRequest, cancelLeaveRequest } from '../lib/leave/request-flow.js';
import { isProofExpired } from '../lib/leave/proof.js';

// ─── 假別 fixture(對齊 Phase 1.1 prod 值)─────────────────────
const SEED_LT = {
  annual:    { code:'annual', name_zh:'特休', is_paid:true, has_balance:true, is_active:true,
               advance_hours:72, advance_rule:'hard', requires_proof:false, proof_grace_days:0 },
  sick:      { code:'sick', name_zh:'病假', is_paid:true, has_balance:false, is_active:true,
               advance_hours:0, advance_rule:'soft', requires_proof:true, proof_grace_days:5 },
  personal:  { code:'personal', name_zh:'事假', is_paid:false, has_balance:false, is_active:true,
               advance_hours:24, advance_rule:'hard', requires_proof:false, proof_grace_days:0 },
  parental:  { code:'parental', name_zh:'育嬰留職停薪', is_paid:false, has_balance:false, is_active:true,
               advance_hours:240, advance_rule:'hard', requires_proof:true, proof_grace_days:0 },
  // Phase 1.5 升級 Flow H' 守:婚假 mark_expired 路徑
  marriage:  { code:'marriage', name_zh:'婚假', is_paid:true, has_balance:false, is_active:true,
               advance_hours:168, advance_rule:'hard', requires_proof:true, proof_grace_days:0 },
  // hypothetical:soft + advance_hours > 0(目前 prod 沒這種、但 lib 要支援)
  fakeSoft:  { code:'fakeSoft', name_zh:'假設 soft', is_paid:true, has_balance:false, is_active:true,
               advance_hours:24, advance_rule:'soft', requires_proof:false, proof_grace_days:0 },
};

// 9-18 整天班(480 min work、break 13-14、Phase 1.1 fixed mode)
const fullDayShift = (work_date) => ({
  id: 'S1', employee_id: 'E001', work_date,
  start_time: '09:00', end_time: '18:00', crosses_midnight: false,
  scheduled_work_minutes: 480,
  break_start: '13:00', break_end: '14:00', break_minutes: 60,
});

// ─── stateful repo:state.row 持續、模擬 DB row ─────────────────
function makeStatefulRepo(over = {}) {
  const state = { row: null };
  const repo = {
    nowIso: () => over.now || '2026-04-26T12:00:00.000Z',
    findLeaveType:        vi.fn(async (code) => SEED_LT[code] || null),
    listActiveLeaveTypes: vi.fn(async () => Object.values(SEED_LT)),
    findSchedulesInRange: vi.fn(async (_emp, dStart) => [fullDayShift(dStart)]),
    findActiveAnnualRecord: vi.fn(async () => over.annualRecord ?? { id: 1, granted_days: 14, used_days: 0 }),
    findActiveCompBalances: vi.fn(async () => over.compBalances || []),
    findEmployeeById: vi.fn(async (id) => over.employees?.[id]
                                          || { id, role: 'employee', is_manager: false, dept_id: 'D1', manager_id: 'M1' }),
    insertLeaveRequest: vi.fn(async (row) => { state.row = { ...row }; return { ...state.row }; }),
    findLeaveRequestById: vi.fn(async () => state.row ? { ...state.row } : null),
    updateLeaveRequest: vi.fn(async (_id, patch) => {
      state.row = { ...state.row, ...patch };
      return { ...state.row };
    }),
    lockAndIncrementUsedDays:    vi.fn(async () => ({ ok: true, record: { id: 1 } })),
    lockAndIncrementCompUsedHours: vi.fn(async () => ({ ok: true, record: { id: 1 } })),
    insertBalanceLog: vi.fn(async () => ({ id: 1 })),
  };
  return { repo, state };
}

// ─── 流程 helper:模擬 api/leaves/[id].js handler 對 lib 的呼叫 ──
async function submit(repo, opts) {
  return submitLeaveRequest(repo, {
    employee_id: 'E001',
    leave_type: 'annual',
    start_at: '2026-05-01T09:00:00+08:00',
    end_at:   '2026-05-01T18:00:00+08:00',
    submitted_at: '2026-04-26T12:00:00+08:00', // 5 天前送、過 advance=72h
    ...opts,
  });
}
async function mgrApprove(repo, requestId, mgrId, overrideReason = null) {
  const row = await repo.findLeaveRequestById(requestId);
  const now = '2026-04-27T12:00:00.000Z';
  const patch = {
    status: 'pending_ceo',
    mgr_reviewed_by: mgrId, mgr_reviewed_at: now, mgr_decision: 'approved',
  };
  if (row.late_application && overrideReason) {
    patch.override_by = mgrId; patch.override_at = now; patch.override_reason = overrideReason;
  }
  return repo.updateLeaveRequest(requestId, patch);
}
async function ceoApprove(repo, requestId, ceoId, overrideReason = null) {
  const row = await repo.findLeaveRequestById(requestId);
  const now = '2026-04-28T12:00:00.000Z';
  const overrideExtras = (row.late_application && overrideReason)
    ? { override_by: ceoId, override_at: now, override_reason: overrideReason }
    : {};
  return approveLeaveRequest(repo, {
    request_id: requestId,
    approved_by: ceoId,
    expected_status: row.status,
    patch_extras: {
      ceo_reviewed_by: ceoId, ceo_reviewed_at: now, ceo_decision: 'approved',
      ...overrideExtras,
    },
  });
}
async function rejectAtStage(repo, requestId, reviewerId, reason) {
  const row = await repo.findLeaveRequestById(requestId);
  const stage = row.status === 'pending' ? 'pending_mgr' : row.status;
  const now = '2026-04-27T12:00:00.000Z';
  const stageExtras = stage === 'pending_mgr'
    ? { mgr_reviewed_by: reviewerId, mgr_reviewed_at: now, mgr_decision: 'rejected', mgr_reject_reason: reason }
    : { ceo_reviewed_by: reviewerId, ceo_reviewed_at: now, ceo_decision: 'rejected', ceo_reject_reason: reason };
  return rejectLeaveRequest(repo, {
    request_id: requestId, rejected_by: reviewerId, reject_reason: reason,
    expected_status: row.status, patch_extras: stageExtras,
  });
}
async function archiveByHR(repo, requestId, hrId) {
  return repo.updateLeaveRequest(requestId, {
    status: 'archived',
    archived_by: hrId,
    archived_at: '2026-04-29T12:00:00.000Z',
  });
}

// ════════════════════════════════════════════════════════════
// 流程 A:一般員工 → mgr → ceo → archived(happy path)
// ════════════════════════════════════════════════════════════
describe('Flow A — 一般員工 happy path:submit → mgr → ceo → archived', () => {
  it('員工 submit → status=pending_mgr', async () => {
    const { repo } = makeStatefulRepo();
    const r = await submit(repo);
    expect(r.ok).toBe(true);
    expect(r.request.status).toBe('pending_mgr');
    expect(r.request.late_application).toBe(false);
    expect(r.request.proof_status).toBe('not_required'); // annual 不需要證明
  });

  it('主管 approve → status=pending_ceo + mgr_* 寫對', async () => {
    const { repo, state } = makeStatefulRepo();
    const r = await submit(repo);
    const updated = await mgrApprove(repo, r.request.id, 'M1');
    expect(updated.status).toBe('pending_ceo');
    expect(updated.mgr_reviewed_by).toBe('M1');
    expect(updated.mgr_decision).toBe('approved');
    expect(state.row.ceo_reviewed_by).toBeUndefined();
  });

  it('執行長 approve → status=approved + 扣餘額', async () => {
    const { repo } = makeStatefulRepo();
    const r = await submit(repo);
    await mgrApprove(repo, r.request.id, 'M1');
    const r2 = await ceoApprove(repo, r.request.id, 'C1');
    expect(r2.ok).toBe(true);
    expect(r2.request.status).toBe('approved');
    expect(r2.request.ceo_decision).toBe('approved');
    expect(r2.request.ceo_reviewed_by).toBe('C1');
    expect(r2.request.finalized_hours).toBe(8);
    // 扣餘額 hook 被叫
    expect(repo.lockAndIncrementUsedDays).toHaveBeenCalledWith({
      record_id: 1, delta_days: 1, allow_negative: false,
    });
  });

  it('HR archive → status=archived + archived_* 寫對', async () => {
    const { repo } = makeStatefulRepo();
    const r = await submit(repo);
    await mgrApprove(repo, r.request.id, 'M1');
    await ceoApprove(repo, r.request.id, 'C1');
    const archived = await archiveByHR(repo, r.request.id, 'HR1');
    expect(archived.status).toBe('archived');
    expect(archived.archived_by).toBe('HR1');
    expect(archived.archived_at).toBeTruthy();
  });
});

// ════════════════════════════════════════════════════════════
// 流程 B:主管自批跳階 → ceo → archived
// ════════════════════════════════════════════════════════════
describe('Flow B — 主管自己請假:跳 mgr 階直接 pending_ceo', () => {
  it('is_manager=true 員工 submit → status=pending_ceo(跳階)', async () => {
    const { repo } = makeStatefulRepo({
      employees: { E001: { id: 'E001', role: 'employee', is_manager: true, dept_id: 'D1', manager_id: null } },
    });
    const r = await submit(repo);
    expect(r.request.status).toBe('pending_ceo');
    expect(r.request.mgr_reviewed_by).toBeUndefined();
  });

  it('CEO approve → status=approved、mgr_* 維持 null(沒走過)', async () => {
    const { repo, state } = makeStatefulRepo({
      employees: { E001: { id: 'E001', role: 'employee', is_manager: true, dept_id: 'D1', manager_id: null } },
    });
    const r = await submit(repo);
    const r2 = await ceoApprove(repo, r.request.id, 'C1');
    expect(r2.ok).toBe(true);
    expect(r2.request.status).toBe('approved');
    expect(state.row.mgr_decision).toBeUndefined();
    expect(state.row.ceo_decision).toBe('approved');
  });

  it('CEO 自己請假 → 直接 status=approved、不需 ceo approve', async () => {
    const { repo } = makeStatefulRepo({
      employees: { E001: { id: 'E001', role: 'ceo', is_manager: true } },
    });
    const r = await submit(repo);
    expect(r.request.status).toBe('approved');
  });
});

// ════════════════════════════════════════════════════════════
// 流程 C:拒絕(任一階)
// ════════════════════════════════════════════════════════════
describe('Flow C — 拒絕', () => {
  it('mgr reject pending_mgr → status=rejected + mgr_reject_reason 寫對', async () => {
    const { repo, state } = makeStatefulRepo();
    const r = await submit(repo);
    const r2 = await rejectAtStage(repo, r.request.id, 'M1', '人力不足');
    expect(r2.ok).toBe(true);
    expect(r2.request.status).toBe('rejected');
    expect(r2.request.mgr_decision).toBe('rejected');
    expect(r2.request.mgr_reject_reason).toBe('人力不足');
    expect(state.row.ceo_decision).toBeUndefined();
  });

  it('ceo reject pending_ceo(主管已批)→ status=rejected + ceo_reject_reason 寫對', async () => {
    const { repo } = makeStatefulRepo();
    const r = await submit(repo);
    await mgrApprove(repo, r.request.id, 'M1');
    const r2 = await rejectAtStage(repo, r.request.id, 'C1', '本月不批');
    expect(r2.ok).toBe(true);
    expect(r2.request.status).toBe('rejected');
    expect(r2.request.ceo_decision).toBe('rejected');
    expect(r2.request.ceo_reject_reason).toBe('本月不批');
    expect(r2.request.mgr_decision).toBe('approved'); // 留底
  });

  it('reject reason 必填', async () => {
    const { repo } = makeStatefulRepo();
    const r = await submit(repo);
    const r2 = await rejectAtStage(repo, r.request.id, 'M1', '');
    expect(r2.ok).toBe(false);
    expect(r2.reason).toBe('REJECT_REASON_REQUIRED');
  });
});

// ════════════════════════════════════════════════════════════
// 流程 D:員工撤回(pending_mgr / pending_ceo 兩階皆可)
// ════════════════════════════════════════════════════════════
describe('Flow D — 員工撤回', () => {
  it('員工自己 cancel pending_mgr → status=cancelled', async () => {
    const { repo } = makeStatefulRepo();
    const r = await submit(repo);
    const r2 = await cancelLeaveRequest(repo, { request_id: r.request.id, cancelled_by: 'E001' });
    expect(r2.ok).toBe(true);
    expect(r2.request.status).toBe('cancelled');
  });

  it('員工自己 cancel pending_ceo(主管已批)→ status=cancelled', async () => {
    const { repo } = makeStatefulRepo();
    const r = await submit(repo);
    await mgrApprove(repo, r.request.id, 'M1');
    const r2 = await cancelLeaveRequest(repo, { request_id: r.request.id, cancelled_by: 'E001' });
    expect(r2.ok).toBe(true);
    expect(r2.request.status).toBe('cancelled');
  });

  it('員工自己在 approved 不能 cancel(要走 refund)', async () => {
    const { repo } = makeStatefulRepo();
    const r = await submit(repo);
    await mgrApprove(repo, r.request.id, 'M1');
    await ceoApprove(repo, r.request.id, 'C1');
    const r2 = await cancelLeaveRequest(repo, { request_id: r.request.id, cancelled_by: 'E001' });
    expect(r2.ok).toBe(false);
    expect(r2.reason).toBe('NOT_PENDING');
  });

  it('別人不能 cancel 本人的假', async () => {
    const { repo } = makeStatefulRepo();
    const r = await submit(repo);
    const r2 = await cancelLeaveRequest(repo, { request_id: r.request.id, cancelled_by: 'E999' });
    expect(r2.ok).toBe(false);
    expect(r2.reason).toBe('NOT_OWN_REQUEST');
  });
});

// ════════════════════════════════════════════════════════════
// 流程 E:證明文件
// ════════════════════════════════════════════════════════════
describe('Flow E — 證明文件', () => {
  it('病假(requires_proof=true、grace=5)→ proof_status=required + proof_due_at 算對', async () => {
    const { repo } = makeStatefulRepo();
    const r = await submit(repo, {
      leave_type: 'sick',
      start_at: '2026-05-01T09:00:00+08:00',
      end_at:   '2026-05-01T18:00:00+08:00',
      submitted_at: '2026-05-01T08:00:00+08:00', // sick advance=0、當天可送
    });
    expect(r.ok).toBe(true);
    expect(r.request.proof_status).toBe('required');
    // end=2026-05-01、grace=5 → due=2026-05-06
    expect(r.request.proof_due_at).toBeTruthy();
    expect(r.request.proof_due_at.slice(0, 10)).toBe('2026-05-06');
  });

  it('員工提交 proof_url → proof_status=submitted', async () => {
    const { repo } = makeStatefulRepo();
    const r = await submit(repo, {
      leave_type: 'sick',
      submitted_at: '2026-05-01T08:00:00+08:00',
      start_at: '2026-05-01T09:00:00+08:00',
      end_at:   '2026-05-01T18:00:00+08:00',
    });
    // 模擬 API submit_proof:updateLeaveRequest with proof_url + proof_status='submitted'
    const updated = await repo.updateLeaveRequest(r.request.id, {
      proof_url: 'https://example.com/sick-cert.pdf',
      proof_status: 'submitted',
    });
    expect(updated.proof_status).toBe('submitted');
    expect(updated.proof_url).toBe('https://example.com/sick-cert.pdf');
  });

  it('proof_status=required + due 已過 → isProofExpired=true', async () => {
    const row = { proof_status: 'required', proof_due_at: '2026-05-06T23:59:59+08:00' };
    expect(isProofExpired(row, '2026-05-10T00:00:00+08:00')).toBe(true);
  });

  it('事假(requires_proof=false)→ proof_status=not_required + proof_due_at=null', async () => {
    const { repo } = makeStatefulRepo();
    const r = await submit(repo, {
      leave_type: 'personal',
      submitted_at: '2026-04-26T12:00:00+08:00', // 5 天前送、過 advance=24h
      start_at: '2026-05-01T09:00:00+08:00',
      end_at:   '2026-05-01T18:00:00+08:00',
    });
    expect(r.ok).toBe(true);
    expect(r.request.proof_status).toBe('not_required');
    expect(r.request.proof_due_at).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════
// 流程 F:前置時間
// ════════════════════════════════════════════════════════════
describe('Flow F — 前置時間 hard / soft 邊界', () => {
  it('特休(hard, 72h)、申請 1 天後請 → ADVANCE_TIME_NOT_MET', async () => {
    const { repo } = makeStatefulRepo();
    const r = await submit(repo, {
      submitted_at: '2026-04-30T09:00:00+08:00', // 24h before
      start_at: '2026-05-01T09:00:00+08:00',
      end_at:   '2026-05-01T18:00:00+08:00',
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('ADVANCE_TIME_NOT_MET');
    expect(r.advance_hours).toBe(72);
    expect(r.gap_hours).toBeCloseTo(24, 5);
  });

  it('特休、申請 4 天後請(96h > 72h)→ ok', async () => {
    const { repo } = makeStatefulRepo();
    const r = await submit(repo, {
      submitted_at: '2026-04-27T09:00:00+08:00',
      start_at: '2026-05-01T09:00:00+08:00',
      end_at:   '2026-05-01T18:00:00+08:00',
    });
    expect(r.ok).toBe(true);
    expect(r.request.late_application).toBe(false);
  });

  it('病假(soft, 0h)、當天請 → ok, late=false(advance_hours=0 永遠通過)', async () => {
    const { repo } = makeStatefulRepo();
    const r = await submit(repo, {
      leave_type: 'sick',
      submitted_at: '2026-05-01T08:00:00+08:00',
      start_at: '2026-05-01T09:00:00+08:00',
      end_at:   '2026-05-01T18:00:00+08:00',
    });
    expect(r.ok).toBe(true);
    expect(r.request.late_application).toBe(false);
  });

  it('育嬰留停(hard, 240h)、申請 5 天後 → fail(< 240h)', async () => {
    const { repo } = makeStatefulRepo();
    const r = await submit(repo, {
      leave_type: 'parental',
      submitted_at: '2026-04-26T09:00:00+08:00', // 120h before
      start_at: '2026-05-01T09:00:00+08:00',
      end_at:   '2026-05-01T18:00:00+08:00',
      late_reason: undefined,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('ADVANCE_TIME_NOT_MET');
  });

  it('soft + advance > 0、未達 + 沒 late_reason → LATE_REASON_REQUIRED', async () => {
    const { repo } = makeStatefulRepo();
    const r = await submit(repo, {
      leave_type: 'fakeSoft',
      submitted_at: '2026-05-01T08:00:00+08:00',
      start_at: '2026-05-01T09:00:00+08:00',
      end_at:   '2026-05-01T18:00:00+08:00',
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('LATE_REASON_REQUIRED');
  });

  it('soft + advance > 0、未達 + 有 late_reason → ok, late=true', async () => {
    const { repo } = makeStatefulRepo();
    const r = await submit(repo, {
      leave_type: 'fakeSoft',
      submitted_at: '2026-05-01T08:00:00+08:00',
      start_at: '2026-05-01T09:00:00+08:00',
      end_at:   '2026-05-01T18:00:00+08:00',
      late_reason: '臨時家裡有事',
    });
    expect(r.ok).toBe(true);
    expect(r.request.late_application).toBe(true);
    expect(r.request.late_reason).toBe('臨時家裡有事');
  });
});

// ════════════════════════════════════════════════════════════
// 流程 G:Override(主管 / CEO 仍批 late_application 的假、留 audit)
// ════════════════════════════════════════════════════════════
describe('Flow G — Override 紀錄', () => {
  it('late_application=true 的假、mgr approve 帶 override_reason → 寫 override_*', async () => {
    const { repo } = makeStatefulRepo();
    const r = await submit(repo, {
      leave_type: 'fakeSoft',
      submitted_at: '2026-05-01T08:00:00+08:00',
      start_at: '2026-05-01T09:00:00+08:00',
      end_at:   '2026-05-01T18:00:00+08:00',
      late_reason: '突發事件',
    });
    expect(r.request.late_application).toBe(true);

    const updated = await mgrApprove(repo, r.request.id, 'M1', '主管確認情況');
    expect(updated.override_by).toBe('M1');
    expect(updated.override_reason).toBe('主管確認情況');
    expect(updated.override_at).toBeTruthy();
  });

  it('late_application=false 的假、即使帶 override_reason → 不寫 override_*', async () => {
    const { repo } = makeStatefulRepo();
    const r = await submit(repo, {
      submitted_at: '2026-04-27T09:00:00+08:00',
      start_at: '2026-05-01T09:00:00+08:00',
      end_at:   '2026-05-01T18:00:00+08:00',
    });
    expect(r.request.late_application).toBe(false);

    const updated = await mgrApprove(repo, r.request.id, 'M1', '不該寫');
    expect(updated.override_by).toBeUndefined();
    expect(updated.override_reason).toBeUndefined();
  });

  it('late_application=true、ceo approve 也能帶 override_reason', async () => {
    const { repo } = makeStatefulRepo();
    const r = await submit(repo, {
      leave_type: 'fakeSoft',
      submitted_at: '2026-05-01T08:00:00+08:00',
      start_at: '2026-05-01T09:00:00+08:00',
      end_at:   '2026-05-01T18:00:00+08:00',
      late_reason: '突發',
    });
    await mgrApprove(repo, r.request.id, 'M1'); // 不帶 override
    const r2 = await ceoApprove(repo, r.request.id, 'C1', 'CEO 確認可以');
    expect(r2.ok).toBe(true);
    expect(r2.request.override_by).toBe('C1');
    expect(r2.request.override_reason).toBe('CEO 確認可以');
  });
});

// ════════════════════════════════════════════════════════════
// 流程 H:Phase 1.5 — proof 過期 → cron 自動轉事假
// ════════════════════════════════════════════════════════════
import { sweepExpiredProofs } from '../lib/leave/proof-sweep.js';

// Phase 1.5 升級:sweepExpiredProofs 簽名 (rows, leaveTypesByCode, now)、依 leaveType.proof_expiry_action 分流
const SWEEP_LT = {
  sick:     { code: 'sick',     proof_expiry_action: 'convert' },
  marriage: { code: 'marriage', proof_expiry_action: 'mark_expired' },
};

describe('Flow H — proof 過期 → cron 轉事假(Phase 1.5)', () => {
  it('病假 submit → proof_status=required + due 過期 → sweep 出 convert action', async () => {
    const { repo } = makeStatefulRepo();
    const r = await submit(repo, {
      leave_type: 'sick',
      submitted_at: '2026-05-01T08:00:00+08:00',
      start_at: '2026-05-01T09:00:00+08:00',
      end_at:   '2026-05-01T18:00:00+08:00',
    });
    expect(r.ok).toBe(true);
    expect(r.request.proof_status).toBe('required');
    // 病假 grace=5、end=2026-05-01 → due=2026-05-06、模擬 5/10 跑 cron(已過期)
    const now = '2026-05-10T00:00:00+08:00';
    const actions = sweepExpiredProofs([r.request], SWEEP_LT, now);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      id: r.request.id,
      action: 'convert',
      leave_type: 'personal',
      proof_status: 'converted_to_personal',
      original_leave_type: 'sick',
    });
    expect(actions[0].note_suffix).toContain('原假別 sick');
  });

  it('病假 submit + 員工已交 proof_url → sweep 不轉(submitted 不在 required)', async () => {
    const { repo } = makeStatefulRepo();
    const r = await submit(repo, {
      leave_type: 'sick',
      submitted_at: '2026-05-01T08:00:00+08:00',
      start_at: '2026-05-01T09:00:00+08:00',
      end_at:   '2026-05-01T18:00:00+08:00',
    });
    // 模擬員工提交證明
    await repo.updateLeaveRequest(r.request.id, {
      proof_url: 'https://example.com/sick-cert.pdf',
      proof_status: 'submitted',
    });
    const updated = await repo.findLeaveRequestById(r.request.id);
    const actions = sweepExpiredProofs([updated], SWEEP_LT, '2026-05-10T00:00:00+08:00');
    expect(actions).toEqual([]);
  });

  it('事假 submit → proof_status=not_required → sweep 不動', async () => {
    const { repo } = makeStatefulRepo();
    const r = await submit(repo, {
      leave_type: 'personal',
      submitted_at: '2026-04-26T12:00:00+08:00',
      start_at: '2026-05-01T09:00:00+08:00',
      end_at:   '2026-05-01T18:00:00+08:00',
    });
    expect(r.request.proof_status).toBe('not_required');
    const actions = sweepExpiredProofs([r.request], SWEEP_LT, '2026-05-10T00:00:00+08:00');
    expect(actions).toEqual([]);
  });

  it('cron 轉事假(模擬 UPDATE)→ leave_type=personal + proof_status=converted_to_personal', async () => {
    const { repo, state } = makeStatefulRepo();
    const r = await submit(repo, {
      leave_type: 'sick',
      submitted_at: '2026-05-01T08:00:00+08:00',
      start_at: '2026-05-01T09:00:00+08:00',
      end_at:   '2026-05-01T18:00:00+08:00',
    });
    const actions = sweepExpiredProofs([r.request], SWEEP_LT, '2026-05-10T00:00:00+08:00');
    // 模擬 cron handler 套用 action
    for (const a of actions) {
      await repo.updateLeaveRequest(a.id, {
        leave_type: a.leave_type,
        proof_status: a.proof_status,
        handler_note: `[2026-05-10] ${a.note_suffix}`,
      });
    }
    expect(state.row.leave_type).toBe('personal');
    expect(state.row.proof_status).toBe('converted_to_personal');
    expect(state.row.handler_note).toContain('原假別 sick');
  });
});

// ════════════════════════════════════════════════════════════
// 流程 H':Phase 1.5 升級 — 法定假 vs 短假分流
// ════════════════════════════════════════════════════════════
describe("Flow H' — proof 過期分流(Phase 1.5 升級)", () => {
  it('婚假 submit + 過期 → sweep 出 mark_expired → cron UPDATE proof_status=expired、leave_type 仍是 marriage', async () => {
    const { repo, state } = makeStatefulRepo();
    // marriage advance_hours=168(7 天)、grace=0、submitted 11 天前 ok
    const r = await submit(repo, {
      leave_type: 'marriage',
      submitted_at: '2026-04-20T00:00:00+08:00',
      start_at: '2026-05-01T09:00:00+08:00',
      end_at:   '2026-05-01T18:00:00+08:00',
    });
    expect(r.ok).toBe(true);
    expect(r.request.leave_type).toBe('marriage');
    expect(r.request.proof_status).toBe('required');
    // grace=0 → due = end = 2026-05-01;5/10 跑 cron 已過
    const now = '2026-05-10T00:00:00+08:00';
    const actions = sweepExpiredProofs([r.request], SWEEP_LT, now);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      id: r.request.id,
      action: 'mark_expired',
      proof_status: 'expired',
      original_leave_type: 'marriage',
    });
    // mark_expired 不該帶 leave_type 欄位(下游不該誤覆蓋)
    expect('leave_type' in actions[0]).toBe(false);

    // 模擬 cron handler 套用 mark_expired patch(只動 proof_status + handler_note)
    for (const a of actions) {
      const patch = a.action === 'mark_expired'
        ? { proof_status: a.proof_status, handler_note: `[2026-05-10] ${a.note_suffix}` }
        : { leave_type: a.leave_type, proof_status: a.proof_status, handler_note: `[2026-05-10] ${a.note_suffix}` };
      await repo.updateLeaveRequest(a.id, patch);
    }
    // 守:leave_type 仍是 marriage、status 不動、proof_status='expired'
    expect(state.row.leave_type).toBe('marriage');
    expect(state.row.proof_status).toBe('expired');
    expect(state.row.status).toBe(r.request.status);  // 維持 submit 後的 stage(未動)
    expect(state.row.handler_note).toContain('原假別 marriage');
    expect(state.row.handler_note).toContain('HR 個案處理');
  });

  it('病假 submit + 過期 → sweep 路由 convert(SWEEP_LT 內 sick.proof_expiry_action=convert 守)', async () => {
    // regression 守:Flow H 已覆蓋 convert 結果、本 case 確認 sweep 是真的「依 SWEEP_LT 路由」
    // 而非 fallback。把 SWEEP_LT 換成只含 sick=convert(無 fallback 也走 convert)→ 結果一致才算路由正確
    const { repo } = makeStatefulRepo();
    const r = await submit(repo, {
      leave_type: 'sick',
      submitted_at: '2026-05-01T08:00:00+08:00',
      start_at: '2026-05-01T09:00:00+08:00',
      end_at:   '2026-05-01T18:00:00+08:00',
    });
    const explicitMap = { sick: { code: 'sick', proof_expiry_action: 'convert' } };
    const actions = sweepExpiredProofs([r.request], explicitMap, '2026-05-10T00:00:00+08:00');
    expect(actions).toHaveLength(1);
    expect(actions[0].action).toBe('convert');
    expect(actions[0].original_leave_type).toBe('sick');
  });
});

// ════════════════════════════════════════════════════════════
// 流程 I:Phase 1.6 — HR 終止 expired row
// ════════════════════════════════════════════════════════════
import {
  canTerminate, transitionTerminate, canApprove, canReject,
} from '../lib/leave/stages.js';

const HR_ACTOR  = { id: 'HR1', role: 'hr' };
const EMP_ACTOR = { id: 'E001' };

// 把 cron sweep mark_expired 後的 row state 設好(emulate Phase 1.5 cron 跑完)
async function emulateMarkExpired(repo, requestId) {
  return repo.updateLeaveRequest(requestId, {
    proof_status: 'expired',
    handler_note: '[2026-05-10] 原假別 marriage、未補證明、HR 個案處理',
  });
}

// emulate api/leaves/[id].js handleTerminate(走 lib gate + 寫 patch)
async function hrTerminate(repo, requestId, hrId) {
  const row = await repo.findLeaveRequestById(requestId);
  if (!canTerminate({ id: hrId, role: 'hr' }, row)) {
    return { ok: false, reason: 'NOT_ELIGIBLE_TO_TERMINATE',
             actual_status: row.status, actual_proof_status: row.proof_status };
  }
  const nextStage = transitionTerminate(row.status);
  const now = '2026-05-10T12:00:00.000Z';
  const updated = await repo.updateLeaveRequest(requestId, {
    status: nextStage,
    terminated_by: hrId,
    terminated_at: now,
    handler_note: `${row.handler_note || ''}\n[2026-05-10] HR 終止申請(證明已過期)`,
  });
  return { ok: true, request: updated };
}

describe("Flow I — HR 終止 expired row(Phase 1.6)", () => {
  it('婚假 mark_expired + HR terminate → status=terminated、proof_status 保留 expired、terminated_by/at 寫入', async () => {
    const { repo, state } = makeStatefulRepo();
    // 婚假 advance_hours=168(7 天)、grace=0、submitted 11 天前 ok
    const r = await submit(repo, {
      leave_type: 'marriage',
      submitted_at: '2026-04-20T00:00:00+08:00',
      start_at: '2026-05-01T09:00:00+08:00',
      end_at:   '2026-05-01T18:00:00+08:00',
    });
    expect(r.ok).toBe(true);
    expect(r.request.proof_status).toBe('required');
    // emulate cron sweep mark_expired
    await emulateMarkExpired(repo, r.request.id);
    expect(state.row.proof_status).toBe('expired');
    expect(state.row.status).toBe(r.request.status);  // 仍 pending(cron 不動 status)

    // HR terminate
    const t = await hrTerminate(repo, r.request.id, HR_ACTOR.id);
    expect(t.ok).toBe(true);
    expect(state.row.status).toBe('terminated');
    expect(state.row.proof_status).toBe('expired');   // 保留歷史紀錄
    expect(state.row.terminated_by).toBe('HR1');
    expect(state.row.terminated_at).toBeTruthy();
    expect(state.row.handler_note).toContain('HR 終止申請');
    expect(state.row.handler_note).toContain('原假別 marriage');  // cron note 仍在
  });

  it('病假 not expired + HR terminate → NOT_ELIGIBLE_TO_TERMINATE(對應 422)', async () => {
    const { repo } = makeStatefulRepo();
    const r = await submit(repo, {
      leave_type: 'sick',
      submitted_at: '2026-05-01T08:00:00+08:00',
      start_at: '2026-05-01T09:00:00+08:00',
      end_at:   '2026-05-01T18:00:00+08:00',
    });
    expect(r.request.proof_status).toBe('required');  // 未過期、cron 沒掃到
    const t = await hrTerminate(repo, r.request.id, HR_ACTOR.id);
    expect(t.ok).toBe(false);
    expect(t.reason).toBe('NOT_ELIGIBLE_TO_TERMINATE');
    expect(t.actual_proof_status).toBe('required');
  });

  it('婚假 expired + 真主管 approve → canApprove=false(對應 422 NOT_ELIGIBLE_TO_APPROVE,expired guard)', async () => {
    // Phase 2.x:HR 已不能審任何 row、改用真主管(同部門 + is_manager)、expired guard 仍擋
    const MGR_ACTOR = { id: 'M1', role: 'employee', is_manager: true, dept_id: 'D1' };
    const { repo } = makeStatefulRepo();
    const r = await submit(repo, {
      leave_type: 'marriage',
      submitted_at: '2026-04-20T00:00:00+08:00',
      start_at: '2026-05-01T09:00:00+08:00',
      end_at:   '2026-05-01T18:00:00+08:00',
    });
    await emulateMarkExpired(repo, r.request.id);
    const row = await repo.findLeaveRequestById(r.request.id);
    const reviewable = { ...row, employee_dept_id: 'D1' };
    expect(canApprove(MGR_ACTOR, reviewable)).toBe(false);
  });

  it('婚假 expired + 真主管 reject → canReject=false(對應 422 NOT_ELIGIBLE_TO_REJECT,expired guard)', async () => {
    const MGR_ACTOR = { id: 'M1', role: 'employee', is_manager: true, dept_id: 'D1' };
    const { repo } = makeStatefulRepo();
    const r = await submit(repo, {
      leave_type: 'marriage',
      submitted_at: '2026-04-20T00:00:00+08:00',
      start_at: '2026-05-01T09:00:00+08:00',
      end_at:   '2026-05-01T18:00:00+08:00',
    });
    await emulateMarkExpired(repo, r.request.id);
    const row = await repo.findLeaveRequestById(r.request.id);
    const reviewable = { ...row, employee_dept_id: 'D1' };
    expect(canReject(MGR_ACTOR, reviewable)).toBe(false);
  });

  it('婚假 expired + 員工本人 cancel → 200 OK(canCancel 不擋、員工自撤合理)', async () => {
    const { repo, state } = makeStatefulRepo();
    const r = await submit(repo, {
      leave_type: 'marriage',
      submitted_at: '2026-04-20T00:00:00+08:00',
      start_at: '2026-05-01T09:00:00+08:00',
      end_at:   '2026-05-01T18:00:00+08:00',
    });
    await emulateMarkExpired(repo, r.request.id);
    // 員工撤回(走 lib cancelLeaveRequest、不過 canApprove/canReject)
    const c = await cancelLeaveRequest(repo, { request_id: r.request.id, cancelled_by: EMP_ACTOR.id });
    expect(c.ok).toBe(true);
    expect(state.row.status).toBe('cancelled');
    // 守:proof_status 仍 expired(歷史)、不會被撤回路徑覆寫
    expect(state.row.proof_status).toBe('expired');
  });
});

