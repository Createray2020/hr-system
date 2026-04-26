import { describe, it, expect } from 'vitest';
import {
  canTransition, OVERTIME_STATES, OVERTIME_ACTIONS,
} from '../lib/overtime/request-state.js';

const employee = { is_employee_self: true };
const manager  = { is_manager: true };
const ceo      = { is_ceo: true };

describe('canTransition: 6 條合法 transition (規範 §9.3)', () => {
  it('1. pending + manager_approve (!is_over_limit) → approved', () => {
    const r = canTransition('pending', 'manager_approve', manager, { is_over_limit: false });
    expect(r).toEqual({ ok: true, nextState: 'approved' });
  });

  it('2. pending + manager_approve (is_over_limit) → pending_ceo', () => {
    const r = canTransition('pending', 'manager_approve', manager, { is_over_limit: true });
    expect(r).toEqual({ ok: true, nextState: 'pending_ceo' });
  });

  it('3. pending + manager_reject → rejected', () => {
    const r = canTransition('pending', 'manager_reject', manager, {});
    expect(r).toEqual({ ok: true, nextState: 'rejected' });
  });

  it('4. pending + cancel (is_employee_self) → cancelled', () => {
    const r = canTransition('pending', 'cancel', employee, {});
    expect(r).toEqual({ ok: true, nextState: 'cancelled' });
  });

  it('5. pending_ceo + ceo_approve → approved', () => {
    const r = canTransition('pending_ceo', 'ceo_approve', ceo, {});
    expect(r).toEqual({ ok: true, nextState: 'approved' });
  });

  it('6. pending_ceo + ceo_reject → rejected', () => {
    const r = canTransition('pending_ceo', 'ceo_reject', ceo, {});
    expect(r).toEqual({ ok: true, nextState: 'rejected' });
  });
});

describe('canTransition: 非法組合', () => {
  it('未知 state', () => {
    expect(canTransition('foo', 'manager_approve', manager, {}).ok).toBe(false);
  });
  it('未知 action', () => {
    expect(canTransition('pending', 'foo', manager, {}).ok).toBe(false);
  });
  it('terminal state(approved/rejected/cancelled) 不再 transition', () => {
    for (const s of ['approved', 'rejected', 'cancelled']) {
      const r = canTransition(s, 'cancel', employee, {});
      expect(r.ok).toBe(false);
      expect(r.reason).toBe('TERMINAL_STATE');
    }
  });
  it('pending + manager_approve 但 actor 不是 manager → FORBIDDEN_ACTOR', () => {
    const r = canTransition('pending', 'manager_approve', employee, {});
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/FORBIDDEN_ACTOR/);
  });
  it('pending + cancel 但 actor 不是 employee → FORBIDDEN_ACTOR', () => {
    const r = canTransition('pending', 'cancel', manager, {});
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/FORBIDDEN_ACTOR/);
  });
  it('pending + ceo_approve 是非法(ceo 不在 pending 階段審)', () => {
    const r = canTransition('pending', 'ceo_approve', ceo, {});
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('ILLEGAL_TRANSITION');
  });
  it('pending_ceo + manager_approve 非法(已過主管階段)', () => {
    const r = canTransition('pending_ceo', 'manager_approve', manager, {});
    expect(r.ok).toBe(false);
  });
  it('pending_ceo + cancel 非法(只 pending 才能員工撤回)', () => {
    const r = canTransition('pending_ceo', 'cancel', employee, {});
    expect(r.ok).toBe(false);
  });
  it('pending_ceo + ceo_approve 但 actor 不是 ceo → FORBIDDEN_ACTOR', () => {
    const r = canTransition('pending_ceo', 'ceo_approve', manager, {});
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/FORBIDDEN_ACTOR/);
  });
  it('null actor 拒絕', () => {
    const r = canTransition('pending', 'manager_approve', null, {});
    expect(r.ok).toBe(false);
  });
});

describe('export 常數', () => {
  it('5 個 states', () => {
    expect(OVERTIME_STATES).toEqual(['pending', 'pending_ceo', 'approved', 'rejected', 'cancelled']);
  });
  it('5 個 actions', () => {
    expect(OVERTIME_ACTIONS).toEqual(['manager_approve', 'manager_reject', 'ceo_approve', 'ceo_reject', 'cancel']);
  });
});
