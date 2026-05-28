// lib/schedule/period-coverage.js — F2 守門純函式
//
// 對應設計:tests/schedule-period-fully-scheduled.test.js
// 由 publish.js / approve.js 撈完該 period 的 schedules 後呼叫。
//
// 「該日有狀態」= 存在 ≥1 筆 schedules row(任意 shift_type / 含 ST003 休 / ST004 例假)。
// 例假 / 國定假日不自動豁免、必須有 row 才算已排。

/**
 * 'YYYY-MM-DD' 字串 + 1 天,用 UTC 避時區漂移、處理月底 / 閏年 / 跨年 rollover。
 *   2026-02-28 → 2026-03-01(非閏年)
 *   2024-02-28 → 2024-02-29(閏年)
 *   2024-02-29 → 2024-03-01
 *   2026-12-31 → 2027-01-01
 */
function nextDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  // Date.UTC 接 day+1,JS Date 會自動 rollover(d 超過該月日數 → 進下一月,跨年同理)
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  return next.toISOString().slice(0, 10);
}

/**
 * 檢查 period 涵蓋的每一天是否都有對應 schedules row。
 *
 * @param {{ period_start: string, period_end: string }} period
 *   period_start / period_end 是 'YYYY-MM-DD' 字串(DATE 欄位序列化形式)。
 *   只讀這兩個欄位、不依賴 status / employee_id(employee_id filter 由 caller 處理)。
 * @param {Array<{ work_date: string }>} schedules
 *   該員工該 period 範圍內所有 schedules row、只需 work_date 欄位。
 *   多 segment 同日 OK(只要存在即算該日已有狀態)。
 * @returns {{ ok: true } | { ok: false, missingDates: string[] }}
 *   ok=true:每天都有狀態
 *   ok=false:missingDates 含所有缺狀態的日期、'YYYY-MM-DD' 字串、時間升序
 */
export function isPeriodFullyScheduled(period, schedules) {
  // 寬鬆 input:缺欄位 / null 一律 ok:true,讓 caller 自己守(純函式不 throw)
  if (!period?.period_start || !period?.period_end) {
    return { ok: true };
  }
  // 無效範圍(start > end)視為空 range、trivially ok
  if (period.period_start > period.period_end) {
    return { ok: true };
  }

  // 收集 schedules 的 work_date 為 Set(多 segment 同日自動去重)
  const have = new Set();
  for (const s of (schedules || [])) {
    if (s?.work_date) have.add(s.work_date);
  }

  // 字串迭代 period_start ~ period_end(含兩端)、避時區
  const missingDates = [];
  let cur = period.period_start;
  while (cur <= period.period_end) {
    if (!have.has(cur)) missingDates.push(cur);
    cur = nextDate(cur);
  }

  if (missingDates.length === 0) return { ok: true };
  return { ok: false, missingDates };
}
