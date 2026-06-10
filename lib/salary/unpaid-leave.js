// lib/salary/unpaid-leave.js
// Phase 3B:無薪/半薪請假扣薪純函式(可被 vitest 直接 import)
//
// 用途:
//   給 calculator 的 Step 3.5 用,把單筆 leave_request 在「目標月」內的天數分攤算出。
//   日薪扣薪公式:Σ daily_wage × allocateDaysInMonth(...) × (1 − pay_rate)
//   日薪基準 = base_salary / 30(正職;兼職 = 0,calculator 在外層 short-circuit)
//
// 跨月處理(allocation):
//   - 比例分攤(proportional):in_month_days = total_days × (clipped_calendar_days / total_calendar_days)
//   - clipped_calendar_days = clip 到目標月內的曆日數(start/end 兩端 clamp 至月首/月末)
//   - 完全在月內:total_calendar_days = clipped → in_month_days == total_days(無變化)
//   - 完全在月外:回 0
//   - 半日請假(days=0.5)單日同一月:total_cal=1, clipped=1 → 0.5 × 1 = 0.5(原值保留)
//
// 選此 allocation 的理由:
//   - 跨月情境少、HR 通常分兩筆寫;此公式對跨月也合理:
//     例 5/30~6/2 共 4 天請假、days=4 → 在 2026-06 算 4 × 2/4 = 2 天扣薪
//   - 不假設「每天均勻發生」、但對跨月的常見 4-7 天連假足夠精準
//   - HR 對精度有疑慮 → 改成「列 explicit per-day」要 leave_requests 加 per-day breakdown table

/**
 * @param {string} startDate - 'YYYY-MM-DD' 請假開始日
 * @param {string} endDate   - 'YYYY-MM-DD' 請假結束日
 * @param {number} totalDays - leave_requests.days 欄(NUMERIC、可含小數如 0.5)
 * @param {number} year      - 目標月份的年
 * @param {number} month     - 目標月份(1-12)
 * @returns {number} 該目標月分攤到的請假天數(可含小數、≥ 0)
 */
export function allocateDaysInMonth(startDate, endDate, totalDays, year, month) {
  const total = Number(totalDays);
  if (!Number.isFinite(total) || total <= 0) return 0;
  if (!startDate || !endDate) return 0;
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) return 0;

  const ls = parseDate(startDate);
  const le = parseDate(endDate);
  if (!ls || !le) return 0;
  if (le.getTime() < ls.getTime()) return 0;

  const monthStart = new Date(Date.UTC(year, month - 1, 1));
  const monthEnd   = new Date(Date.UTC(year, month, 0));   // 該月最後一天

  // 無重疊
  if (le.getTime() < monthStart.getTime()) return 0;
  if (ls.getTime() > monthEnd.getTime())   return 0;

  // 全程曆日 + clipped 曆日(inclusive 兩端 → +1)
  const totalCalDays = daysInclusive(ls, le);
  if (totalCalDays <= 0) return 0;

  const clipStart = ls.getTime() < monthStart.getTime() ? monthStart : ls;
  const clipEnd   = le.getTime() > monthEnd.getTime()   ? monthEnd   : le;
  const clippedCalDays = daysInclusive(clipStart, clipEnd);
  if (clippedCalDays <= 0) return 0;

  // 全程在月內 → 原值;否則按比例
  if (clippedCalDays === totalCalDays) return total;
  return total * (clippedCalDays / totalCalDays);
}

function parseDate(s) {
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return Number.isNaN(d.getTime()) ? null : d;
}

function daysInclusive(d1, d2) {
  return Math.floor((d2.getTime() - d1.getTime()) / 86400000) + 1;
}
