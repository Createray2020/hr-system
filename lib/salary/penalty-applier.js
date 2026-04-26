// lib/salary/penalty-applier.js — 出勤懲處套用(純函式 + repo 注入式)
//
// 對應設計文件:docs/attendance-system-design-v1.md §10
// 對應實作計畫:docs/attendance-system-implementation-plan-v1.md §11.3
//
// 規則:
//   - 撈該月 status='pending' 的 attendance_penalty_records
//   - 排除 status='waived'
//   - 只加總「現金扣款類」penalty_type:deduct_money / deduct_money_per_min
//     (deduct_attendance_bonus_pct 由 lib/attendance/bonus.js 算入 deduction_rate;
//      deduct_attendance_bonus 視為「扣全勤獎金整筆」目前不在 penalty_total — 由 bonus 機制處理;
//      warning / custom 不扣現金)
//   - 把對應 records 的 status 改 'applied' + salary_record_id

/**
 * Repo 介面契約:
 *   findPendingPenaltyRecords({ employee_id, year, month }): Array<row>
 *     status='pending' 的紀錄
 *   markPenaltyRecordApplied(id, salary_record_id): updated row
 */

const CASH_DEDUCT_TYPES = new Set(['deduct_money', 'deduct_money_per_min']);

export async function applyAttendancePenalties(repo, { employee_id, year, month, salary_record_id }) {
  requireRepo(repo, ['findPendingPenaltyRecords', 'markPenaltyRecordApplied']);
  if (!employee_id) throw new Error('employee_id required');
  if (!Number.isInteger(year))  throw new Error('year required');
  if (!Number.isInteger(month) || month < 1 || month > 12) throw new Error('month invalid');

  const rows = await repo.findPendingPenaltyRecords({ employee_id, year, month });
  let total = 0;
  const items = [];
  for (const r of (rows || [])) {
    if (!CASH_DEDUCT_TYPES.has(r.penalty_type)) continue;
    const amt = Number(r.penalty_amount) || 0;
    total += amt;
    items.push({
      penalty_record_id: r.id,
      trigger_type: r.trigger_type,
      trigger_minutes: r.trigger_minutes,
      penalty_type: r.penalty_type,
      amount: amt,
    });
    if (salary_record_id) {
      await repo.markPenaltyRecordApplied(r.id, salary_record_id);
    }
  }

  return {
    total: round2(total),
    breakdown: items,
    count: items.length,
  };
}

function requireRepo(repo, methods) {
  if (!repo) throw new Error('repo required');
  for (const m of methods) {
    if (typeof repo[m] !== 'function') throw new Error(`repo.${m} is required`);
  }
}

function round2(n) { return Math.round(Number(n) * 100) / 100; }
