import { describe, it, expect } from 'vitest';
import { sweepExpiredProofs } from '../lib/leave/proof-sweep.js';

const now = '2026-05-10T00:00:00+08:00';

describe('sweepExpiredProofs', () => {
  it('required + 已過期 → convert action', () => {
    const rows = [{
      id: 'L1', leave_type: 'sick',
      proof_status: 'required',
      proof_due_at: '2026-05-06T23:59:59+08:00',  // 已過
    }];
    const actions = sweepExpiredProofs(rows, now);
    expect(actions).toEqual([{
      id: 'L1',
      action: 'convert',
      leave_type: 'personal',
      proof_status: 'converted_to_personal',
      note_suffix: '原假別 sick、未補證明、自動轉事假',
      original_leave_type: 'sick',
    }]);
  });

  it('required + 未過期 → skip', () => {
    const rows = [{
      id: 'L2', leave_type: 'sick',
      proof_status: 'required',
      proof_due_at: '2026-05-15T23:59:59+08:00',  // 未到
    }];
    expect(sweepExpiredProofs(rows, now)).toEqual([]);
  });

  it('not_required → skip(不論 due 過期與否)', () => {
    const rows = [{
      id: 'L3', leave_type: 'personal',
      proof_status: 'not_required',
      proof_due_at: '2026-05-06T23:59:59+08:00',
    }];
    expect(sweepExpiredProofs(rows, now)).toEqual([]);
  });

  it('submitted → skip(員工已交、HR 還沒驗收也不轉)', () => {
    const rows = [{
      id: 'L4', leave_type: 'sick',
      proof_status: 'submitted',
      proof_due_at: '2026-05-06T23:59:59+08:00',
    }];
    expect(sweepExpiredProofs(rows, now)).toEqual([]);
  });

  it('expired → skip(已標 expired、不重複處理)', () => {
    const rows = [{
      id: 'L5', leave_type: 'sick',
      proof_status: 'expired',
      proof_due_at: '2026-05-06T23:59:59+08:00',
    }];
    expect(sweepExpiredProofs(rows, now)).toEqual([]);
  });

  it('converted_to_personal → skip(已轉、不重複處理)', () => {
    const rows = [{
      id: 'L6', leave_type: 'personal',  // 已轉、leave_type 也已是 personal
      proof_status: 'converted_to_personal',
      proof_due_at: '2026-05-06T23:59:59+08:00',
    }];
    expect(sweepExpiredProofs(rows, now)).toEqual([]);
  });

  it('混合 list:只挑 required + 過期那筆、其他 skip', () => {
    const rows = [
      { id: 'A', leave_type: 'sick',     proof_status: 'required',     proof_due_at: '2026-05-06T23:59:59+08:00' },
      { id: 'B', leave_type: 'funeral',  proof_status: 'required',     proof_due_at: '2026-05-15T23:59:59+08:00' },
      { id: 'C', leave_type: 'personal', proof_status: 'not_required', proof_due_at: null },
      { id: 'D', leave_type: 'maternity',proof_status: 'submitted',    proof_due_at: '2026-05-06T23:59:59+08:00' },
      { id: 'E', leave_type: 'work_injury', proof_status: 'required',  proof_due_at: '2026-05-08T23:59:59+08:00' },
    ];
    const actions = sweepExpiredProofs(rows, now);
    expect(actions.map(a => a.id)).toEqual(['A', 'E']);
    expect(actions[0].original_leave_type).toBe('sick');
    expect(actions[1].original_leave_type).toBe('work_injury');
  });

  it('空 list → 空 array', () => {
    expect(sweepExpiredProofs([], now)).toEqual([]);
    expect(sweepExpiredProofs(null, now)).toEqual([]);
  });

  it('預設 now=new Date()(不傳第二參數也能跑、不 throw)', () => {
    // 正常流程:cron 直接 call sweepExpiredProofs(rows)、now 預設用實際時間
    expect(() => sweepExpiredProofs([])).not.toThrow();
  });
});
