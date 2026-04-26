// lib/overtime/pay-calc.js — 加班費計算(純函式)
//
// 對應設計文件:docs/attendance-system-design-v1.md §4.4 / §10
// 對應實作計畫:docs/attendance-system-implementation-plan-v1.md §9.4
//
// 倍率規則:
//   weekday / rest_day:前 2h 用 first_2h_rate、超過 2h 用 after_2h_rate
//   national_holiday:整段用 holidays.pay_multiplier(通常 2.0)
//
// pay_multiplier 是「整體申請的代表倍率」,在申請當下凍結:
//   - national_holiday 用 holidays.pay_multiplier
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
 * @param {'weekday'|'rest_day'|'national_holiday'} dayType
 * @param {number} [holidayMultiplier]  national_holiday 時要傳 holidays.pay_multiplier
 * @returns {{ amount, breakdown: { hours_first_2h, rate_first_2h, hours_after_2h, rate_after_2h, holiday_hours, holiday_rate, hourly_rate, day_type } }}
 */
export function calculateOvertimePay(hours, hourlyRate, multiplierConfig, dayType, holidayMultiplier) {
  const h  = Math.max(0, Number(hours) || 0);
  const hr = Math.max(0, Number(hourlyRate) || 0);
  if (h === 0 || hr === 0) {
    return { amount: 0, breakdown: emptyBreakdown(dayType, hr) };
  }

  if (dayType === 'national_holiday') {
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

  const r1 = dayType === 'rest_day'
    ? Number(multiplierConfig?.rest_day_overtime_first_2h_rate) || 1.34
    : Number(multiplierConfig?.weekday_overtime_first_2h_rate)  || 1.34;
  const r2 = dayType === 'rest_day'
    ? Number(multiplierConfig?.rest_day_overtime_after_2h_rate) || 1.67
    : Number(multiplierConfig?.weekday_overtime_after_2h_rate)  || 1.67;

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
