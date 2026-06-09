// tests/recompute-guard.test.js
// 抓 lib/salary/recompute-guard.js 純函式行為(Phase 3C)

import { describe, it, expect } from 'vitest';
import {
  isManuallyLocked, isStatusFrozen, shouldSkipBatchRecalc, FROZEN_STATUS_VALUES,
} from '../lib/salary/recompute-guard.js';

// ─── isManuallyLocked ────────────────────────────────────────
describe('isManuallyLocked', () => {
  it('manual_lock=true → true', () => {
    expect(isManuallyLocked({ manual_lock: true })).toBe(true);
  });

  it('manual_lock=false → false', () => {
    expect(isManuallyLocked({ manual_lock: false })).toBe(false);
  });

  it('manual_lock=null / undefined → false', () => {
    expect(isManuallyLocked({ manual_lock: null })).toBe(false);
    expect(isManuallyLocked({})).toBe(false);
  });

  it('existing=null / undefined → false', () => {
    expect(isManuallyLocked(null)).toBe(false);
    expect(isManuallyLocked(undefined)).toBe(false);
  });

  it('truthy 非 true 值(字串 "true" / 1)→ false(嚴格 === true)', () => {
    expect(isManuallyLocked({ manual_lock: 'true' })).toBe(false);
    expect(isManuallyLocked({ manual_lock: 1 })).toBe(false);
  });
});

// ─── isStatusFrozen ──────────────────────────────────────────
describe('isStatusFrozen', () => {
  it('status=paid → true', () => {
    expect(isStatusFrozen({ status: 'paid' })).toBe(true);
  });

  it('status=locked → true', () => {
    expect(isStatusFrozen({ status: 'locked' })).toBe(true);
  });

  it.each(['draft', 'calculating', 'pending_review', 'confirmed', 'approved'])(
    'status=%s → false',
    (s) => {
      expect(isStatusFrozen({ status: s })).toBe(false);
    },
  );

  it('existing=null → false', () => {
    expect(isStatusFrozen(null)).toBe(false);
  });

  it('FROZEN_STATUS_VALUES exports paid + locked', () => {
    expect(FROZEN_STATUS_VALUES.sort()).toEqual(['locked', 'paid']);
  });
});

// ─── shouldSkipBatchRecalc ───────────────────────────────────
describe('shouldSkipBatchRecalc', () => {
  it('existing=null(新 row、calculator 第一次跑)→ skip=false', () => {
    expect(shouldSkipBatchRecalc({ existing: null })).toEqual({ skip: false, reason: null });
  });

  it('manual_lock=true 任何 status → skip=true, reason=manual_lock', () => {
    expect(shouldSkipBatchRecalc({ existing: { manual_lock: true, status: 'draft' } }))
      .toEqual({ skip: true, reason: 'manual_lock' });
    expect(shouldSkipBatchRecalc({ existing: { manual_lock: true, status: 'paid' } }))
      .toEqual({ skip: true, reason: 'manual_lock' });
  });

  it('status=paid + manual_lock=false → skip=true, reason=paid', () => {
    expect(shouldSkipBatchRecalc({ existing: { manual_lock: false, status: 'paid' } }))
      .toEqual({ skip: true, reason: 'paid' });
  });

  it('status=locked + manual_lock=false → skip=true, reason=locked', () => {
    expect(shouldSkipBatchRecalc({ existing: { manual_lock: false, status: 'locked' } }))
      .toEqual({ skip: true, reason: 'locked' });
  });

  it.each(['draft', 'calculating', 'pending_review', 'confirmed', 'approved'])(
    '一般 row status=%s + manual_lock=false → skip=false',
    (s) => {
      expect(shouldSkipBatchRecalc({ existing: { manual_lock: false, status: s } }))
        .toEqual({ skip: false, reason: null });
    },
  );

  it('force=true 任何 row → skip=false(escape hatch、目前 caller 不傳)', () => {
    expect(shouldSkipBatchRecalc({ existing: { manual_lock: true, status: 'locked' }, force: true }))
      .toEqual({ skip: false, reason: null });
  });

  it('優先序:manual_lock > status(同時觸發只回 manual_lock)', () => {
    const r = shouldSkipBatchRecalc({ existing: { manual_lock: true, status: 'locked' } });
    expect(r).toEqual({ skip: true, reason: 'manual_lock' });
  });

  it('沒帶 args / 沒帶 existing → skip=false(防呆)', () => {
    expect(shouldSkipBatchRecalc()).toEqual({ skip: false, reason: null });
    expect(shouldSkipBatchRecalc({})).toEqual({ skip: false, reason: null });
  });
});
