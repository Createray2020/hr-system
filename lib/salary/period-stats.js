// lib/salary/period-stats.js — payroll_periods 統計 cache reconcile
//
// 從 salary_records 加總同 period_id 的 row、輸出 4 個 cache 欄位:
//   employee_count / gross_total / net_total / employer_cost_total
//
// 純函式、由 batch_v2 跑完後呼叫、寫回 payroll_periods.* cache 欄位

/**
 * 計算單個 period 的統計(純函式、不查 DB)
 *
 * @param {Array} records - salary_records 同 period_id 的 row 列表
 * @returns {{ employee_count, gross_total, net_total, employer_cost_total }}
 */
export function calculatePeriodStats(records) {
  const stats = {
    employee_count: 0,
    gross_total: 0,
    net_total: 0,
    employer_cost_total: 0,
  };
  for (const r of (records || [])) {
    stats.employee_count += 1;
    stats.gross_total += Number(r.gross_salary) || 0;
    stats.net_total   += Number(r.net_salary)   || 0;
    stats.employer_cost_total +=
      (Number(r.employer_cost_labor)        || 0) +
      (Number(r.employer_cost_health)       || 0) +
      (Number(r.employer_cost_pension)      || 0) +
      (Number(r.employer_cost_occupational) || 0) +
      (Number(r.employer_cost_employment)   || 0) +
      (Number(r.employer_cost_welfare)      || 0);
  }
  // NUMERIC 2 位小數、cache 同 precision
  stats.gross_total         = round2(stats.gross_total);
  stats.net_total           = round2(stats.net_total);
  stats.employer_cost_total = round2(stats.employer_cost_total);
  return stats;
}

/**
 * 高階介面: 從 repo 撈再算
 */
export async function reconcilePeriodStats(repo, periodId) {
  const records = await repo.findSalaryRecordsByPeriodId(periodId);
  return calculatePeriodStats(records);
}

function round2(n) { return Math.round(Number(n) * 100) / 100; }
