import { describe, it, expect, vi } from 'vitest';
import { calculateAttendanceBonusDeduction } from '../lib/attendance/bonus.js';

// 基準月：2026/04 = 22 工作日（無 holidays）→ per_day_rate = 1/22 ≈ 0.0455
const Y = 2026, M = 4;
const PER_DAY = 1 / 22;

function makeRepo(over = {}) {
  return {
    findPenaltyRecordsByEmployeeMonth: vi.fn(async () => []),
    findApprovedAttendanceBonusLeaves: vi.fn(async () => []),
    findAbsentDaysByEmployeeMonth: vi.fn(async () => 0),
    findHolidaysByMonth: vi.fn(async () => []),
    ...over,
  };
}

describe('calculateAttendanceBonusDeduction (C 項：動態 1/workdays)', () => {
  it('全部 0 → deduction_rate=0', async () => {
    const r = await calculateAttendanceBonusDeduction(makeRepo(), {
      employee_id: 'E001', year: Y, month: M,
    });
    expect(r.deduction_rate).toBe(0);
    expect(r.breakdown.absent_days).toBe(0);
    expect(r.breakdown.workdays_in_month).toBe(22);
  });

  it('曠職 1 天 → 1/22 (≈ 4.5%)', async () => {
    const repo = makeRepo({
      findAbsentDaysByEmployeeMonth: vi.fn(async () => 1),
    });
    const r = await calculateAttendanceBonusDeduction(repo, { employee_id:'E001', year:Y, month:M });
    expect(r.deduction_rate).toBeCloseTo(PER_DAY, 3);
    expect(r.breakdown.from_absence).toBeCloseTo(PER_DAY, 3);
    expect(r.breakdown.per_day_rate).toBeCloseTo(PER_DAY, 3);
  });

  it('曠職 22 天 → 22/22 = 1.0 (剛好全扣)', async () => {
    const repo = makeRepo({
      findAbsentDaysByEmployeeMonth: vi.fn(async () => 22),
    });
    const r = await calculateAttendanceBonusDeduction(repo, { employee_id:'E001', year:Y, month:M });
    expect(r.deduction_rate).toBe(1);
  });

  it('曠職 + 請假混算超過 1.0 → cap 到 1.0', async () => {
    const repo = makeRepo({
      findAbsentDaysByEmployeeMonth: vi.fn(async () => 15),
      findApprovedAttendanceBonusLeaves: vi.fn(async () => [
        { finalized_hours: 80, affects_attendance_bonus: true }, // 10 天
      ]),
    });
    const r = await calculateAttendanceBonusDeduction(repo, { employee_id:'E001', year:Y, month:M });
    // 15/22 + 10/22 = 25/22 ≈ 1.136 → cap 1.0
    expect(r.deduction_rate).toBe(1);
    expect(r.breakdown.total_before_cap).toBeCloseTo(25 / 22, 3);
  });

  it('影響全勤的請假 2 天 → 2/22', async () => {
    const repo = makeRepo({
      findApprovedAttendanceBonusLeaves: vi.fn(async () => [
        { leave_type: 'sick', finalized_hours: 16, affects_attendance_bonus: true },
      ]),
    });
    const r = await calculateAttendanceBonusDeduction(repo, { employee_id:'E001', year:Y, month:M });
    expect(r.breakdown.leave_days).toBe(2);
    expect(r.breakdown.from_leaves).toBeCloseTo(2 / 22, 3);
    expect(r.deduction_rate).toBeCloseTo(2 / 22, 3);
  });

  it('penalty_records 中 deduct_attendance_bonus_pct=30 → 視為 30%', async () => {
    const repo = makeRepo({
      findPenaltyRecordsByEmployeeMonth: vi.fn(async () => [
        { penalty_type: 'deduct_attendance_bonus_pct', penalty_amount: 30, status: 'pending' },
      ]),
    });
    const r = await calculateAttendanceBonusDeduction(repo, { employee_id:'E001', year:Y, month:M });
    expect(r.breakdown.from_penalty_records).toBe(0.3);
    expect(r.deduction_rate).toBe(0.3);
  });

  it('penalty_records 中 0.5 視為 50%(小數習慣)', async () => {
    const repo = makeRepo({
      findPenaltyRecordsByEmployeeMonth: vi.fn(async () => [
        { penalty_type: 'deduct_attendance_bonus_pct', penalty_amount: 0.5, status: 'pending' },
      ]),
    });
    const r = await calculateAttendanceBonusDeduction(repo, { employee_id:'E001', year:Y, month:M });
    expect(r.breakdown.from_penalty_records).toBe(0.5);
  });

  it('waived 的 penalty 不算', async () => {
    const repo = makeRepo({
      findPenaltyRecordsByEmployeeMonth: vi.fn(async () => [
        { penalty_type: 'deduct_attendance_bonus_pct', penalty_amount: 50, status: 'waived' },
      ]),
    });
    const r = await calculateAttendanceBonusDeduction(repo, { employee_id:'E001', year:Y, month:M });
    expect(r.deduction_rate).toBe(0);
  });

  it('其他 penalty_type 不算入 bonus 扣除(deduct_money 由薪資模組另算)', async () => {
    const repo = makeRepo({
      findPenaltyRecordsByEmployeeMonth: vi.fn(async () => [
        { penalty_type: 'deduct_money', penalty_amount: 100, status: 'pending' },
      ]),
    });
    const r = await calculateAttendanceBonusDeduction(repo, { employee_id:'E001', year:Y, month:M });
    expect(r.breakdown.from_penalty_records).toBe(0);
    expect(r.deduction_rate).toBe(0);
  });

  it('三層加總:曠職 5 天 + 請假 5 天 + penalty pct=50% → 10/22 + 0.5 ≈ 0.95', async () => {
    const repo = makeRepo({
      findAbsentDaysByEmployeeMonth: vi.fn(async () => 5),
      findApprovedAttendanceBonusLeaves: vi.fn(async () => [
        { finalized_hours: 40, affects_attendance_bonus: true }, // 5 天
      ]),
      findPenaltyRecordsByEmployeeMonth: vi.fn(async () => [
        { penalty_type: 'deduct_attendance_bonus_pct', penalty_amount: 50, status: 'pending' },
      ]),
    });
    const r = await calculateAttendanceBonusDeduction(repo, { employee_id:'E001', year:Y, month:M });
    // 5/22 + 5/22 + 0.5 = 10/22 + 0.5 ≈ 0.9545
    expect(r.deduction_rate).toBeCloseTo(10 / 22 + 0.5, 3);
  });

  it('holidays 影響 workdays：2026/02 春節月扣後僅約 11 工作日', async () => {
    const feb2026Holidays = [
      { date: '2026-02-16', holiday_type: 'national' },
      { date: '2026-02-17', holiday_type: 'national' },
      { date: '2026-02-18', holiday_type: 'national' },
      { date: '2026-02-19', holiday_type: 'national' },
      { date: '2026-02-20', holiday_type: 'national' },
      { date: '2026-02-27', holiday_type: 'national' },
    ];
    const repo = makeRepo({
      findAbsentDaysByEmployeeMonth: vi.fn(async () => 1),
      findHolidaysByMonth: vi.fn(async () => feb2026Holidays),
    });
    const r = await calculateAttendanceBonusDeduction(repo, { employee_id:'E001', year:2026, month:2 });
    // 2026/02 共 28 天，週末(2/1,7,8,14,15,21,22,28) 8 天 → 20 個 weekday，再扣 6 個 national → 14 工作日
    expect(r.breakdown.workdays_in_month).toBe(14);
    expect(r.deduction_rate).toBeCloseTo(1 / 14, 3);
  });

  it('makeup_workday 不算 holiday(視為工作日)', async () => {
    const repo = makeRepo({
      findHolidaysByMonth: vi.fn(async () => [
        { date: '2026-04-15', holiday_type: 'makeup_workday' },
      ]),
    });
    const r = await calculateAttendanceBonusDeduction(repo, { employee_id:'E001', year:Y, month:M });
    // makeup_workday 不會放進 holidayDates set → workdays 仍是 22
    expect(r.breakdown.workdays_in_month).toBe(22);
  });

  it('參數驗證', async () => {
    await expect(calculateAttendanceBonusDeduction(makeRepo(), { year: Y, month: M })).rejects.toThrow(/employee_id/);
    await expect(calculateAttendanceBonusDeduction(makeRepo(), { employee_id: 'E001', month: M })).rejects.toThrow(/year/);
    await expect(calculateAttendanceBonusDeduction(makeRepo(), { employee_id: 'E001', year: Y, month: 13 })).rejects.toThrow(/month/);
    await expect(calculateAttendanceBonusDeduction({}, { employee_id:'E001', year:Y, month:M })).rejects.toThrow();
  });
});
