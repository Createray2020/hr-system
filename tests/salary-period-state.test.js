import { describe, it, expect } from 'vitest';
import {
  STATUSES, ALLOWED_TRANSITIONS,
  isValidStatus, canTransition, isFinalState,
  getAllowedNextStates, getRolesForTransition,
  isRoleAllowedForTransition, canExecuteTransition,
} from '../lib/salary/period-state.js';

describe('STATUSES', () => {
  it('含 6 狀態、跟 schema CHECK 對齊', () => {
    expect(STATUSES).toEqual([
      'draft','calculating','pending_review','approved','paid','locked',
    ]);
  });
});

describe('isValidStatus', () => {
  it('合法 → true', () => {
    expect(isValidStatus('draft')).toBe(true);
    expect(isValidStatus('locked')).toBe(true);
    expect(isValidStatus('pending_review')).toBe(true);
  });
  it('非法 → false', () => {
    expect(isValidStatus('foo')).toBe(false);
    expect(isValidStatus('')).toBe(false);
    expect(isValidStatus(null)).toBe(false);
    expect(isValidStatus(undefined)).toBe(false);
  });
});

describe('canTransition', () => {
  it('正常順流轉合法', () => {
    expect(canTransition('draft', 'calculating')).toBe(true);
    expect(canTransition('calculating', 'pending_review')).toBe(true);
    expect(canTransition('pending_review', 'approved')).toBe(true);
    expect(canTransition('approved', 'paid')).toBe(true);
    expect(canTransition('paid', 'locked')).toBe(true);
  });

  it('退回流轉合法', () => {
    expect(canTransition('calculating', 'draft')).toBe(true);
    expect(canTransition('pending_review', 'calculating')).toBe(true);
    expect(canTransition('approved', 'calculating')).toBe(true);
  });

  it('跳階非法', () => {
    expect(canTransition('draft', 'paid')).toBe(false);
    expect(canTransition('draft', 'approved')).toBe(false);
    expect(canTransition('calculating', 'paid')).toBe(false);
  });

  it('反向流轉(paid → 早期狀態)非法', () => {
    expect(canTransition('paid', 'draft')).toBe(false);
    expect(canTransition('paid', 'pending_review')).toBe(false);
    expect(canTransition('paid', 'approved')).toBe(false);
  });

  it('locked 終態、不可轉任何狀態', () => {
    for (const s of STATUSES) {
      expect(canTransition('locked', s)).toBe(false);
    }
  });

  it('非法 status → false', () => {
    expect(canTransition('foo', 'draft')).toBe(false);
    expect(canTransition('draft', 'bar')).toBe(false);
    expect(canTransition(null, 'draft')).toBe(false);
  });
});

describe('isFinalState', () => {
  it('locked 是終態', () => {
    expect(isFinalState('locked')).toBe(true);
  });
  it('其他都不是終態', () => {
    expect(isFinalState('draft')).toBe(false);
    expect(isFinalState('paid')).toBe(false);
    expect(isFinalState('approved')).toBe(false);
  });
  it('非法 status 不是終態', () => {
    expect(isFinalState('foo')).toBe(false);
  });
});

describe('getAllowedNextStates', () => {
  it('每個 status 的下個合法狀態', () => {
    expect(getAllowedNextStates('draft')).toEqual(['calculating']);
    expect(getAllowedNextStates('calculating')).toEqual(['draft','pending_review']);
    expect(getAllowedNextStates('pending_review')).toEqual(['calculating','approved']);
    expect(getAllowedNextStates('approved')).toEqual(['calculating','paid']);
    expect(getAllowedNextStates('paid')).toEqual(['locked']);
    expect(getAllowedNextStates('locked')).toEqual([]);
  });
  it('非法 status → []', () => {
    expect(getAllowedNextStates('foo')).toEqual([]);
  });
});

describe('getRolesForTransition', () => {
  it('HR 動作對 4 角色開放', () => {
    expect(getRolesForTransition('draft', 'calculating'))
      .toEqual(['hr','admin','ceo','chairman']);
    expect(getRolesForTransition('approved', 'paid'))
      .toEqual(['hr','admin','ceo','chairman']);
  });

  it('approve 限老闆', () => {
    expect(getRolesForTransition('pending_review', 'approved'))
      .toEqual(['ceo','chairman']);
  });

  it('approved → calculating 退回限老闆', () => {
    expect(getRolesForTransition('approved', 'calculating'))
      .toEqual(['ceo','chairman']);
  });

  it('lock 限 admin / cron', () => {
    expect(getRolesForTransition('paid', 'locked'))
      .toEqual(['admin','cron']);
  });

  it('非法 transition → []', () => {
    expect(getRolesForTransition('draft', 'paid')).toEqual([]);
    expect(getRolesForTransition('locked', 'draft')).toEqual([]);
  });
});

describe('isRoleAllowedForTransition', () => {
  it('CEO 可 approve', () => {
    expect(isRoleAllowedForTransition('ceo', 'pending_review', 'approved')).toBe(true);
    expect(isRoleAllowedForTransition('chairman', 'pending_review', 'approved')).toBe(true);
  });

  it('HR 不可 approve、不可退回', () => {
    expect(isRoleAllowedForTransition('hr', 'pending_review', 'approved')).toBe(false);
    expect(isRoleAllowedForTransition('hr', 'approved', 'calculating')).toBe(false);
  });

  it('一般員工不可任何 transition', () => {
    expect(isRoleAllowedForTransition('employee', 'draft', 'calculating')).toBe(false);
  });

  it('cron 可 lock', () => {
    expect(isRoleAllowedForTransition('cron', 'paid', 'locked')).toBe(true);
  });

  it('admin 可 lock', () => {
    expect(isRoleAllowedForTransition('admin', 'paid', 'locked')).toBe(true);
  });

  it('CEO 不能 lock(限 admin/cron)', () => {
    expect(isRoleAllowedForTransition('ceo', 'paid', 'locked')).toBe(false);
  });
});

describe('canExecuteTransition', () => {
  it('合法 transition + 角色 OK → ok:true', () => {
    expect(canExecuteTransition({
      callerRole: 'ceo', from: 'pending_review', to: 'approved'
    })).toEqual({ ok: true });
    expect(canExecuteTransition({
      callerRole: 'hr', from: 'draft', to: 'calculating'
    })).toEqual({ ok: true });
  });

  it('合法 transition + 角色不對 → FORBIDDEN_ROLE', () => {
    expect(canExecuteTransition({
      callerRole: 'employee', from: 'pending_review', to: 'approved'
    })).toEqual({ ok: false, reason: 'FORBIDDEN_ROLE' });
    expect(canExecuteTransition({
      callerRole: 'hr', from: 'pending_review', to: 'approved'
    })).toEqual({ ok: false, reason: 'FORBIDDEN_ROLE' });
  });

  it('非法 transition → INVALID_TRANSITION(不檢查角色)', () => {
    expect(canExecuteTransition({
      callerRole: 'ceo', from: 'draft', to: 'paid'
    })).toEqual({ ok: false, reason: 'INVALID_TRANSITION' });
  });
});
