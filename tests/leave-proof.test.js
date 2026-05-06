import { describe, it, expect } from 'vitest';
import {
  computeProofDueAt,
  getInitialProofStatus,
  isProofExpired,
} from '../lib/leave/proof.js';

// 假別 fixture(對齊 Phase 1.1 backfill 後的真實值)
const LT = {
  sick:        { requires_proof: true,  proof_grace_days: 5 },   // 病假
  funeral:     { requires_proof: true,  proof_grace_days: 5 },   // 喪假
  work_injury: { requires_proof: true,  proof_grace_days: 0 },   // 公傷病假
  marriage:    { requires_proof: true,  proof_grace_days: 0 },   // 婚假
  personal:    { requires_proof: false, proof_grace_days: 0 },   // 事假
  menstrual:   { requires_proof: false, proof_grace_days: 0 },   // 生理假
};

describe('computeProofDueAt', () => {
  it('病假(grace=5)leaveEndDate=2026-05-10 → due=2026-05-15(+5 天)', () => {
    const due = computeProofDueAt(LT.sick, '2026-05-10');
    expect(due).toBeInstanceOf(Date);
    // 顯示為台灣日期應為 2026-05-15
    expect(due.toISOString().slice(0, 10)).toBe('2026-05-15');
  });

  it('喪假(grace=5)leaveEndDate=2026-05-10 → due=2026-05-15', () => {
    const due = computeProofDueAt(LT.funeral, '2026-05-10');
    expect(due.toISOString().slice(0, 10)).toBe('2026-05-15');
  });

  it('公傷病假(grace=0)→ due = leaveEndDate 當天', () => {
    const due = computeProofDueAt(LT.work_injury, '2026-05-10');
    expect(due.toISOString().slice(0, 10)).toBe('2026-05-10');
  });

  it('婚假(grace=0)→ due = leaveEndDate', () => {
    const due = computeProofDueAt(LT.marriage, '2026-05-10');
    expect(due.toISOString().slice(0, 10)).toBe('2026-05-10');
  });

  it('事假(requires_proof=false)→ null', () => {
    expect(computeProofDueAt(LT.personal, '2026-05-10')).toBeNull();
  });

  it('生理假(requires_proof=false)→ null', () => {
    expect(computeProofDueAt(LT.menstrual, '2026-05-10')).toBeNull();
  });

  it('leaveEndDate 接 Date 物件也 OK', () => {
    const end = new Date('2026-05-10T23:59:59+08:00');
    const due = computeProofDueAt(LT.sick, end);
    expect(due.toISOString().slice(0, 10)).toBe('2026-05-15');
  });
});

describe('getInitialProofStatus', () => {
  it('病假 → required', () => {
    expect(getInitialProofStatus(LT.sick)).toBe('required');
  });

  it('喪假 → required', () => {
    expect(getInitialProofStatus(LT.funeral)).toBe('required');
  });

  it('事假 → not_required', () => {
    expect(getInitialProofStatus(LT.personal)).toBe('not_required');
  });

  it('生理假 → not_required', () => {
    expect(getInitialProofStatus(LT.menstrual)).toBe('not_required');
  });
});

describe('isProofExpired', () => {
  const now = '2026-05-20T00:00:00+08:00';

  it('required + due 已過 → true', () => {
    const req = { proof_status: 'required', proof_due_at: '2026-05-15T23:59:59+08:00' };
    expect(isProofExpired(req, now)).toBe(true);
  });

  it('submitted + due 已過 → false(已交不用轉)', () => {
    const req = { proof_status: 'submitted', proof_due_at: '2026-05-15T23:59:59+08:00' };
    expect(isProofExpired(req, now)).toBe(false);
  });

  it('required + due 未過 → false', () => {
    const req = { proof_status: 'required', proof_due_at: '2026-05-25T23:59:59+08:00' };
    expect(isProofExpired(req, now)).toBe(false);
  });

  it('not_required → false(不用看 due)', () => {
    const req = { proof_status: 'not_required', proof_due_at: '2026-05-15T23:59:59+08:00' };
    expect(isProofExpired(req, now)).toBe(false);
  });

  it('converted_to_personal → false(已轉)', () => {
    const req = { proof_status: 'converted_to_personal', proof_due_at: '2026-05-15T23:59:59+08:00' };
    expect(isProofExpired(req, now)).toBe(false);
  });

  it('proof_due_at 為 null → false', () => {
    const req = { proof_status: 'required', proof_due_at: null };
    expect(isProofExpired(req, now)).toBe(false);
  });
});
