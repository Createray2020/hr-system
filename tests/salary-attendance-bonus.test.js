import { describe, it, expect, vi } from 'vitest';
import { applyAttendanceBonus } from '../lib/salary/attendance-bonus.js';

// 基準月：2026/04 = 22 工作日（無 holidays）→ per_day_rate = 1/22 ≈ 0.0455
const Y = 2026, M = 4;

function makeRepo(over = {}) {
  return {
    // calculateAttendanceBonusDeduction 需要的 method
    findPenaltyRecordsByEmployeeMonth: vi.fn(async () => []),
    findApprovedAttendanceBonusLeaves: vi.fn(async () => []),
    findAbsentDaysByEmployeeMonth: vi.fn(async () => 0),
    findHolidaysByMonth: vi.fn(async () => []),
    ...over,
  };
}

describe('applyAttendanceBonus', () => {
  it('base=0(員工不領全勤)→ skip,actual=0', async () => {
    const r = await applyAttendanceBonus(makeRepo(), { id:'E001', attendance_bonus: 0 }, {
      employee_id: 'E001', year: Y, month: M,
    });
    expect(r).toMatchObject({ base: 0, deduction_rate: 0, actual: 0 });
  });

  it('base=2000、無扣 → actual=2000', async () => {
    const r = await applyAttendanceBonus(makeRepo(), { id:'E001', attendance_bonus: 2000 }, {
      employee_id: 'E001', year: Y, month: M,
    });
    expect(r.base).toBe(2000);
    expect(r.deduction_rate).toBe(0);
    expect(r.actual).toBe(2000);
  });

  it('base=2000、曠職 1 天 → 扣 1/22 → actual=1910 (rate round3 為 0.045)', async () => {
    const repo = makeRepo({
      findAbsentDaysByEmployeeMonth: vi.fn(async () => 1),
    });
    const r = await applyAttendanceBonus(repo, { id:'E001', attendance_bonus: 2000 }, {
      employee_id: 'E001', year: Y, month: M,
    });
    expect(r.base).toBe(2000);
    expect(r.deduction_rate).toBeCloseTo(1 / 22, 3);
    // rate 被 round3 為 0.045 → actual = round2(2000 × 0.955) = 1910
    expect(r.actual).toBe(1910);
  });

  it('扣到上限 100% → actual=0（曠職 22 天 = 全月）', async () => {
    const repo = makeRepo({
      findAbsentDaysByEmployeeMonth: vi.fn(async () => 22),
    });
    const r = await applyAttendanceBonus(repo, { id:'E001', attendance_bonus: 2000 }, {
      employee_id: 'E001', year: Y, month: M,
    });
    expect(r.deduction_rate).toBe(1);
    expect(r.actual).toBe(0);
  });

  it('參數驗證', async () => {
    await expect(applyAttendanceBonus(makeRepo(), null, { employee_id:'E', year:Y, month:M }))
      .rejects.toThrow(/employee/);
    await expect(applyAttendanceBonus(makeRepo(), { id:'E001', attendance_bonus: 2000 }, { month: M }))
      .rejects.toThrow(/year/);
  });
});
