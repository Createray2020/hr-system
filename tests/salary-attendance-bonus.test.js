import { describe, it, expect, vi } from 'vitest';
import { applyAttendanceBonus } from '../lib/salary/attendance-bonus.js';

function makeRepo(over = {}) {
  return {
    // calculateAttendanceBonusDeduction 需要的 method
    findPenaltyRecordsByEmployeeMonth: vi.fn(async () => []),
    findApprovedAttendanceBonusLeaves: vi.fn(async () => []),
    findAbsentDaysByEmployeeMonth: vi.fn(async () => 0),
    getAbsentDayDeductionRate: vi.fn(async () => 0),
    ...over,
  };
}

describe('applyAttendanceBonus', () => {
  it('base=0(員工不領全勤)→ skip,actual=0', async () => {
    const r = await applyAttendanceBonus(makeRepo(), { id:'E001', attendance_bonus: 0 }, {
      employee_id: 'E001', year: 2026, month: 4,
    });
    expect(r).toMatchObject({ base: 0, deduction_rate: 0, actual: 0 });
  });

  it('base=2000、無扣 → actual=2000', async () => {
    const r = await applyAttendanceBonus(makeRepo(), { id:'E001', attendance_bonus: 2000 }, {
      employee_id: 'E001', year: 2026, month: 4,
    });
    expect(r.base).toBe(2000);
    expect(r.deduction_rate).toBe(0);
    expect(r.actual).toBe(2000);
  });

  it('base=2000、扣 30% → actual=1400', async () => {
    const repo = makeRepo({
      findAbsentDaysByEmployeeMonth: vi.fn(async () => 1),
      getAbsentDayDeductionRate: vi.fn(async () => 0.3),
    });
    const r = await applyAttendanceBonus(repo, { id:'E001', attendance_bonus: 2000 }, {
      employee_id: 'E001', year: 2026, month: 4,
    });
    expect(r.base).toBe(2000);
    expect(r.deduction_rate).toBe(0.3);
    expect(r.actual).toBe(1400);
  });

  it('扣到上限 100% → actual=0', async () => {
    const repo = makeRepo({
      findAbsentDaysByEmployeeMonth: vi.fn(async () => 5),
      getAbsentDayDeductionRate: vi.fn(async () => 0.3),
    });
    const r = await applyAttendanceBonus(repo, { id:'E001', attendance_bonus: 2000 }, {
      employee_id: 'E001', year: 2026, month: 4,
    });
    expect(r.deduction_rate).toBe(1);
    expect(r.actual).toBe(0);
  });

  it('參數驗證', async () => {
    await expect(applyAttendanceBonus(makeRepo(), null, { employee_id:'E', year:2026, month:4 }))
      .rejects.toThrow(/employee/);
    await expect(applyAttendanceBonus(makeRepo(), { id:'E001', attendance_bonus: 2000 }, { month: 4 }))
      .rejects.toThrow(/year/);
  });
});
