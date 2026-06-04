// lib/salary/finalMonth.js — 離職月 pro-rata 推導(純函式)
//
// 對應修補:HR 直接 PUT status=resigned / DELETE /api/employees/:id 走的不是
// approvals.js applyResignation cascade,salary_records.is_final_month 旗標
// 從未被寫;batch_v2 撈到該員工(active+該月離職 union)後、calculator
// 因 existing.is_final_month=null 走非離職月分支算成整月全薪。
//
// 本 helper 給 calculator 在 existing 旗標未設時、自行從 emp.resign_date /
// emp.resigned_at 推導離職月,套用同 approvals.js 的 calendar-day 口徑:
//   worked_days = 離職日當月第幾天(假設員工自當月 1 日起在職)
//   total_days_in_month = 當月總曆日
//
// 注意:本 helper 不處理「中途入職又中途離職」雙邊 prorata、不處理「無薪假留職停薪」、
//       不處理「resign_date(planning)與 resigned_at(audit SoT)月份不一致」場景。
//       存在多個離職日期欄位時優先 resign_date(planning 較準確),fallback resigned_at。

/**
 * 判定 emp 是否在指定 (year, month) 為離職月,回傳 calendar-day prorata 的分子分母。
 * 僅在 status==='resigned' 且離職日落在該年月時回傳;否則 null。
 *
 * @param {{ status?: string, resign_date?: string|null, resigned_at?: string|null }} emp
 * @param {number} year   西元年 (e.g. 2026)
 * @param {number} month  1-12
 * @returns {{ workedDays: number, totalDaysInMonth: number } | null}
 */
export function resolveFinalMonthDays(emp, year, month) {
  if (!emp || emp.status !== 'resigned') return null;
  let ry, rmo, rday;
  if (emp.resign_date) {
    const [y, mo, d] = String(emp.resign_date).split('-').map((n) => parseInt(n, 10));
    ry = y; rmo = mo; rday = d;
  } else if (emp.resigned_at) {
    // Asia/Taipei 固定 UTC+8、無 DST(對齊 approvals.js applyResignation 的時區處理)
    const tp = new Date(new Date(emp.resigned_at).getTime() + 8 * 3600 * 1000);
    ry = tp.getUTCFullYear(); rmo = tp.getUTCMonth() + 1; rday = tp.getUTCDate();
  } else {
    return null;
  }
  if (!Number.isFinite(ry) || !Number.isFinite(rmo) || !Number.isFinite(rday)) return null;
  if (ry !== year || rmo !== month) return null;
  const totalDaysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const workedDays = Math.min(Math.max(rday, 0), totalDaysInMonth);
  return { workedDays, totalDaysInMonth };
}
