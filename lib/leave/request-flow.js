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
import { getLeaveType, requiresBalance, getBalancePool } from './types.js';
import { deductAnnualLeave, refundAnnualLeave, deductCompTime, HOURS_PER_DAY } from './balance.js';

/**
 * Repo 介面契約:
 *   findSchedulesInRange(employee_id, dateStart, dateEnd): Array<schedule>
 *   findLeaveType(code): row | null
 *   listActiveLeaveTypes(): Array<row>
 *   findActiveAnnualRecord(employee_id): row | null
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
 *   2. 對每個 schedule 計算「跟請假區間的交集」
 *   3. 加總成 total hours(支援半小時粒度)
 *
 * 簡化:本實作以「整段請假涵蓋整段排班」為主流情境;若請假區間不對齊排班時段,
 * 僅算「請假區間 ∩ 排班區間」的時長。多段班自動加總。
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

    const overlapStart = Math.max(startMs, segStartMs);
    const overlapEnd   = Math.min(endMs,   segEndMs);
    if (overlapEnd <= overlapStart) continue;

    const overlapMinutes = (overlapEnd - overlapStart) / 60000;
    // 扣 break:依 schedule 的 scheduled_work_minutes 比例還原
    // 簡化:若 scheduled_work_minutes 等於整段 span,代表沒 break,直接用 overlap;
    // 否則按比例(overlap / span)
    const span = (segEndMs - segStartMs) / 60000;
    const work = Number(s.scheduled_work_minutes) || span;
    const ratio = span > 0 ? Math.min(1, work / span) : 1;
    totalMinutes += overlapMinutes * ratio;
  }

  // 半小時粒度
  const hours = totalMinutes / 60;
  return Math.round(hours * 2) / 2;
}

/**
 * 建立 pending 假單。回 leave_requests row。
 */
export async function submitLeaveRequest(repo, {
  employee_id, leave_type, start_at, end_at, reason,
}) {
  requireRepo(repo, ['findLeaveType', 'insertLeaveRequest', 'findSchedulesInRange']);
  if (!employee_id) throw new Error('employee_id required');
  if (!leave_type)  throw new Error('leave_type required');
  if (!start_at || !end_at) throw new Error('start_at / end_at required');

  const lt = await getLeaveType(repo, leave_type);
  if (!lt) throw new Error(`unknown / inactive leave_type: ${leave_type}`);

  const hours = await calculateLeaveHours(repo, { employee_id, start_at, end_at });

  // 餘額預檢
  const pool0 = getBalancePool(lt);
  if (requiresBalance(lt) && pool0 === 'annual') {
    if (typeof repo.findActiveAnnualRecord !== 'function') {
      throw new Error('repo.findActiveAnnualRecord is required for balance precheck');
    }
    const rec = await repo.findActiveAnnualRecord(employee_id);
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

  const id = `L${Date.now()}_${employee_id}`;
  const row = {
    id,
    employee_id,
    leave_type,
    start_at, end_at,
    hours,
    finalized_hours: null,
    reason: reason || null,
    status: 'pending',
    // 為 legacy 相容,start_date/end_date/days 也填
    start_date: isoDate(start_at),
    end_date:   isoDate(end_at),
    days:       hours / HOURS_PER_DAY,
  };
  const created = await repo.insertLeaveRequest(row);
  return { ok: true, request: created };
}

export async function approveLeaveRequest(repo, { request_id, approved_by }) {
  requireRepo(repo, ['findLeaveRequestById', 'updateLeaveRequest', 'findLeaveType', 'findSchedulesInRange']);
  if (!request_id)  throw new Error('request_id required');
  if (!approved_by) throw new Error('approved_by required');

  const req = await repo.findLeaveRequestById(request_id);
  if (!req) return { ok: false, reason: 'NOT_FOUND' };
  if (req.status !== 'pending') return { ok: false, reason: 'NOT_PENDING' };

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
    // 把 deductions 寫進 leave_requests(供日後 cancel/refund 對齊回退)
    // 注意:這個欄位 Batch 1 schema 沒包,放在 patch 內 supabase 會 ignore;
    // 待 Batch 7 加 leave_requests.comp_deductions JSONB 後可正式記錄。
  }

  const updated = await repo.updateLeaveRequest(request_id, {
    status: 'approved',
    finalized_hours: finalizedHours,
    days: finalizedHours / HOURS_PER_DAY, // legacy 欄位保留
    reviewed_by: approved_by,
    reviewed_at: nowIso(repo),
    handled_at:  nowIso(repo), // legacy 欄位
  });
  return { ok: true, request: updated };
}

export async function rejectLeaveRequest(repo, { request_id, rejected_by, reject_reason }) {
  requireRepo(repo, ['findLeaveRequestById', 'updateLeaveRequest']);
  if (!request_id)  throw new Error('request_id required');
  if (!rejected_by) throw new Error('rejected_by required');
  if (!reject_reason || !String(reject_reason).trim()) {
    return { ok: false, reason: 'REJECT_REASON_REQUIRED' };
  }

  const req = await repo.findLeaveRequestById(request_id);
  if (!req) return { ok: false, reason: 'NOT_FOUND' };
  if (req.status !== 'pending') return { ok: false, reason: 'NOT_PENDING' };

  const updated = await repo.updateLeaveRequest(request_id, {
    status: 'rejected',
    reviewed_by: rejected_by,
    reviewed_at: nowIso(repo),
    reject_reason: String(reject_reason).trim(),
    handled_at: nowIso(repo),
  });
  return { ok: true, request: updated };
}

export async function cancelLeaveRequest(repo, { request_id, cancelled_by }) {
  requireRepo(repo, ['findLeaveRequestById', 'updateLeaveRequest']);
  if (!request_id)   throw new Error('request_id required');
  if (!cancelled_by) throw new Error('cancelled_by required');

  const req = await repo.findLeaveRequestById(request_id);
  if (!req) return { ok: false, reason: 'NOT_FOUND' };
  // 只能在 pending 撤回(approved 之後撤要走 refund 流程,此處先不支援)
  if (req.status !== 'pending') return { ok: false, reason: 'NOT_PENDING' };
  if (req.employee_id !== cancelled_by) {
    // 員工本人才能撤,HR 強制取消走另一條(暫不實作)
    return { ok: false, reason: 'NOT_OWN_REQUEST' };
  }

  const updated = await repo.updateLeaveRequest(request_id, {
    status: 'cancelled',
    handled_at: nowIso(repo),
  });
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
