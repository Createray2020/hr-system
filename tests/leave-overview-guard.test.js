// tests/leave-overview-guard.test.js
// 抓 lib/leave/overview-guard.js shouldBlockQuantityEdit 純函式行為

import { describe, it, expect } from 'vitest';
import { shouldBlockQuantityEdit, BLOCKED_BY_BALANCE_FIELDS } from '../lib/leave/overview-guard.js';

describe('shouldBlockQuantityEdit', () => {
  it('has_balance=true + patch 含 days → 擋(返回 true)', () => {
    expect(shouldBlockQuantityEdit({ hasBalance: true, patchFields: ['days'] })).toBe(true);
  });

  it('has_balance=true + patch 含 hours → 擋', () => {
    expect(shouldBlockQuantityEdit({ hasBalance: true, patchFields: ['hours'] })).toBe(true);
  });

  it('has_balance=true + patch 含 finalized_hours → 擋', () => {
    expect(shouldBlockQuantityEdit({ hasBalance: true, patchFields: ['finalized_hours'] })).toBe(true);
  });

  it('has_balance=true + patch 多欄含 days → 擋', () => {
    expect(shouldBlockQuantityEdit({ hasBalance: true, patchFields: ['leave_type', 'days', 'hours'] })).toBe(true);
  });

  it('has_balance=true + patch 只含 leave_type → 放行(改假別不擋)', () => {
    expect(shouldBlockQuantityEdit({ hasBalance: true, patchFields: ['leave_type'] })).toBe(false);
  });

  it('has_balance=true + patch 空陣列 → 放行', () => {
    expect(shouldBlockQuantityEdit({ hasBalance: true, patchFields: [] })).toBe(false);
  });

  it('has_balance=false + patch 含 days → 放行(非餘額假別不擋)', () => {
    expect(shouldBlockQuantityEdit({ hasBalance: false, patchFields: ['days'] })).toBe(false);
  });

  it('has_balance=false + patch 含 hours / finalized_hours / 多欄 → 放行', () => {
    expect(shouldBlockQuantityEdit({ hasBalance: false, patchFields: ['hours'] })).toBe(false);
    expect(shouldBlockQuantityEdit({ hasBalance: false, patchFields: ['finalized_hours'] })).toBe(false);
    expect(shouldBlockQuantityEdit({ hasBalance: false, patchFields: ['days','hours','finalized_hours','leave_type'] })).toBe(false);
  });

  it('hasBalance null / undefined 視為 falsy、放行', () => {
    expect(shouldBlockQuantityEdit({ hasBalance: null,      patchFields: ['days'] })).toBe(false);
    expect(shouldBlockQuantityEdit({ hasBalance: undefined, patchFields: ['days'] })).toBe(false);
  });

  it('patchFields 非陣列 → 放行(防呆)', () => {
    expect(shouldBlockQuantityEdit({ hasBalance: true, patchFields: null })).toBe(false);
    expect(shouldBlockQuantityEdit({ hasBalance: true, patchFields: undefined })).toBe(false);
  });

  it('BLOCKED_BY_BALANCE_FIELDS 對齊 3 個量化欄位', () => {
    expect(BLOCKED_BY_BALANCE_FIELDS).toEqual(['days', 'hours', 'finalized_hours']);
  });
});
