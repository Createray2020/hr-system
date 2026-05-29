// lib/overtime/pay-calc.js — 加班費計算(純函式)
//
// 對應設計文件:docs/attendance-system-design-v1.md §4.4 / §10
// 對應實作計畫:docs/attendance-system-implementation-plan-v1.md §9.4
//
// 倍率規則(對齊勞基法):
//   weekday:前 2h 用 first_2h_rate、2h+ 用 after_2h_rate(§24 I)
//   rest_day:三段 — 0-2h first_2h_rate、2-8h after_2h_rate、8-12h after_8h_rate ≈ 2.67(§24 II)
//   statutory_rest(例假)/ national_holiday(國定):整段用 holidayMultiplier、預設 2.0(§40 加倍)
//
// pay_multiplier 是「整體申請的代表倍率」,在申請當下凍結:
//   - national_holiday / statutory_rest 用 holidayMultiplier(預設 2.0)
//   - weekday/rest_day 用「前 2h 的倍率」做代表(實際金額由本檔的 breakdown 計算精確值)

/**
 * 計算單筆加班費。
 *
 * @param {number} hours
 * @param {number} hourlyRate
 * @param {{
 *   weekday_overtime_first_2h_rate, weekday_overtime_after_2h_rate,
 *   rest_day_overtime_first_2h_rate, rest_day_overtime_after_2h_rate,
 * }} multiplierConfig
 * @param {'weekday'|'rest_day'|'national_holiday'|'statutory_rest'} dayType
 * @param {number} [holidayMultiplier]  national_holiday / statutory_rest 時要傳;缺值 fallback 2.0
 * @returns {{ amount, breakdown: { hours_first_2h, rate_first_2h, hours_after_2h, rate_after_2h, hours_after_8h?, rate_after_8h?, holiday_hours, holiday_rate, hourly_rate, day_type } }}
 */
export function calculateOvertimePay(hours, hourlyRate, multiplierConfig, dayType, holidayMultiplier) {
  const h  = Math.max(0, Number(hours) || 0);
  const hr = Math.max(0, Number(hourlyRate) || 0);
  if (h === 0 || hr === 0) {
    return { amount: 0, breakdown: emptyBreakdown(dayType, hr) };
  }

  // §40 加倍類:國定假日 / 例假(statutory_rest)整段 × multiplier(預設 2.0)
  if (dayType === 'national_holiday' || dayType === 'statutory_rest') {
    const m = Number(holidayMultiplier) || 2.0;
    const amount = round2(h * hr * m);
    return {
      amount,
      breakdown: {
        ...emptyBreakdown(dayType, hr),
        holiday_hours: h,
        holiday_rate:  m,
      },
    };
  }

  // §24 II 休息日三段:0-2h、2-8h、8-12h
  if (dayType === 'rest_day') {
    const r1 = Number(multiplierConfig?.rest_day_overtime_first_2h_rate) || 1.34;
    const r2 = Number(multiplierConfig?.rest_day_overtime_after_2h_rate) || 1.67;
    const r3 = Number(multiplierConfig?.rest_day_overtime_after_8h_rate) || 2.67;
    const h1 = Math.min(2, h);
    const h2 = Math.min(6, Math.max(0, h - 2));
    const h3 = Math.max(0, h - 8);
    const amount = round2(h1 * hr * r1 + h2 * hr * r2 + h3 * hr * r3);
    return {
      amount,
      breakdown: {
        ...emptyBreakdown(dayType, hr),
        hours_first_2h: h1, rate_first_2h: r1,
        hours_after_2h: h2, rate_after_2h: r2,
        hours_after_8h: h3, rate_after_8h: r3,
      },
    };
  }

  // §24 I 平日兩段
  const r1 = Number(multiplierConfig?.weekday_overtime_first_2h_rate) || 1.34;
  const r2 = Number(multiplierConfig?.weekday_overtime_after_2h_rate) || 1.67;
  const h1 = Math.min(2, h);
  const h2 = Math.max(0, h - 2);
  const amount = round2(h1 * hr * r1 + h2 * hr * r2);

  return {
    amount,
    breakdown: {
      ...emptyBreakdown(dayType, hr),
      hours_first_2h: h1, rate_first_2h: r1,
      hours_after_2h: h2, rate_after_2h: r2,
    },
  };
}

/**
 * 取「申請當下凍結」的 pay_multiplier 代表值。
 * 此值寫入 overtime_requests.pay_multiplier(NUMERIC 4,2),
 * 用作日後查報表 / 顯示用,實際薪資金額由 breakdown 計算。
 */
export function pickFrozenPayMultiplier(dayType, multiplierConfig, holidayMultiplier) {
  if (dayType === 'national_holiday') {
    return Number(holidayMultiplier) || 2.0;
  }
  if (dayType === 'statutory_rest') {
    return Number(holidayMultiplier) || 2.0;
  }
  if (dayType === 'rest_day') {
    return Number(multiplierConfig?.rest_day_overtime_first_2h_rate) || 1.34;
  }
  return Number(multiplierConfig?.weekday_overtime_first_2h_rate) || 1.34;
}

/**
 * 從月薪換算時薪。
 *
 * @param {number} monthlySalary
 * @param {number} [monthlyWorkHoursBase]  預設 240(規範)
 */
export function getHourlyRate(monthlySalary, monthlyWorkHoursBase) {
  // 預設 base 240(規範);明確傳 0 視為呼叫端錯誤 → 回 0(避免除以 0)。
  const base = monthlyWorkHoursBase == null
    ? 240
    : Number(monthlyWorkHoursBase);
  if (!Number.isFinite(+monthlySalary) || +monthlySalary <= 0) return 0;
  if (!Number.isFinite(base) || base <= 0) return 0;
  return round2(+monthlySalary / base);
}

// ─── helpers ─────────────────────────────────────────────────

function emptyBreakdown(dayType, hr) {
  return {
    hours_first_2h: 0, rate_first_2h: 0,
    hours_after_2h: 0, rate_after_2h: 0,
    holiday_hours:  0, holiday_rate:  0,
    hourly_rate:    hr,
    day_type:       dayType,
  };
}

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}
