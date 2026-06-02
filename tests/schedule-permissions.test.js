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
    wish_deadline: null,  // C6:預設 null (不擋)、case override 補
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

  // ===== C6：wish_deadline check =====

  it('C6: 員工 + draft + wish_deadline 已過 → WISH_DEADLINE_PASSED', () => {
    const r = canEmployeeEditSchedule(
      period({ wish_deadline: '2026-04-25' }),
      'E001',
      '2026-04-26',  // 過了截止日
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('WISH_DEADLINE_PASSED');
  });

  it('C6: 員工 + draft + wish_deadline 當天 → ok（截止日當天還能改）', () => {
    const r = canEmployeeEditSchedule(
      period({ wish_deadline: '2026-04-25' }),
      'E001',
      '2026-04-25',  // 截止日當天
    );
    expect(r.ok).toBe(true);
  });

  it('C6: 員工 + draft + wish_deadline NULL → ok（向後相容舊 period）', () => {
    const r = canEmployeeEditSchedule(
      period({ wish_deadline: null }),
      'E001',
      '2026-04-26',
    );
    expect(r.ok).toBe(true);
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

  it('部門主管 + 同部門 → ok', () => {
    const r = canManagerEditSchedule(
      period(),
      { id: 'M1', role: 'employee', is_manager: true, in_same_dept: true },
      '2026-04-26',
    );
    expect(r.ok).toBe(true);
  });

  it('部門主管但不同部門 → NOT_MANAGER_OR_HR', () => {
    const r = canManagerEditSchedule(
      period(),
      { id: 'M1', role: 'employee', is_manager: true, in_same_dept: false },
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

  // ===== C5：公告後主管不能改今天 + 過去 =====

  it('C5: 主管 + approved + work_date 過去 → 403 MANAGER_LATE_DENIED', () => {
    const r = canManagerEditSchedule(
      period({ status: 'approved' }),
      { id: 'M1', role: 'employee', is_manager: true, in_same_dept: true },
      '2026-04-26',
      '2026-04-20',  // 過去
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('MANAGER_LATE_DENIED');
  });

  it('C5: 主管 + approved + work_date today → 403 MANAGER_LATE_DENIED', () => {
    const r = canManagerEditSchedule(
      period({ status: 'approved' }),
      { id: 'M1', role: 'employee', is_manager: true, in_same_dept: true },
      '2026-04-26',
      '2026-04-26',  // today
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('MANAGER_LATE_DENIED');
  });

  it('C5: 主管 + approved + work_date 未來 → ok', () => {
    const r = canManagerEditSchedule(
      period({ status: 'approved' }),
      { id: 'M1', role: 'employee', is_manager: true, in_same_dept: true },
      '2026-04-26',
      '2026-04-27',  // tomorrow
    );
    expect(r.ok).toBe(true);
  });

  it('C5: 主管 + locked + work_date 過去 → 403', () => {
    const r = canManagerEditSchedule(
      period({ status: 'locked' }),
      { id: 'M1', role: 'employee', is_manager: true, in_same_dept: true },
      '2026-04-26',
      '2026-04-20',
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('MANAGER_LATE_DENIED');
  });

  it('C5: 主管 + locked + work_date today → 403', () => {
    const r = canManagerEditSchedule(
      period({ status: 'locked' }),
      { id: 'M1', role: 'employee', is_manager: true, in_same_dept: true },
      '2026-04-26',
      '2026-04-26',
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('MANAGER_LATE_DENIED');
  });

  it('C5: HR + locked + work_date 過去 → ok（不限）', () => {
    const r = canManagerEditSchedule(
      period({ status: 'locked' }),
      { id: 'HR1', role: 'hr', is_manager: false },
      '2026-04-26',
      '2026-04-20',
    );
    expect(r.ok).toBe(true);
  });

  // 2026-06 fail-closed:workDate 缺漏不再 bypass
  it('C5 fail-closed: 主管 + published + workDate=undefined → MANAGER_LATE_DENIED', () => {
    const r = canManagerEditSchedule(
      period({ status: 'published' }),
      { id: 'M1', role: 'employee', is_manager: true, in_same_dept: true },
      '2026-04-26',
      undefined,  // 不傳 workDate
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('MANAGER_LATE_DENIED');
  });

  it('C5 fail-closed: 主管 + locked + workDate=null → MANAGER_LATE_DENIED', () => {
    const r = canManagerEditSchedule(
      period({ status: 'locked' }),
      { id: 'M1', role: 'employee', is_manager: true, in_same_dept: true },
      '2026-04-26',
      null,
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('MANAGER_LATE_DENIED');
  });

  it('C5 fail-closed: HR + published + workDate 缺 → 仍 ok(HR bypass)', () => {
    const r = canManagerEditSchedule(
      period({ status: 'published' }),
      { id: 'HR1', role: 'hr', is_manager: false },
      '2026-04-26',
      undefined,
    );
    expect(r.ok).toBe(true);
  });

  it('C5 fail-closed: 主管 + draft + workDate 缺 → ok(draft 不受 isPublished 限制)', () => {
    const r = canManagerEditSchedule(
      period({ status: 'draft' }),
      { id: 'M1', role: 'employee', is_manager: true, in_same_dept: true },
      '2026-04-26',
      undefined,
    );
    expect(r.ok).toBe(true);
  });
});
