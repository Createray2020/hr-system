import { describe, it, expect, vi } from 'vitest';
import { calculateAttendanceBonusDeduction } from '../lib/attendance/bonus.js';

function makeRepo(over = {}) {
  return {
    findPenaltyRecordsByEmployeeMonth: vi.fn(async () => []),
    findApprovedAttendanceBonusLeaves: vi.fn(async () => []),
    findAbsentDaysByEmployeeMonth: vi.fn(async () => 0),
    getAbsentDayDeductionRate: vi.fn(async () => 0),
    ...over,
  };
}

describe('calculateAttendanceBonusDeduction', () => {
  it('全部 0 → deduction_rate=0', async () => {
    const r = await calculateAttendanceBonusDeduction(makeRepo(), {
      employee_id: 'E001', year: 2026, month: 4,
    });
    expect(r.deduction_rate).toBe(0);
    expect(r.breakdown.absent_days).toBe(0);
  });

  it('曠職 1 天 + 公司設定每天扣 30% → 0.3', async () => {
    const repo = makeRepo({
      findAbsentDaysByEmployeeMonth: vi.fn(async () => 1),
      getAbsentDayDeductionRate: vi.fn(async () => 0.3),
    });
    const r = await calculateAttendanceBonusDeduction(repo, { employee_id:'E001', year:2026, month:4 });
    expect(r.deduction_rate).toBe(0.3);
    expect(r.breakdown.from_absence).toBe(0.3);
  });

  it('曠職 5 天 × 30%/天 → 上限 1.0(規範:扣到 0 為止)', async () => {
    const repo = makeRepo({
      findAbsentDaysByEmployeeMonth: vi.fn(async () => 5),
      getAbsentDayDeductionRate: vi.fn(async () => 0.3),
    });
    const r = await calculateAttendanceBonusDeduction(repo, { employee_id:'E001', year:2026, month:4 });
    expect(r.deduction_rate).toBe(1);
    expect(r.breakdown.total_before_cap).toBe(1.5);
  });

  it('影響全勤的請假 → 用同樣比例規則加進來', async () => {
    const repo = makeRepo({
      findApprovedAttendanceBonusLeaves: vi.fn(async () => [
        { leave_type: 'sick', finalized_hours: 16, affects_attendance_bonus: true }, // 2 天
      ]),
      getAbsentDayDeductionRate: vi.fn(async () => 0.1),
    });
    const r = await calculateAttendanceBonusDeduction(repo, { employee_id:'E001', year:2026, month:4 });
    expect(r.breakdown.leave_days).toBe(2);
    expect(r.breakdown.from_leaves).toBe(0.2);
    expect(r.deduction_rate).toBe(0.2);
  });

  it('penalty_records 中 deduct_attendance_bonus_pct=30 → 視為 30%', async () => {
    const repo = makeRepo({
      findPenaltyRecordsByEmployeeMonth: vi.fn(async () => [
        { penalty_type: 'deduct_attendance_bonus_pct', penalty_amount: 30, status: 'pending' },
      ]),
    });
    const r = await calculateAttendanceBonusDeduction(repo, { employee_id:'E001', year:2026, month:4 });
    expect(r.breakdown.from_penalty_records).toBe(0.3);
    expect(r.deduction_rate).toBe(0.3);
  });

  it('penalty_records 中 0.5 視為 50%(小數習慣)', async () => {
    const repo = makeRepo({
      findPenaltyRecordsByEmployeeMonth: vi.fn(async () => [
        { penalty_type: 'deduct_attendance_bonus_pct', penalty_amount: 0.5, status: 'pending' },
      ]),
    });
    const r = await calculateAttendanceBonusDeduction(repo, { employee_id:'E001', year:2026, month:4 });
    expect(r.breakdown.from_penalty_records).toBe(0.5);
  });

  it('waived 的 penalty 不算', async () => {
    const repo = makeRepo({
      findPenaltyRecordsByEmployeeMonth: vi.fn(async () => [
        { penalty_type: 'deduct_attendance_bonus_pct', penalty_amount: 50, status: 'waived' },
      ]),
    });
    const r = await calculateAttendanceBonusDeduction(repo, { employee_id:'E001', year:2026, month:4 });
    expect(r.deduction_rate).toBe(0);
  });

  it('其他 penalty_type 不算入 bonus 扣除(deduct_money 由薪資模組另算)', async () => {
    const repo = makeRepo({
      findPenaltyRecordsByEmployeeMonth: vi.fn(async () => [
        { penalty_type: 'deduct_money', penalty_amount: 100, status: 'pending' },
      ]),
    });
    const r = await calculateAttendanceBonusDeduction(repo, { employee_id:'E001', year:2026, month:4 });
    expect(r.breakdown.from_penalty_records).toBe(0);
    expect(r.deduction_rate).toBe(0);
  });

  it('三層加總:絕職 1 天 30% + 請假 1 天 30% + penalty pct=20% → cap 1.0', async () => {
    const repo = makeRepo({
      findAbsentDaysByEmployeeMonth: vi.fn(async () => 1),
      getAbsentDayDeductionRate: vi.fn(async () => 0.3),
      findApprovedAttendanceBonusLeaves: vi.fn(async () => [
        { finalized_hours: 8, affects_attendance_bonus: true },
      ]),
      findPenaltyRecordsByEmployeeMonth: vi.fn(async () => [
        { penalty_type: 'deduct_attendance_bonus_pct', penalty_amount: 50, status: 'pending' },
      ]),
    });
    const r = await calculateAttendanceBonusDeduction(repo, { employee_id:'E001', year:2026, month:4 });
    // 0.3 + 0.3 + 0.5 = 1.1 → cap 1.0
    expect(r.deduction_rate).toBe(1);
    expect(r.breakdown.total_before_cap).toBeCloseTo(1.1);
  });

  it('參數驗證', async () => {
    await expect(calculateAttendanceBonusDeduction(makeRepo(), { year: 2026, month: 4 })).rejects.toThrow(/employee_id/);
    await expect(calculateAttendanceBonusDeduction(makeRepo(), { employee_id: 'E001', month: 4 })).rejects.toThrow(/year/);
    await expect(calculateAttendanceBonusDeduction(makeRepo(), { employee_id: 'E001', year: 2026, month: 13 })).rejects.toThrow(/month/);
    await expect(calculateAttendanceBonusDeduction({}, { employee_id:'E001', year:2026, month:4 })).rejects.toThrow();
  });
});
