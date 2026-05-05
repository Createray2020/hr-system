import { describe, it, expect } from 'vitest';
import {
  getInitialStage,
  canReview,
  transitionApprove,
  transitionReject,
  canCancel,
  canArchive,
  transitionArchive,
  canOverride,
} from '../lib/leave/stages.js';

describe('getInitialStage', () => {
  it('一般員工 → pending_mgr', () => {
    expect(getInitialStage({ id: 'E1', role: 'employee', is_manager: false })).toBe('pending_mgr');
  });

  it('is_manager=true → pending_ceo', () => {
    expect(getInitialStage({ id: 'M1', role: 'employee', is_manager: true })).toBe('pending_ceo');
  });

  it('role=ceo → approved(自批)', () => {
    expect(getInitialStage({ id: 'C1', role: 'ceo', is_manager: true })).toBe('approved');
  });

  it('role=chairman → approved', () => {
    expect(getInitialStage({ id: 'CH1', role: 'chairman' })).toBe('approved');
  });

  it('null employee → throw', () => {
    expect(() => getInitialStage(null)).toThrow(/employee/);
  });
});

describe('canReview', () => {
  const empReq = (over = {}) => ({
    employee_id: 'E1',
    employee_manager_id: 'M1',
    status: 'pending_mgr',
    ...over,
  });

  it('直屬主管在 pending_mgr → true', () => {
    expect(canReview({ id: 'M1', role: 'employee', is_manager: true }, empReq())).toBe(true);
  });

  it('別部門主管在 pending_mgr → false', () => {
    expect(canReview({ id: 'M2', role: 'employee', is_manager: true }, empReq())).toBe(false);
  });

  it('HR 在 pending_mgr → true(elevated 往下批)', () => {
    expect(canReview({ id: 'HR1', role: 'hr' }, empReq())).toBe(true);
  });

  it('admin 在 pending_mgr → true', () => {
    expect(canReview({ id: 'A1', role: 'admin' }, empReq())).toBe(true);
  });

  it('CEO 在 pending_ceo → true', () => {
    expect(canReview({ id: 'C1', role: 'ceo' }, empReq({ status: 'pending_ceo' }))).toBe(true);
  });

  it('CEO 在 pending_mgr → true(高層也能往下批)', () => {
    expect(canReview({ id: 'C1', role: 'ceo' }, empReq())).toBe(true);
  });

  it('chairman 在 pending_ceo → true', () => {
    expect(canReview({ id: 'CH1', role: 'chairman' }, empReq({ status: 'pending_ceo' }))).toBe(true);
  });

  it('一般員工 → false', () => {
    expect(canReview({ id: 'E2', role: 'employee' }, empReq())).toBe(false);
  });

  it('直屬主管在 pending_ceo → false(只有 elevated 能批)', () => {
    expect(canReview({ id: 'M1', role: 'employee', is_manager: true }, empReq({ status: 'pending_ceo' }))).toBe(false);
  });

  it('已 approved 的 → false(非 pending_* 不能批)', () => {
    expect(canReview({ id: 'HR1', role: 'hr' }, empReq({ status: 'approved' }))).toBe(false);
  });

  it('已 archived 的 → false', () => {
    expect(canReview({ id: 'HR1', role: 'hr' }, empReq({ status: 'archived' }))).toBe(false);
  });

  it('null reviewer / request → false', () => {
    expect(canReview(null, empReq())).toBe(false);
    expect(canReview({ id: 'M1', role: 'employee', is_manager: true }, null)).toBe(false);
  });
});

describe('transitionApprove', () => {
  it('pending_mgr → pending_ceo', () => {
    expect(transitionApprove('pending_mgr')).toBe('pending_ceo');
  });

  it('pending_ceo → approved', () => {
    expect(transitionApprove('pending_ceo')).toBe('approved');
  });

  it('approved → throw(已 approved 不能再批)', () => {
    expect(() => transitionApprove('approved')).toThrow(/cannot approve/);
  });

  it('rejected → throw', () => {
    expect(() => transitionApprove('rejected')).toThrow(/cannot approve/);
  });

  it('cancelled → throw', () => {
    expect(() => transitionApprove('cancelled')).toThrow(/cannot approve/);
  });
});

describe('transitionReject', () => {
  it('pending_mgr → rejected', () => {
    expect(transitionReject('pending_mgr')).toBe('rejected');
  });

  it('pending_ceo → rejected', () => {
    expect(transitionReject('pending_ceo')).toBe('rejected');
  });

  it('approved → throw', () => {
    expect(() => transitionReject('approved')).toThrow(/cannot reject/);
  });
});

describe('canCancel', () => {
  it('員工自己在 pending_mgr → true', () => {
    expect(canCancel({ id: 'E1' }, { employee_id: 'E1', status: 'pending_mgr' })).toBe(true);
  });

  it('員工自己在 pending_ceo → true', () => {
    expect(canCancel({ id: 'E1' }, { employee_id: 'E1', status: 'pending_ceo' })).toBe(true);
  });

  it('員工自己在 approved → false(已批不能撤、要走 refund 流程)', () => {
    expect(canCancel({ id: 'E1' }, { employee_id: 'E1', status: 'approved' })).toBe(false);
  });

  it('員工自己在 rejected → false', () => {
    expect(canCancel({ id: 'E1' }, { employee_id: 'E1', status: 'rejected' })).toBe(false);
  });

  it('別人不能撤本人的假', () => {
    expect(canCancel({ id: 'E2' }, { employee_id: 'E1', status: 'pending_mgr' })).toBe(false);
  });
});

describe('canArchive', () => {
  it('HR 在 approved → true', () => {
    expect(canArchive({ role: 'hr' }, { status: 'approved' })).toBe(true);
  });

  it('admin 在 approved → true', () => {
    expect(canArchive({ role: 'admin' }, { status: 'approved' })).toBe(true);
  });

  it('HR 在 archived → false(已歸檔不能再 archive)', () => {
    expect(canArchive({ role: 'hr' }, { status: 'archived' })).toBe(false);
  });

  it('HR 在 pending_mgr → false(尚未 approve 不能跳級歸檔)', () => {
    expect(canArchive({ role: 'hr' }, { status: 'pending_mgr' })).toBe(false);
  });

  it('一般員工在 approved → false', () => {
    expect(canArchive({ role: 'employee' }, { status: 'approved' })).toBe(false);
  });

  it('CEO 在 approved → false(歸檔是 HR 工作)', () => {
    expect(canArchive({ role: 'ceo' }, { status: 'approved' })).toBe(false);
  });
});

describe('transitionArchive', () => {
  it('approved → archived', () => {
    expect(transitionArchive('approved')).toBe('archived');
  });

  it('pending_mgr → throw', () => {
    expect(() => transitionArchive('pending_mgr')).toThrow(/cannot archive/);
  });

  it('archived → throw', () => {
    expect(() => transitionArchive('archived')).toThrow(/cannot archive/);
  });
});

describe('canOverride', () => {
  it('HR → true', () => {
    expect(canOverride({ role: 'hr' })).toBe(true);
  });

  it('CEO → true', () => {
    expect(canOverride({ role: 'ceo' })).toBe(true);
  });

  it('chairman → true', () => {
    expect(canOverride({ role: 'chairman' })).toBe(true);
  });

  it('admin → true', () => {
    expect(canOverride({ role: 'admin' })).toBe(true);
  });

  it('is_manager=true(role=employee)→ true', () => {
    expect(canOverride({ role: 'employee', is_manager: true })).toBe(true);
  });

  it('一般員工 → false', () => {
    expect(canOverride({ role: 'employee', is_manager: false })).toBe(false);
  });

  it('null actor → false', () => {
    expect(canOverride(null)).toBe(false);
  });
});
