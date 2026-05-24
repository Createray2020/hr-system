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

// B14:Asia/Taipei 當天日期(YYYY-MM-DD),給 getAnnualBalance / 預設 leave_date 用。
// 不能用 new Date().toISOString().slice(0,10)(會給 UTC 日期、Taipei 凌晨 0-8 點會錯一天)。
function todayInTaipei() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
}

/**
 * Repo 介面契約：
 *   findAnnualRecordCoveringDate(employee_id, leaveDate): Promise<row | null>
 *     找該員工 status='active'、period_start <= leaveDate <= period_end 的 record
 *     (多 active 並存時依日期決定挑哪 period、修 B14)
 *   lockAndIncrementUsedDays({ record_id, delta_days, allow_negative })
 *     原子更新 used_days(透過樂觀鎖實作),回 { ok, record? , reason? }
 *     reason: 'INSUFFICIENT_BALANCE' / 'NEGATIVE_BALANCE' / 'CONCURRENT_UPDATE' / 'NOT_FOUND'
 *   insertBalanceLog(row): 寫 leave_balance_logs
 */

// B14:as_of_date optional、不傳預設 Asia/Taipei 今天。
// 兩個現存 caller(api/leaves handleGetAnnualBalance、api/annual-leaves handleGet)
// 簽名不變、自動走 today。需要查歷史時點再顯式傳 as_of_date。
export async function getAnnualBalance(repo, employee_id, as_of_date = null) {
  if (!repo || typeof repo.findAnnualRecordCoveringDate !== 'function') {
    throw new Error('repo.findAnnualRecordCoveringDate is required');
  }
  if (!employee_id) throw new Error('employee_id required');

  const date = as_of_date || todayInTaipei();
  const rec = await repo.findAnnualRecordCoveringDate(employee_id, date);
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

// B14:leave_date(YYYY-MM-DD)required、caller 必須傳假單真正落在哪天。
export async function deductAnnualLeave(repo, { employee_id, days, leave_request_id, changed_by, reason, leave_date }) {
  requireRepo(repo, ['findAnnualRecordCoveringDate', 'lockAndIncrementUsedDays', 'insertBalanceLog']);
  if (!employee_id)            throw new Error('employee_id required');
  if (!changed_by)             throw new Error('changed_by required');
  if (!leave_date)             throw new Error('leave_date required');
  if (!Number.isFinite(+days) || +days <= 0) throw new Error('days must be positive number');

  const rec = await repo.findAnnualRecordCoveringDate(employee_id, leave_date);
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

// B14:leave_date(YYYY-MM-DD)required、退到當初扣的那 record。
export async function refundAnnualLeave(repo, { employee_id, days, leave_request_id, changed_by, reason, leave_date }) {
  requireRepo(repo, ['findAnnualRecordCoveringDate', 'lockAndIncrementUsedDays', 'insertBalanceLog']);
  if (!employee_id)            throw new Error('employee_id required');
  if (!changed_by)             throw new Error('changed_by required');
  if (!leave_date)             throw new Error('leave_date required');
  if (!Number.isFinite(+days) || +days <= 0) throw new Error('days must be positive number');

  const rec = await repo.findAnnualRecordCoveringDate(employee_id, leave_date);
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

// ── 補休 (comp_time_balance) FIFO 餘額異動 — Batch 6 補上 ──
//
// FIFO 規則:active 且 remaining_hours > 0 的 records,按 expires_at ASC 排序,
// 從最早到期那筆開始扣;扣完該筆後 remaining 還沒清零繼續下一筆,可能跨多筆。
// 退還(cancel_use)優先按 original_deductions 反向退;若呼叫端沒提供,退到
// used_hours > 0 的 records 中按 earned_at ASC 退(對應 FIFO 的扣減順序)。

/**
 * Repo 介面契約(comp 部分):
 *   findActiveCompBalances(employee_id): Array<row>  status='active' 且 expires_at 未到,
 *                                                    按 expires_at ASC, earned_at ASC 排序
 *   lockAndIncrementCompUsedHours({ comp_id, delta_hours, allow_negative }): { ok, record?, reason? }
 *     原子更新 comp_time_balance.used_hours(樂觀鎖)
 */

export async function deductCompTime(repo, { employee_id, hours, leave_request_id, changed_by, reason }) {
  requireRepo(repo, ['findActiveCompBalances', 'lockAndIncrementCompUsedHours', 'insertBalanceLog']);
  if (!employee_id) throw new Error('employee_id required');
  if (!changed_by)  throw new Error('changed_by required');
  if (!Number.isFinite(+hours) || +hours <= 0) throw new Error('hours must be positive number');

  const balances = await repo.findActiveCompBalances(employee_id);
  const totalRemaining = (balances || []).reduce(
    (s, b) => s + (Number(b.earned_hours) - Number(b.used_hours)), 0,
  );
  if (totalRemaining + 1e-6 < +hours) {
    return {
      ok: false, reason: 'INSUFFICIENT_COMP_BALANCE',
      total_remaining: totalRemaining, requested: +hours,
    };
  }

  let remaining = +hours;
  const deductions = [];
  for (const b of balances) {
    if (remaining <= 1e-6) break;
    const avail = Number(b.earned_hours) - Number(b.used_hours);
    if (avail <= 1e-6) continue;
    const take = Math.min(avail, remaining);

    const r = await repo.lockAndIncrementCompUsedHours({
      comp_id: b.id, delta_hours: take, allow_negative: false,
    });
    if (!r.ok) return r;

    await repo.insertBalanceLog({
      employee_id,
      balance_type: 'comp',
      annual_record_id: null,
      comp_record_id: b.id,
      leave_request_id: leave_request_id || null,
      change_type: 'use',
      hours_delta: -take,
      changed_by,
      reason: reason || null,
    });

    deductions.push({ comp_id: b.id, hours: take });
    remaining -= take;
  }

  return { ok: true, deductions };
}

export async function refundCompTime(repo, {
  employee_id, hours, leave_request_id, changed_by, reason, original_deductions,
}) {
  requireRepo(repo, ['findActiveCompBalances', 'lockAndIncrementCompUsedHours', 'insertBalanceLog']);
  if (!employee_id) throw new Error('employee_id required');
  if (!changed_by)  throw new Error('changed_by required');
  if (!Number.isFinite(+hours) || +hours <= 0) throw new Error('hours must be positive number');

  // 優先按原 deductions 反向退(精準對齊原扣減的 records)
  if (Array.isArray(original_deductions) && original_deductions.length) {
    for (const d of original_deductions) {
      const r = await repo.lockAndIncrementCompUsedHours({
        comp_id: d.comp_id, delta_hours: -Number(d.hours), allow_negative: false,
      });
      if (!r.ok) return r;
      await repo.insertBalanceLog({
        employee_id,
        balance_type: 'comp',
        annual_record_id: null,
        comp_record_id: d.comp_id,
        leave_request_id: leave_request_id || null,
        change_type: 'cancel_use',
        hours_delta: +Number(d.hours),
        changed_by,
        reason: reason || null,
      });
    }
    return { ok: true };
  }

  // 沒原記錄:按 used_hours > 0 的 records 中,earned_at ASC 順序退
  // (跟 deduct 同樣 FIFO 順序,代表退最早被扣的)
  const balances = await repo.findActiveCompBalances(employee_id);
  let remaining = +hours;
  for (const b of (balances || [])) {
    if (remaining <= 1e-6) break;
    const used = Number(b.used_hours);
    if (used <= 1e-6) continue;
    const give = Math.min(used, remaining);
    const r = await repo.lockAndIncrementCompUsedHours({
      comp_id: b.id, delta_hours: -give, allow_negative: false,
    });
    if (!r.ok) return r;
    await repo.insertBalanceLog({
      employee_id,
      balance_type: 'comp',
      annual_record_id: null,
      comp_record_id: b.id,
      leave_request_id: leave_request_id || null,
      change_type: 'cancel_use',
      hours_delta: +give,
      changed_by,
      reason: reason || null,
    });
    remaining -= give;
  }
  // 若 remaining 還有剩(原扣減已被部分結算 / 過期),回 ok 但回 unmatched
  return { ok: true, unmatched_hours: Math.max(0, remaining) };
}

export { HOURS_PER_DAY };

function requireRepo(repo, methods) {
  if (!repo) throw new Error('repo required');
  for (const m of methods) {
    if (typeof repo[m] !== 'function') throw new Error(`repo.${m} is required`);
  }
}
