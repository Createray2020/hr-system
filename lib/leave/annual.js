// lib/leave/annual.js — 特休年資 → 法定天數計算（純函式）
//
// 對應勞基法 §38(2017 修正版本)：
//   滿 6 個月 ~ 1 年:3 天
//   滿 1 年 ~ 2 年:7 天
//   滿 2 年 ~ 3 年:10 天
//   滿 3 年 ~ 5 年:14 天
//   滿 5 年 ~ 10 年:15 天
//   滿 10 年起,每滿 1 年 +1 天,上限 30 天
//
// 對應實作計畫：docs/attendance-system-implementation-plan-v1.md §7.2

/**
 * 依年資計算法定特休天數。
 *
 * @param {number} seniorityYears  到 today 為止的年資(連續年數)
 * @returns {number}  法定天數(整數)
 */
export function calculateLegalDays(seniorityYears) {
  const y = Number(seniorityYears);
  if (!Number.isFinite(y) || y < 0) return 0;

  if (y < 0.5) return 0;
  if (y < 1)   return 3;
  if (y < 2)   return 7;
  if (y < 3)   return 10;
  if (y < 5)   return 14;
  if (y < 10)  return 15;

  // 10 年起,每滿 1 年 +1 天,上限 30
  // 10 年 = 16 天;11 年 = 17 天;...;24 年 = 30 天;25 年(以上) = 30 天
  const extra = Math.floor(y) - 10 + 1; // 滿 10 年 → +1
  return Math.min(30, 15 + extra);
}

/**
 * 週年制:給定 seniority_start 與 today,回今年的特休週期 [period_start, period_end]
 * 與當前年資。
 *
 * 規則:
 *   - period_start = seniority_start 平移到「今年週年日」(月日對齊,年取 today 所在年)
 *     若 today 還沒到今年的週年日 → period 是「上一年週年日 ~ 今年週年日 - 1 天」
 *     若 today 已過今年的週年日 → period 是「今年週年日 ~ 明年週年日 - 1 天」
 *   - seniority_years = 從 seniority_start 算到 period_start 的整數年(週期開始當下的年資)
 *
 * @param {string} seniorityStart  'YYYY-MM-DD'
 * @param {string} today           'YYYY-MM-DD'
 * @returns {{ period_start: string, period_end: string, seniority_years: number }}
 */
export function calculatePeriodBoundary(seniorityStart, today) {
  const ss = parseDate(seniorityStart);
  const td = parseDate(today);
  if (!ss || !td) throw new Error('invalid date');
  if (td < ss) {
    // today 還沒到 seniority_start(尚未開始累計),回首期 0 年
    const next = addYears(ss, 1);
    return {
      period_start: fmtDate(ss),
      period_end:   fmtDate(addDays(next, -1)),
      seniority_years: 0,
    };
  }

  const anniversaryThisYear = setYear(ss, td.getUTCFullYear());

  let periodStart, periodEnd;
  if (td >= anniversaryThisYear) {
    periodStart = anniversaryThisYear;
    periodEnd   = addDays(addYears(periodStart, 1), -1);
  } else {
    periodStart = setYear(ss, td.getUTCFullYear() - 1);
    periodEnd   = addDays(anniversaryThisYear, -1);
  }

  const seniorityYears = yearsDiff(ss, periodStart);
  return {
    period_start: fmtDate(periodStart),
    period_end:   fmtDate(periodEnd),
    seniority_years: seniorityYears,
  };
}

// ─── helpers ────────────────────────────────────────────────

function parseDate(s) {
  if (!s) return null;
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return isNaN(d.getTime()) ? null : d;
}

function fmtDate(d) {
  return d.toISOString().slice(0, 10);
}

function addYears(d, n) {
  const r = new Date(d);
  r.setUTCFullYear(r.getUTCFullYear() + n);
  return r;
}

function addDays(d, n) {
  const r = new Date(d);
  r.setUTCDate(r.getUTCDate() + n);
  return r;
}

function setYear(d, y) {
  const r = new Date(d);
  r.setUTCFullYear(y);
  return r;
}

function yearsDiff(from, to) {
  let years = to.getUTCFullYear() - from.getUTCFullYear();
  // 若還沒過月日週年,要 -1
  if (
    to.getUTCMonth() < from.getUTCMonth() ||
    (to.getUTCMonth() === from.getUTCMonth() && to.getUTCDate() < from.getUTCDate())
  ) {
    years -= 1;
  }
  return Math.max(0, years);
}
