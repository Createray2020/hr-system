// lib/salary/query-filter.js — salary.html ?year=&month= query string 解析(純函式 + 可測)
//
// 用途:salary-period.html 「📊 完整明細表」按鈕 → window.open(`/salary.html?year=...&month=...`)。
//      salary.html 啟動時用本函式拿出 year/month、override f-month filter 預設值。
//
// public/salary.html 內有同步的 inline 版本(buildMonthOptions 內呼叫)、
// 必須跟此檔保持一致。本檔是 canonical source、vitest 抓行為。

/**
 * 從 URL search string 拿出 year + month、回 { year, month, value: 'YYYY-MM' } 或 null。
 *
 * @param {string} search - URL search string (含 leading '?' 或不含都行)、e.g. '?year=2026&month=5'
 * @returns {{ year: number, month: number, value: string } | null}
 *
 * 規則:
 *   - year 跟 month 都必須能 parse 成 integer
 *   - month 必須 1~12
 *   - 任一條件不過 → null(caller 走 default 行為,即「最近月」)
 */
export function parseFilterFromQuery(search) {
  const params = new URLSearchParams(search || '');
  const year = parseInt(params.get('year'), 10);
  const month = parseInt(params.get('month'), 10);
  if (!Number.isInteger(year) || !Number.isInteger(month)) return null;
  if (month < 1 || month > 12) return null;
  return {
    year,
    month,
    value: `${year}-${String(month).padStart(2, '0')}`,
  };
}
