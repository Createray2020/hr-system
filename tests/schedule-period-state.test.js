import { describe, it, expect } from 'vitest';
import {
  canTransition,
  SCHEDULE_PERIOD_STATES,
  SCHEDULE_PERIOD_ACTIONS,
} from '../lib/schedule/period-state.js';

const employee  = { is_employee_self: true };
const manager   = { is_manager: true };
const sysActor  = { is_system: true };
const otherEmp  = {};

describe('canTransition: 6 條合法 transition', () => {
  const cases = [
    { from: 'draft',     action: 'submit',  actor: employee, to: 'submitted' },
    { from: 'submitted', action: 'approve', actor: manager,  to: 'approved'  },
    { from: 'submitted', action: 'adjust',  actor: manager,  to: 'submitted' },
    { from: 'approved',  action: 'adjust',  actor: manager,  to: 'approved'  },
    { from: 'approved',  action: 'lock',    actor: sysActor, to: 'locked'    },
    { from: 'locked',    action: 'adjust',  actor: manager,  to: 'locked'    },
  ];
  for (const c of cases) {
    it(`${c.from} + ${c.action} → ${c.to}`, () => {
      const r = canTransition(c.from, c.action, c.actor);
      expect(r.ok).toBe(true);
      expect(r.nextState).toBe(c.to);
    });
  }
});

describe('canTransition: 非法 transition 全擋', () => {
  it('未知 state', () => {
    expect(canTransition('whatever', 'submit', employee)).toEqual({
      ok: false, reason: 'UNKNOWN_STATE',
    });
  });

  it('未知 action', () => {
    expect(canTransition('draft', 'foo', employee)).toEqual({
      ok: false, reason: 'UNKNOWN_ACTION',
    });
  });

  it('draft + approve 是非法（員工 draft 還沒 submit）', () => {
    const r = canTransition('draft', 'approve', manager);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('ILLEGAL_TRANSITION');
  });

  it('locked + lock 是非法（已 locked 不能再 lock）', () => {
    const r = canTransition('locked', 'lock', sysActor);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('ILLEGAL_TRANSITION');
  });

  it('draft + submit 但 actor 不是員工本人 → FORBIDDEN_ACTOR', () => {
    const r = canTransition('draft', 'submit', otherEmp);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/FORBIDDEN_ACTOR/);
  });

  it('submitted + approve 但 actor 不是 manager → FORBIDDEN_ACTOR', () => {
    const r = canTransition('submitted', 'approve', employee);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/FORBIDDEN_ACTOR/);
  });

  it('approved + lock 但 actor 不是 system → FORBIDDEN_ACTOR', () => {
    const r = canTransition('approved', 'lock', manager);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/FORBIDDEN_ACTOR/);
  });

  it('null actor 拒絕', () => {
    const r = canTransition('draft', 'submit', null);
    expect(r.ok).toBe(false);
  });
});

describe('export 常數正確', () => {
  it('states 5 個（C12-2 加 published）', () => {
    expect(SCHEDULE_PERIOD_STATES).toEqual(['draft', 'submitted', 'approved', 'published', 'locked']);
  });
  it('actions 5 個（C12-2 加 publish）', () => {
    expect(SCHEDULE_PERIOD_ACTIONS).toEqual(['submit', 'approve', 'publish', 'adjust', 'lock']);
  });
});

describe('canTransition: C12-2 publish flow', () => {
  it('approved + publish (manager) → published', () => {
    const r = canTransition('approved', 'publish', manager);
    expect(r.ok).toBe(true);
    expect(r.nextState).toBe('published');
  });
  it('published + adjust (manager) → published', () => {
    const r = canTransition('published', 'adjust', manager);
    expect(r.ok).toBe(true);
    expect(r.nextState).toBe('published');
  });
  it('published + lock (system) → locked', () => {
    const r = canTransition('published', 'lock', sysActor);
    expect(r.ok).toBe(true);
    expect(r.nextState).toBe('locked');
  });
  it('submitted + publish 是非法（必須先 approve）', () => {
    const r = canTransition('submitted', 'publish', manager);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('ILLEGAL_TRANSITION');
  });
});
