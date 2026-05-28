// lib/leave/quota.js — 假期額度查詢純函式 + 累積型白名單
//
// 對應 endpoint:GET /api/leaves?_resource=quota_summary
//
// 用途:給 handler 算「累積型有上限假別」(病假 / 事假)某員工某年度的已用天數 / 次數,
// 接 leave_types.legal_max_days_per_year 算 remaining_days / is_over_limit。
//
// 設計:
//   * 純函式 + repo 注入(對齊 lib/leave/balance.js pattern、好測)
//   * 年度邊界 startInclusive = 'YYYY-01-01'、endExclusive = '(Y+1)-01-01'(半開區間)
//   * 白名單常數(ACCUMULATING_LEAVE_CODES)在這裡定一份、未來要加 code 改這行就好
//
// 不處理:
//   * 特休(annual)走 annual_leave_records.used_days 單欄位、由 getAnnualBalance 處理
//   * 補休(comp)走 comp_time_balance SUM(used_hours)、由 handler 直接 reduce
//
// 註:`getCurrentYearInTaipei` 跟 lib/leave/balance.js:20 的 todayInTaipei 邏輯接近,
//    但 balance.js 那支 module-local 沒 export、且回 'YYYY-MM-DD' 字串;
//    本檔需要 number 型年份、做小 helper 直接寫一份、不動既有檔。

/**
 * 累積型有年度上限的假別 code 白名單。
 * 目前只含病假 + 事假,未來要加 menstrual / family_care 改這行。
 */
export const ACCUMULATING_LEAVE_CODES = Object.freeze(['sick', 'personal', 'menstrual', 'family_care']);

/**
 * Asia/Taipei 當前年份(number)。給 handler 在 query.year 未顯式傳入時用。
 * 不能直接 new Date().getFullYear()(server UTC 跨年邊界會錯一天)。
 */
export function getCurrentYearInTaipei() {
  const ymd = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
  return Number(ymd.slice(0, 4));
}

/**
 * 算某員工某年度、白名單累積型假別的已用天數 / 次數。
 *
 * 純函式 + repo 注入。內部不呼叫 getCurrentYearInTaipei,year 一律由 caller 傳。
 *
 * @param {object} repo
 *   - sumLeaveDaysByTypeInYear({ employee_id, codes, startInclusive, endExclusive })
 *       回 Array<{ code, used_days, used_count }>、零單 code 也要回 { ..., 0, 0 }
 * @param {object} input
 * @param {string} input.employee_id
 * @param {number} input.year         整數(2026 等)
 * @param {string[]} input.codes      白名單 codes(通常 = ACCUMULATING_LEAVE_CODES)
 * @returns {Promise<Array<{ code, used_days, used_count }>>}
 */
export async function calculateAccumulatingUsage(repo, { employee_id, year, codes } = {}) {
  if (!repo || typeof repo.sumLeaveDaysByTypeInYear !== 'function') {
    throw new Error('repo.sumLeaveDaysByTypeInYear is required');
  }
  if (!employee_id) throw new Error('employee_id required');
  if (!Number.isInteger(year)) throw new Error('year must be integer');
  if (!Array.isArray(codes) || codes.length === 0) {
    throw new Error('codes must be non-empty array');
  }

  // ⚠ 邊界字串帶 Taipei +08:00 offset、避免 PG 把 'YYYY-01-01' cast 成 UTC 半夜、
  //    讓 Taipei 跨年凌晨 0-8 點的假單歸錯年度。對應 balance.js:20 todayInTaipei 同一坑。
  const startInclusive = `${year}-01-01T00:00:00+08:00`;
  const endExclusive   = `${year + 1}-01-01T00:00:00+08:00`;

  const rows = await repo.sumLeaveDaysByTypeInYear({
    employee_id, codes, startInclusive, endExclusive,
  });

  // 防 repo 沒對齊「零單 code 補 zero」契約 — quota 層再做一次 zero-fill 保險。
  const byCode = Object.fromEntries((rows || []).map((r) => [r.code, r]));
  return codes.map((c) => byCode[c] || { code: c, used_days: 0, used_count: 0 });
}
