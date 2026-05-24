// lib/leave/request-flow.js — 請假申請流程(純函式 + repo 注入式)
//
// 對應設計文件：docs/attendance-system-design-v1.md §4.3.2
// 對應實作計畫：docs/attendance-system-implementation-plan-v1.md §7.5
//
// 流程:
//   submitLeaveRequest:建立 pending(計算 hours,餘額預檢)
//   approveLeaveRequest:重算 hours → finalized_hours,扣餘額,寫 logs
//   rejectLeaveRequest:駁回(不扣餘額)
//   cancelLeaveRequest:員工撤回(只能 pending 時)

import { calculateScheduleWorkMinutes } from '../schedule/work-hours.js';
import { calculateSegmentLeaveMinutes } from '../schedule/break-overlap.js';
import { getLeaveType, requiresBalance, getBalancePool } from './types.js';
import { deductAnnualLeave, refundAnnualLeave, deductCompTime, HOURS_PER_DAY } from './balance.js';
import { validateAdvanceTime } from './advance-time.js';
import { computeProofDueAt, getInitialProofStatus } from './proof.js';
import { getInitialStage } from './stages.js';

/**
 * Repo 介面契約:
 *   findSchedulesInRange(employee_id, dateStart, dateEnd): Array<schedule>
 *   findLeaveType(code): row | null
 *   listActiveLeaveTypes(): Array<row>
 *   findAnnualRecordCoveringDate(employee_id, leaveDate): row | null
 *     (B14:依日期落點挑 period、不是無條件取最新 active)
 *   lockAndIncrementUsedDays(...): { ok, record?, reason? }
 *   insertBalanceLog(row)
 *   insertLeaveRequest(row): 新建 pending 假單
 *   findLeaveRequestById(id): leave_requests row | null
 *   updateLeaveRequest(id, patch): updated row
 *   nowIso(): string  optional
 */

/**
 * 計算某員工 [start_at, end_at] 區間內,依該員工該天 schedules 的工時計算總請假時數。
 *
 * 邏輯:
 *   1. 撈該區間內(date 在 start_at..end_at 內)的所有 schedules
 *   2. 對每個 schedule 用 lib/schedule/break-overlap.js 三類分流(fixed/flexible/none)算分鐘數
 *   3. 加總成 total hours(支援半小時粒度)
 *
 * Break 處理三類:
 *   - fixed (shift 有 break_start/break_end):扣請假區間與午休的 overlap
 *   - flexible (只有 break_minutes):沿用 ratio=work/span 攤算(舊行為)
 *   - none (break_minutes=0):純 overlap、不扣
 *
 * @returns {number}  小時數(half-hour rounded)
 */
export async function calculateLeaveHours(repo, { employee_id, start_at, end_at }) {
  if (!repo || typeof repo.findSchedulesInRange !== 'function') {
    throw new Error('repo.findSchedulesInRange is required');
  }
  if (!employee_id || !start_at || !end_at) {
    throw new Error('employee_id / start_at / end_at required');
  }

  const startMs = Date.parse(start_at);
  const endMs   = Date.parse(end_at);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    throw new Error('invalid start_at / end_at');
  }

  const dStart = isoDate(start_at);
  const dEnd   = isoDate(end_at);
  const schedules = await repo.findSchedulesInRange(employee_id, dStart, dEnd);

  let totalMinutes = 0;
  for (const s of (schedules || [])) {
    const segStartMs = combineDateTime(s.work_date, s.start_time);
    let   segEndMs   = combineDateTime(s.work_date, s.end_time);
    if (s.crosses_midnight || segEndMs <= segStartMs) {
      segEndMs += 24 * 3600 * 1000;
    }

    totalMinutes += calculateSegmentLeaveMinutes({
      reqStartMs: startMs, reqEndMs: endMs,
      segStartMs, segEndMs,
      shift: s,
      baseDateStr: s.work_date,
    });
  }

  // 半小時粒度
  const hours = totalMinutes / 60;
  return Math.round(hours * 2) / 2;
}

/**
 * 建立假單。流程:
 *   1. 找 leaveType / 算 hours / 餘額預檢(既有)
 *   2. validateAdvanceTime:hard reject / soft late + 沒 late_reason 也擋
 *   3. getInitialProofStatus + computeProofDueAt:寫 proof_status / proof_due_at
 *   4. findEmployeeById + getInitialStage:status= pending_mgr / pending_ceo / approved
 *
 * @param {object} repo
 * @param {object} input
 * @param {string} input.employee_id
 * @param {string} input.leave_type
 * @param {string} input.start_at        ISO timestamp(含時區)
 * @param {string} input.end_at
 * @param {string} [input.reason]
 * @param {string} [input.late_reason]   soft late 時必填
 * @param {string|Date} [input.submitted_at]  default new Date()(測試可注入)
 * @param {string} [input.attachment_url]
 * @param {string} [input.attachment_name]
 */
export async function submitLeaveRequest(repo, {
  employee_id, leave_type, start_at, end_at, reason,
  late_reason, submitted_at,
  attachment_url, attachment_name,
}) {
  requireRepo(repo, ['findLeaveType', 'insertLeaveRequest', 'findSchedulesInRange', 'findEmployeeById']);
  if (!employee_id) throw new Error('employee_id required');
  if (!leave_type)  throw new Error('leave_type required');
  if (!start_at || !end_at) throw new Error('start_at / end_at required');

  const lt = await getLeaveType(repo, leave_type);
  if (!lt) throw new Error(`unknown / inactive leave_type: ${leave_type}`);

  const hours = await calculateLeaveHours(repo, { employee_id, start_at, end_at });

  // 餘額預檢
  const pool0 = getBalancePool(lt);
  if (requiresBalance(lt) && pool0 === 'annual') {
    if (typeof repo.findAnnualRecordCoveringDate !== 'function') {
      throw new Error('repo.findAnnualRecordCoveringDate is required for balance precheck');
    }
    // B14:依 start_at 日期挑 period、不是無條件取最新 active record
    const rec = await repo.findAnnualRecordCoveringDate(employee_id, isoDate(start_at));
    if (!rec) {
      return { ok: false, reason: 'NO_ACTIVE_ANNUAL_RECORD' };
    }
    const remaining = Number(rec.granted_days) - Number(rec.used_days);
    const requestedDays = hours / HOURS_PER_DAY;
    if (requestedDays > remaining + 1e-6) {
      return { ok: false, reason: 'INSUFFICIENT_BALANCE', remaining, requestedDays };
    }
  } else if (requiresBalance(lt) && pool0 === 'comp') {
    if (typeof repo.findActiveCompBalances !== 'function') {
      throw new Error('repo.findActiveCompBalances is required for comp balance precheck');
    }
    const balances = await repo.findActiveCompBalances(employee_id);
    const totalRemaining = (balances || []).reduce(
      (s, b) => s + (Number(b.earned_hours) - Number(b.used_hours)), 0,
    );
    if (hours > totalRemaining + 1e-6) {
      return {
        ok: false, reason: 'INSUFFICIENT_COMP_BALANCE',
        remaining_hours: totalRemaining, requested_hours: hours,
      };
    }
  }

  // 前置時間檢查(Phase 1.2 lib)
  const submittedAt = submitted_at ? new Date(submitted_at) : new Date();
  const advance = validateAdvanceTime(lt, start_at, submittedAt);
  if (!advance.ok) {
    return {
      ok: false,
      reason: advance.reason, // 'ADVANCE_TIME_NOT_MET'
      advance_hours: advance.advance_hours,
      gap_hours: advance.gap_hours,
    };
  }
  // soft late 必須附 late_reason
  if (advance.late && !String(late_reason || '').trim()) {
    return { ok: false, reason: 'LATE_REASON_REQUIRED', advance_hours: advance.advance_hours, gap_hours: advance.gap_hours };
  }

  // 員工資料 + initial stage
  const employee = await repo.findEmployeeById(employee_id);
  if (!employee) throw new Error(`employee not found: ${employee_id}`);
  const initialStage = getInitialStage(employee);

  // 證明文件(若 leave_type 需要)
  const proofStatus = getInitialProofStatus(lt);
  const proofDueAt = computeProofDueAt(lt, end_at);

  const id = `L${Date.now()}_${employee_id}`;
  const row = {
    id,
    employee_id,
    leave_type,
    start_at, end_at,
    hours,
    finalized_hours: null,
    reason: reason || null,
    status: initialStage,
    // 為 legacy 相容,start_date/end_date/days 也填
    start_date: isoDate(start_at),
    end_date:   isoDate(end_at),
    days:       hours / HOURS_PER_DAY,
    // 附件(optional)
    attachment_url:  attachment_url  || null,
    attachment_name: attachment_name || null,
    // Phase 1.1 新欄位
    late_application: !!advance.late,
    late_reason: advance.late ? String(late_reason).trim() : null,
    proof_status: proofStatus,
    proof_due_at: proofDueAt ? proofDueAt.toISOString() : null,
  };
  const created = await repo.insertLeaveRequest(row);
  return { ok: true, request: created };
}

/**
 * 核准假單(扣餘額、寫 status='approved')。
 *
 * Phase 1.3 加 expected_status / patch_extras:
 *   - expected_status:預期 req.status 是哪個。default 'pending'(向後相容)。
 *     新流程傳 'pending_ceo'(主管已批、執行長作最終 approve)。
 *     也接 'pending'(舊資料 backward compat)。
 *   - patch_extras:由 caller 注入的 ceo_* / override_* 欄位、merge 進最終 patch。
 */
export async function approveLeaveRequest(repo, {
  request_id, approved_by,
  expected_status = 'pending',
  patch_extras = {},
}) {
  requireRepo(repo, ['findLeaveRequestById', 'updateLeaveRequest', 'findLeaveType', 'findSchedulesInRange']);
  if (!request_id)  throw new Error('request_id required');
  if (!approved_by) throw new Error('approved_by required');

  const req = await repo.findLeaveRequestById(request_id);
  if (!req) return { ok: false, reason: 'NOT_FOUND' };
  if (req.status !== expected_status) return { ok: false, reason: 'NOT_PENDING', expected: expected_status, actual: req.status };

  const lt = await getLeaveType(repo, req.leave_type);
  if (!lt) return { ok: false, reason: 'UNKNOWN_LEAVE_TYPE' };

  // 重算時數(pending 期間排班可能變動)
  const finalizedHours = await calculateLeaveHours(repo, {
    employee_id: req.employee_id,
    start_at: req.start_at, end_at: req.end_at,
  });

  // 扣餘額
  const pool = getBalancePool(lt);
  if (pool === 'annual') {
    const days = finalizedHours / HOURS_PER_DAY;
    const r = await deductAnnualLeave(repo, {
      employee_id: req.employee_id,
      days,
      leave_request_id: request_id,
      changed_by: approved_by,
      // B14:依 start_at 日期挑 period(對齊 submit 時的 precheck)
      leave_date: isoDate(req.start_at),
      reason: `approve leave_request ${request_id}`,
    });
    if (!r.ok) return r;
  } else if (pool === 'comp') {
    const r = await deductCompTime(repo, {
      employee_id: req.employee_id,
      hours: finalizedHours,
      leave_request_id: request_id,
      changed_by: approved_by,
      reason: `approve leave_request ${request_id}`,
    });
    if (!r.ok) return r;
  }

  const updated = await repo.updateLeaveRequest(request_id, {
    ...patch_extras,
    status: 'approved',
    finalized_hours: finalizedHours,
    days: finalizedHours / HOURS_PER_DAY, // legacy 欄位保留
    reviewed_by: approved_by,
    reviewed_at: nowIso(repo),
    handled_at:  nowIso(repo), // legacy 欄位
  });
  return { ok: true, request: updated };
}

/**
 * 駁回假單。
 * Phase 1.3 加 expected_status / patch_extras:
 *   多階審核時、PATCH handler 傳 expected_status='pending_mgr' / 'pending_ceo'
 *   + patch_extras={mgr_decision:'rejected',mgr_reject_reason,...} 或 ceo_*。
 */
export async function rejectLeaveRequest(repo, {
  request_id, rejected_by, reject_reason,
  expected_status = 'pending',
  patch_extras = {},
}) {
  requireRepo(repo, ['findLeaveRequestById', 'updateLeaveRequest']);
  if (!request_id)  throw new Error('request_id required');
  if (!rejected_by) throw new Error('rejected_by required');
  if (!reject_reason || !String(reject_reason).trim()) {
    return { ok: false, reason: 'REJECT_REASON_REQUIRED' };
  }

  const req = await repo.findLeaveRequestById(request_id);
  if (!req) return { ok: false, reason: 'NOT_FOUND' };
  if (req.status !== expected_status) return { ok: false, reason: 'NOT_PENDING', expected: expected_status, actual: req.status };

  const updated = await repo.updateLeaveRequest(request_id, {
    ...patch_extras,
    status: 'rejected',
    reviewed_by: rejected_by,
    reviewed_at: nowIso(repo),
    reject_reason: String(reject_reason).trim(),
    handled_at: nowIso(repo),
  });
  return { ok: true, request: updated };
}

/**
 * 員工撤回。
 * Phase 1.3:接受 'pending' / 'pending_mgr' / 'pending_ceo' 三個 status(都還沒走完審核)。
 */
const CANCELLABLE_STATUSES = new Set(['pending', 'pending_mgr', 'pending_ceo']);

export async function cancelLeaveRequest(repo, { request_id, cancelled_by }) {
  requireRepo(repo, ['findLeaveRequestById', 'updateLeaveRequest']);
  if (!request_id)   throw new Error('request_id required');
  if (!cancelled_by) throw new Error('cancelled_by required');

  const req = await repo.findLeaveRequestById(request_id);
  if (!req) return { ok: false, reason: 'NOT_FOUND' };
  if (!CANCELLABLE_STATUSES.has(req.status)) return { ok: false, reason: 'NOT_PENDING' };
  if (req.employee_id !== cancelled_by) {
    return { ok: false, reason: 'NOT_OWN_REQUEST' };
  }

  // P3.1:cancel 後只清 transient 的 'required'(員工撤回後沒人會交證明、
  // cron 漏 filter 時的 fallback)。'expired' / 'submitted' 是已發生事件、
  // 保留作為歷史(HR 在 leave-admin 看 cancelled row 仍能追蹤原 proof 狀態)。
  const patch = {
    status: 'cancelled',
    handled_at: nowIso(repo),
  };
  if (req.proof_status === 'required') {
    patch.proof_status = 'not_required';
  }
  const updated = await repo.updateLeaveRequest(request_id, patch);
  return { ok: true, request: updated };
}

// ─── helpers ─────────────────────────────────────────────────

function requireRepo(repo, methods) {
  if (!repo) throw new Error('repo required');
  for (const m of methods) {
    if (typeof repo[m] !== 'function') throw new Error(`repo.${m} is required`);
  }
}

function isoDate(iso) {
  return String(iso).slice(0, 10);
}

function combineDateTime(date, time) {
  // 假設台灣時區:用 +08:00 構造
  const t = String(time || '00:00').match(/^(\d{1,2}):(\d{2})/);
  if (!t) return Date.parse(`${date}T00:00:00+08:00`);
  return Date.parse(`${date}T${t[1].padStart(2,'0')}:${t[2]}:00+08:00`);
}

function nowIso(repo) {
  if (repo && typeof repo.nowIso === 'function') return repo.nowIso();
  return new Date().toISOString();
}
