// tests/salary-query-filter.test.js
//
// 對應頁面實作:public/salary.html buildMonthOptions 內 inline 版本。
// 抓 salary-period.html「📊 完整明細表」→ /salary.html?year=...&month=... 的 query parsing 行為。

import { describe, it, expect } from 'vitest';
import { parseFilterFromQuery } from '../lib/salary/query-filter.js';

describe('parseFilterFromQuery', () => {
  it('正常 year/month → { year, month, value }', () => {
    expect(parseFilterFromQuery('?year=2026&month=5')).toEqual({
      year: 2026, month: 5, value: '2026-05',
    });
  });

  it('month 補零 → 兩位數', () => {
    expect(parseFilterFromQuery('?year=2026&month=12').value).toBe('2026-12');
    expect(parseFilterFromQuery('?year=2026&month=1').value).toBe('2026-01');
  });

  it('沒帶 query → null', () => {
    expect(parseFilterFromQuery('')).toBeNull();
    expect(parseFilterFromQuery('?')).toBeNull();
    expect(parseFilterFromQuery(undefined)).toBeNull();
    expect(parseFilterFromQuery(null)).toBeNull();
  });

  it('缺 year 或 month → null', () => {
    expect(parseFilterFromQuery('?year=2026')).toBeNull();
    expect(parseFilterFromQuery('?month=5')).toBeNull();
  });

  it('month 超出 1~12 範圍 → null', () => {
    expect(parseFilterFromQuery('?year=2026&month=0')).toBeNull();
    expect(parseFilterFromQuery('?year=2026&month=13')).toBeNull();
    expect(parseFilterFromQuery('?year=2026&month=-1')).toBeNull();
  });

  it('year/month 是非 numeric → null', () => {
    expect(parseFilterFromQuery('?year=abc&month=5')).toBeNull();
    expect(parseFilterFromQuery('?year=2026&month=foo')).toBeNull();
  });

  it('額外的 query params 不影響', () => {
    expect(parseFilterFromQuery('?year=2026&month=5&extra=1').value).toBe('2026-05');
  });

  it('search 不含 leading ? 也接受', () => {
    expect(parseFilterFromQuery('year=2026&month=5').value).toBe('2026-05');
  });
});
