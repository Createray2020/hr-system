import { describe, it, expect } from 'vitest';
import { sweepExpiredProofs } from '../lib/leave/proof-sweep.js';

const now = '2026-05-10T00:00:00+08:00';

// Phase 1.5 升級 leave_types map(對齊 prod backfill 後的 proof_expiry_action 值)
const LT = {
  sick:            { code: 'sick',            proof_expiry_action: 'convert' },
  hospital_unpaid: { code: 'hospital_unpaid', proof_expiry_action: 'convert' },
  marriage:        { code: 'marriage',        proof_expiry_action: 'mark_expired' },
  funeral:         { code: 'funeral',         proof_expiry_action: 'mark_expired' },
  maternity:       { code: 'maternity',       proof_expiry_action: 'mark_expired' },
  work_injury:     { code: 'work_injury',     proof_expiry_action: 'mark_expired' },
  parental:        { code: 'parental',        proof_expiry_action: 'mark_expired' },
  // not_required 假別、不該被 sweep 撈到、放進 LT 純為完整性
  personal:        { code: 'personal',        proof_expiry_action: 'convert' },
};

describe('sweepExpiredProofs — convert action(短假、員工該負責補)', () => {
  it('sick + 已過期 → convert action', () => {
    const rows = [{
      id: 'L1', leave_type: 'sick',
      proof_status: 'required',
      proof_due_at: '2026-05-06T23:59:59+08:00',  // 已過
    }];
    const actions = sweepExpiredProofs(rows, LT, now);
    expect(actions).toEqual([{
      id: 'L1',
      action: 'convert',
      leave_type: 'personal',
      proof_status: 'converted_to_personal',
      note_suffix: '原假別 sick、未補證明、自動轉事假',
      original_leave_type: 'sick',
    }]);
  });

  it('hospital_unpaid + 已過期 → convert action', () => {
    const rows = [{
      id: 'L_HU', leave_type: 'hospital_unpaid',
      proof_status: 'required',
      proof_due_at: '2026-05-06T23:59:59+08:00',
    }];
    const actions = sweepExpiredProofs(rows, LT, now);
    expect(actions[0].action).toBe('convert');
    expect(actions[0].leave_type).toBe('personal');
    expect(actions[0].original_leave_type).toBe('hospital_unpaid');
  });

  it('required + 未過期 → skip', () => {
    const rows = [{
      id: 'L2', leave_type: 'sick',
      proof_status: 'required',
      proof_due_at: '2026-05-15T23:59:59+08:00',  // 未到
    }];
    expect(sweepExpiredProofs(rows, LT, now)).toEqual([]);
  });

  it('not_required → skip(不論 due 過期與否)', () => {
    const rows = [{
      id: 'L3', leave_type: 'personal',
      proof_status: 'not_required',
      proof_due_at: '2026-05-06T23:59:59+08:00',
    }];
    expect(sweepExpiredProofs(rows, LT, now)).toEqual([]);
  });

  it('submitted → skip(員工已交、HR 還沒驗收也不轉)', () => {
    const rows = [{
      id: 'L4', leave_type: 'sick',
      proof_status: 'submitted',
      proof_due_at: '2026-05-06T23:59:59+08:00',
    }];
    expect(sweepExpiredProofs(rows, LT, now)).toEqual([]);
  });

  it('expired → skip(已標 expired、不重複處理)', () => {
    const rows = [{
      id: 'L5', leave_type: 'sick',
      proof_status: 'expired',
      proof_due_at: '2026-05-06T23:59:59+08:00',
    }];
    expect(sweepExpiredProofs(rows, LT, now)).toEqual([]);
  });

  it('converted_to_personal → skip(已轉、不重複處理)', () => {
    const rows = [{
      id: 'L6', leave_type: 'personal',  // 已轉、leave_type 也已是 personal
      proof_status: 'converted_to_personal',
      proof_due_at: '2026-05-06T23:59:59+08:00',
    }];
    expect(sweepExpiredProofs(rows, LT, now)).toEqual([]);
  });
});

describe('sweepExpiredProofs — mark_expired action(法定假、HR 個案處理)', () => {
  it('marriage + 已過期 → mark_expired action(leave_type 不動)', () => {
    const rows = [{
      id: 'L_M', leave_type: 'marriage',
      proof_status: 'required',
      proof_due_at: '2026-05-06T23:59:59+08:00',
    }];
    const actions = sweepExpiredProofs(rows, LT, now);
    expect(actions).toEqual([{
      id: 'L_M',
      action: 'mark_expired',
      proof_status: 'expired',
      note_suffix: '原假別 marriage、未補證明、HR 個案處理',
      original_leave_type: 'marriage',
    }]);
    // 守:mark_expired action 不該帶 leave_type 欄位(避免下游誤覆蓋)
    expect('leave_type' in actions[0]).toBe(false);
  });

  it('funeral / maternity / work_injury / parental 都走 mark_expired', () => {
    const rows = [
      { id: 'F', leave_type: 'funeral',     proof_status: 'required', proof_due_at: '2026-05-06T23:59:59+08:00' },
      { id: 'M', leave_type: 'maternity',   proof_status: 'required', proof_due_at: '2026-05-06T23:59:59+08:00' },
      { id: 'W', leave_type: 'work_injury', proof_status: 'required', proof_due_at: '2026-05-06T23:59:59+08:00' },
      { id: 'P', leave_type: 'parental',    proof_status: 'required', proof_due_at: '2026-05-06T23:59:59+08:00' },
    ];
    const actions = sweepExpiredProofs(rows, LT, now);
    expect(actions.map(a => a.action)).toEqual(['mark_expired','mark_expired','mark_expired','mark_expired']);
    expect(actions.map(a => a.proof_status)).toEqual(['expired','expired','expired','expired']);
  });

  it('mark_expired + 未過期 → skip(同 convert 路徑、isProofExpired 守在前)', () => {
    const rows = [{
      id: 'L_M2', leave_type: 'marriage',
      proof_status: 'required',
      proof_due_at: '2026-05-15T23:59:59+08:00',
    }];
    expect(sweepExpiredProofs(rows, LT, now)).toEqual([]);
  });
});

describe('sweepExpiredProofs — leaveTypesByCode 缺值 fallback', () => {
  it('leave_type 在 map 裡找不到 → fallback convert(safety、防新增假別漏 backfill)', () => {
    const rows = [{
      id: 'L_X', leave_type: 'unknown_new_type',
      proof_status: 'required',
      proof_due_at: '2026-05-06T23:59:59+08:00',
    }];
    const actions = sweepExpiredProofs(rows, LT, now);
    expect(actions).toEqual([{
      id: 'L_X',
      action: 'convert',
      leave_type: 'personal',
      proof_status: 'converted_to_personal',
      note_suffix: '原假別 unknown_new_type、未補證明、自動轉事假',
      original_leave_type: 'unknown_new_type',
    }]);
  });

  it('leaveTypesByCode 整個沒傳 → fallback convert(預設 {})', () => {
    const rows = [{
      id: 'L_Y', leave_type: 'sick',
      proof_status: 'required',
      proof_due_at: '2026-05-06T23:59:59+08:00',
    }];
    const actions = sweepExpiredProofs(rows, undefined, now);
    expect(actions[0].action).toBe('convert');
  });

  it('leaveType row 缺 proof_expiry_action 欄位 → fallback convert', () => {
    const rows = [{
      id: 'L_Z', leave_type: 'sick',
      proof_status: 'required',
      proof_due_at: '2026-05-06T23:59:59+08:00',
    }];
    const actions = sweepExpiredProofs(rows, { sick: { code: 'sick' /* 沒 proof_expiry_action */ } }, now);
    expect(actions[0].action).toBe('convert');
  });
});

describe('sweepExpiredProofs — 混合 / 邊界', () => {
  it('混合 list:只挑 required + 過期、依 leave_type 分流 action', () => {
    const rows = [
      { id: 'A', leave_type: 'sick',     proof_status: 'required',     proof_due_at: '2026-05-06T23:59:59+08:00' },  // convert
      { id: 'B', leave_type: 'funeral',  proof_status: 'required',     proof_due_at: '2026-05-15T23:59:59+08:00' },  // 未過、skip
      { id: 'C', leave_type: 'personal', proof_status: 'not_required', proof_due_at: null },                          // skip
      { id: 'D', leave_type: 'maternity',proof_status: 'submitted',    proof_due_at: '2026-05-06T23:59:59+08:00' },  // skip
      { id: 'E', leave_type: 'work_injury', proof_status: 'required',  proof_due_at: '2026-05-08T23:59:59+08:00' },  // mark_expired
      { id: 'F', leave_type: 'marriage', proof_status: 'required',     proof_due_at: '2026-05-06T23:59:59+08:00' },  // mark_expired
    ];
    const actions = sweepExpiredProofs(rows, LT, now);
    expect(actions.map(a => a.id)).toEqual(['A', 'E', 'F']);
    expect(actions.map(a => a.action)).toEqual(['convert', 'mark_expired', 'mark_expired']);
  });

  it('空 list → 空 array', () => {
    expect(sweepExpiredProofs([], LT, now)).toEqual([]);
    expect(sweepExpiredProofs(null, LT, now)).toEqual([]);
  });

  it('預設 now=new Date()(只傳 rows + map 也能跑、不 throw)', () => {
    expect(() => sweepExpiredProofs([], LT)).not.toThrow();
  });
});
