// lib/leave/balance.js — 特休餘額查詢與異動（純函式 + repo 注入式）
//
// 對應設計文件：docs/attendance-system-design-v1.md §4.3.3 / §4.3.5
// 對應實作計畫：docs/attendance-system-implementation-plan-v1.md §7.4
//
// 重要單位約定：
//   annual_leave_records 用 days(NUMERIC 4,1)
//   leave_balance_logs.hours_delta 統一存「小時」(NUMERIC 5,2)
//   annual 的 hours_delta 換算規則：days × 8(1 工作日 = 8 工時)
//   呼叫端讀 logs 時若 balance_type='annual' 要除以 8 還原 days
//
// 併發控制:annual_leave_records 不存 version 欄位,改用樂觀鎖
// (UPDATE WHERE used_days = 原值,失敗 → 重試或回 CONCURRENT_UPDATE 錯誤)。
// 對應 supabase repo 在 API handler 內實作 lockAndIncrementUsedDays。

const HOURS_PER_DAY = 8;

/**
 * Repo 介面契約：
 *   findActiveAnnualRecord(employee_id): Promise<row | null>
 *     找該員工 status='active' 的 annual_leave_records(理論上同時只有一筆)
 *   lockAndIncrementUsedDays({ record_id, delta_days, allow_negative })
 *     原子更新 used_days(透過樂觀鎖實作),回 { ok, record? , reason? }
 *     reason: 'INSUFFICIENT_BALANCE' / 'NEGATIVE_BALANCE' / 'CONCURRENT_UPDATE' / 'NOT_FOUND'
 *   insertBalanceLog(row): 寫 leave_balance_logs
 */

export async function getAnnualBalance(repo, employee_id) {
  if (!repo || typeof repo.findActiveAnnualRecord !== 'function') {
    throw new Error('repo.findActiveAnnualRecord is required');
  }
  if (!employee_id) throw new Error('employee_id required');

  const rec = await repo.findActiveAnnualRecord(employee_id);
  if (!rec) {
    return {
      has_record: false,
      legal_days: 0, granted_days: 0, used_days: 0, remaining_days: 0,
      period_start: null, period_end: null,
    };
  }
  const granted = Number(rec.granted_days);
  const used    = Number(rec.used_days);
  return {
    has_record: true,
    record_id: rec.id,
    legal_days:     Number(rec.legal_days),
    granted_days:   granted,
    used_days:      used,
    remaining_days: Math.max(0, granted - used),
    period_start:   rec.period_start,
    period_end:     rec.period_end,
    status:         rec.status,
  };
}

export async function deductAnnualLeave(repo, { employee_id, days, leave_request_id, changed_by, reason }) {
  requireRepo(repo, ['findActiveAnnualRecord', 'lockAndIncrementUsedDays', 'insertBalanceLog']);
  if (!employee_id)            throw new Error('employee_id required');
  if (!changed_by)             throw new Error('changed_by required');
  if (!Number.isFinite(+days) || +days <= 0) throw new Error('days must be positive number');

  const rec = await repo.findActiveAnnualRecord(employee_id);
  if (!rec) {
    return { ok: false, reason: 'NO_ACTIVE_RECORD' };
  }

  const r = await repo.lockAndIncrementUsedDays({
    record_id: rec.id, delta_days: +days, allow_negative: false,
  });
  if (!r.ok) return r;

  await repo.insertBalanceLog({
    employee_id,
    balance_type: 'annual',
    annual_record_id: rec.id,
    comp_record_id: null,
    leave_request_id: leave_request_id || null,
    change_type: 'use',
    hours_delta: -(+days) * HOURS_PER_DAY, // 扣減 → 負值
    changed_by,
    reason: reason || null,
  });
  return { ok: true, record: r.record };
}

export async function refundAnnualLeave(repo, { employee_id, days, leave_request_id, changed_by, reason }) {
  requireRepo(repo, ['findActiveAnnualRecord', 'lockAndIncrementUsedDays', 'insertBalanceLog']);
  if (!employee_id)            throw new Error('employee_id required');
  if (!changed_by)             throw new Error('changed_by required');
  if (!Number.isFinite(+days) || +days <= 0) throw new Error('days must be positive number');

  const rec = await repo.findActiveAnnualRecord(employee_id);
  if (!rec) return { ok: false, reason: 'NO_ACTIVE_RECORD' };

  const r = await repo.lockAndIncrementUsedDays({
    record_id: rec.id, delta_days: -(+days), allow_negative: false,
  });
  if (!r.ok) return r;

  await repo.insertBalanceLog({
    employee_id,
    balance_type: 'annual',
    annual_record_id: rec.id,
    comp_record_id: null,
    leave_request_id: leave_request_id || null,
    change_type: 'cancel_use',
    hours_delta: (+days) * HOURS_PER_DAY, // 退還 → 正值
    changed_by,
    reason: reason || null,
  });
  return { ok: true, record: r.record };
}

// TODO(Batch 6): deductCompTime / refundCompTime 未實作。
// 補休餘額管理屬於 comp_time_balance(FIFO 取最舊未過期),
// 需要 Batch 6 完整 comp-time 系統才能正確扣減。
// 本批 approveLeaveRequest 對 leave_type='comp' 走 no-op(不檢查也不扣)。
//
// export async function deductCompTime(repo, { employee_id, hours, leave_request_id, changed_by }) {
//   throw new Error('deductCompTime not implemented (Batch 6)');
// }
// export async function refundCompTime(repo, { employee_id, hours, leave_request_id, changed_by }) {
//   throw new Error('refundCompTime not implemented (Batch 6)');
// }

export { HOURS_PER_DAY };

function requireRepo(repo, methods) {
  if (!repo) throw new Error('repo required');
  for (const m of methods) {
    if (typeof repo[m] !== 'function') throw new Error(`repo.${m} is required`);
  }
}
