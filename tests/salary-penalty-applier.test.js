import { describe, it, expect, vi } from 'vitest';
import { applyAttendancePenalties } from '../lib/salary/penalty-applier.js';

function makeRepo(over = {}) {
  return {
    findPendingPenaltyRecords: vi.fn(async () => []),
    markPenaltyRecordApplied: vi.fn(async (id, sid) => ({ id, salary_record_id: sid, status: 'applied' })),
    ...over,
  };
}

describe('applyAttendancePenalties', () => {
  it('沒 pending → total=0', async () => {
    const r = await applyAttendancePenalties(makeRepo(), {
      employee_id:'E001', year:2026, month:4, salary_record_id:'S1',
    });
    expect(r.total).toBe(0);
    expect(r.count).toBe(0);
  });

  it('只加總 deduct_money / deduct_money_per_min', async () => {
    const repo = makeRepo({
      findPendingPenaltyRecords: vi.fn(async () => [
        { id: 1, penalty_type: 'deduct_money',         penalty_amount: 100, trigger_type:'late', trigger_minutes:10 },
        { id: 2, penalty_type: 'deduct_money_per_min', penalty_amount: 50,  trigger_type:'early_leave', trigger_minutes:5 },
        { id: 3, penalty_type: 'deduct_attendance_bonus_pct', penalty_amount: 30, trigger_type:'absent' }, // skip
        { id: 4, penalty_type: 'warning',              penalty_amount: 0,   trigger_type:'late' }, // skip
        { id: 5, penalty_type: 'deduct_attendance_bonus', penalty_amount: 1000, trigger_type:'absent' }, // skip
      ]),
    });
    const r = await applyAttendancePenalties(repo, {
      employee_id:'E001', year:2026, month:4, salary_record_id:'S1',
    });
    expect(r.total).toBe(150); // 100 + 50
    expect(r.count).toBe(2);
    expect(repo.markPenaltyRecordApplied).toHaveBeenCalledTimes(2);
    // 只 mark 那兩筆現金扣款 records
    expect(repo.markPenaltyRecordApplied).toHaveBeenCalledWith(1, 'S1');
    expect(repo.markPenaltyRecordApplied).toHaveBeenCalledWith(2, 'S1');
  });

  it('沒 salary_record_id 不 mark', async () => {
    const repo = makeRepo({
      findPendingPenaltyRecords: vi.fn(async () => [
        { id: 1, penalty_type: 'deduct_money', penalty_amount: 100 },
      ]),
    });
    await applyAttendancePenalties(repo, { employee_id:'E001', year:2026, month:4 });
    expect(repo.markPenaltyRecordApplied).not.toHaveBeenCalled();
  });

  it('參數驗證', async () => {
    await expect(applyAttendancePenalties({}, { employee_id:'E001', year:2026, month:4 })).rejects.toThrow();
    await expect(applyAttendancePenalties(makeRepo(), { year:2026, month:4 })).rejects.toThrow(/employee_id/);
  });
});
