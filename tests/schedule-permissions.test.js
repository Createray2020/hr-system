import { describe, it, expect } from 'vitest';
import {
  canEmployeeEditSchedule,
  canManagerEditSchedule,
} from '../lib/schedule/permissions.js';

function period(overrides = {}) {
  return {
    id: 'p1',
    employee_id: 'E001',
    status: 'draft',
    period_start: '2026-05-01',
    period_end:   '2026-05-31',
    ...overrides,
  };
}

describe('canEmployeeEditSchedule', () => {
  it('draft + 自己 + 月份未開始 → ok', () => {
    expect(canEmployeeEditSchedule(period(), 'E001', '2026-04-26'))
      .toEqual({ ok: true });
  });

  it('別人的 period → NOT_OWN_PERIOD', () => {
    const r = canEmployeeEditSchedule(period(), 'E999', '2026-04-26');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('NOT_OWN_PERIOD');
  });

  it('已 submitted → NOT_DRAFT', () => {
    const r = canEmployeeEditSchedule(period({ status: 'submitted' }), 'E001', '2026-04-26');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('NOT_DRAFT');
  });

  it('approved → NOT_DRAFT', () => {
    const r = canEmployeeEditSchedule(period({ status: 'approved' }), 'E001', '2026-04-26');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('NOT_DRAFT');
  });

  it('月份開始當日 → PERIOD_STARTED', () => {
    const r = canEmployeeEditSchedule(period(), 'E001', '2026-05-01');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('PERIOD_STARTED');
  });

  it('月份開始之後 → PERIOD_STARTED', () => {
    const r = canEmployeeEditSchedule(period(), 'E001', '2026-05-15');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('PERIOD_STARTED');
  });

  it('null period → NO_PERIOD', () => {
    expect(canEmployeeEditSchedule(null, 'E001', '2026-04-26').reason).toBe('NO_PERIOD');
  });
});

describe('canManagerEditSchedule', () => {
  it('HR + approved + today 在 period 範圍外 → isLateChange=false', () => {
    const r = canManagerEditSchedule(
      period({ status: 'approved' }),
      { id: 'HR1', role: 'hr', is_manager: false },
      '2026-04-26', // period 是 5 月,4/26 在範圍外
    );
    expect(r.ok).toBe(true);
    expect(r.isLateChange).toBe(false);
  });

  it('HR 改 locked 期間內 → isLateChange=true', () => {
    const r = canManagerEditSchedule(
      period({ status: 'locked' }),
      { id: 'HR1', role: 'hr', is_manager: false },
      '2026-05-15',
    );
    expect(r.ok).toBe(true);
    expect(r.isLateChange).toBe(true);
  });

  it('admin 同 HR 待遇', () => {
    const r = canManagerEditSchedule(
      period({ status: 'locked' }),
      { id: 'A1', role: 'admin', is_manager: false },
      '2026-05-15',
    );
    expect(r.ok).toBe(true);
    expect(r.isLateChange).toBe(true);
  });

  it('部門主管 + 是該員工的主管 → ok', () => {
    const r = canManagerEditSchedule(
      period(),
      { id: 'M1', role: 'employee', is_manager: true, manages_employee_id: 'E001' },
      '2026-04-26',
    );
    expect(r.ok).toBe(true);
  });

  it('部門主管但不是該員工的主管 → NOT_MANAGER_OR_HR', () => {
    const r = canManagerEditSchedule(
      period(),
      { id: 'M1', role: 'employee', is_manager: true, manages_employee_id: 'OTHER' },
      '2026-04-26',
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('NOT_MANAGER_OR_HR');
  });

  it('普通員工不能改 → NOT_MANAGER_OR_HR', () => {
    const r = canManagerEditSchedule(
      period(),
      { id: 'E2', role: 'employee', is_manager: false },
      '2026-04-26',
    );
    expect(r.ok).toBe(false);
  });

  it('locked + today 在 period 範圍外 → isLateChange=false', () => {
    const r = canManagerEditSchedule(
      period({ status: 'locked' }),
      { id: 'HR1', role: 'hr' },
      '2026-06-15', // 已過 period_end
    );
    expect(r.ok).toBe(true);
    expect(r.isLateChange).toBe(false);
  });

  it('approved + today 在 period 內 → isLateChange=true（不限 locked）', () => {
    // approved 但月份已開始,cron 還沒跑到 locked,主管當天改仍算 late
    const r = canManagerEditSchedule(
      period({ status: 'approved' }),
      { id: 'HR1', role: 'hr' },
      '2026-05-15',
    );
    expect(r.ok).toBe(true);
    expect(r.isLateChange).toBe(true);
  });

  it('approved + today 在 period 範圍外 → isLateChange=false', () => {
    const r = canManagerEditSchedule(
      period({ status: 'approved' }),
      { id: 'HR1', role: 'hr' },
      '2026-04-26', // 月份還沒開始
    );
    expect(r.ok).toBe(true);
    expect(r.isLateChange).toBe(false);
  });
});
