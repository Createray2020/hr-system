// lib/salary/overtime-aggregator.js — 加班費聚合(純函式 + repo 注入式)
//
// 對應設計文件:docs/attendance-system-design-v1.md §10
// 對應實作計畫:docs/attendance-system-implementation-plan-v1.md §11.3
//
// 規則:
//   - 撈該月 status='approved' 且 compensation_type='overtime_pay' 的 overtime_requests
//   - 直接加總 estimated_pay(申請當下凍結的金額;不重算 — 規範:「加總 estimated_pay 或重算」二選一)
//   - 同時 mark applied_to_salary_record_id(完整重算模式:呼叫端先 reset child markers)

/**
 * Repo 介面契約:
 *   findApprovedOvertimePayRequests({ employee_id, year, month }): Array<row>
 *     status='approved' AND compensation_type='overtime_pay' AND applies_to_year/month 對應
 *   markOvertimeRequestApplied(id, salary_record_id): updated row
 */

export async function aggregateOvertimePay(repo, { employee_id, year, month, salary_record_id }) {
  requireRepo(repo, ['findApprovedOvertimePayRequests', 'markOvertimeRequestApplied']);
  if (!employee_id) throw new Error('employee_id required');
  if (!Number.isInteger(year))  throw new Error('year required');
  if (!Number.isInteger(month) || month < 1 || month > 12) throw new Error('month invalid');

  const rows = await repo.findApprovedOvertimePayRequests({ employee_id, year, month });
  let total = 0;
  const items = [];
  for (const r of (rows || [])) {
    const amount = Number(r.estimated_pay) || 0;
    total += amount;
    items.push({
      overtime_request_id: r.id,
      overtime_date: r.overtime_date,
      hours: Number(r.hours),
      pay_multiplier: r.pay_multiplier != null ? Number(r.pay_multiplier) : null,
      estimated_pay: amount,
    });
    if (salary_record_id) {
      await repo.markOvertimeRequestApplied(r.id, salary_record_id);
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
