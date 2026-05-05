import { describe, it, expect } from 'vitest';
import { gapHoursBetween, validateAdvanceTime } from '../lib/leave/advance-time.js';

// 假別 fixture(對齊 Phase 1.1 backfill 後的真實值)
const LT = {
  annual:    { advance_hours: 72,  advance_rule: 'hard' },   // 特休
  sick:      { advance_hours: 0,   advance_rule: 'soft' },   // 病假
  menstrual: { advance_hours: 0,   advance_rule: 'soft' },   // 生理假
  parental:  { advance_hours: 240, advance_rule: 'hard' },   // 育嬰留停
  // hypothetical:soft + advance_hours > 0(目前 prod 沒這種、但 lib 要支援)
  fakeSoft:  { advance_hours: 24,  advance_rule: 'soft' },
};

describe('gapHoursBetween', () => {
  it('Date 物件 / ISO string 結果一致', () => {
    const sub  = '2026-05-01T09:00:00+08:00';
    const start = '2026-05-04T09:00:00+08:00';
    expect(gapHoursBetween(sub, start)).toBe(72);
    expect(gapHoursBetween(new Date(sub), new Date(start))).toBe(72);
  });

  it('start 在 sub 之前 → 負值(過去的假)', () => {
    expect(gapHoursBetween('2026-05-04T09:00:00+08:00', '2026-05-03T09:00:00+08:00')).toBe(-24);
  });

  it('跨時區字串(UTC vs +08:00)結果一致', () => {
    // 2026-05-01T01:00:00Z === 2026-05-01T09:00:00+08:00
    const sub  = '2026-05-01T01:00:00Z';
    const start = '2026-05-04T09:00:00+08:00';
    expect(gapHoursBetween(sub, start)).toBe(72);
  });
});

describe('validateAdvanceTime', () => {
  it('特休(hard, 72h)、3 天前送出 → ok, late=false', () => {
    const r = validateAdvanceTime(
      LT.annual,
      '2026-05-04T09:00:00+08:00',
      '2026-05-01T09:00:00+08:00',
    );
    expect(r).toEqual({ ok: true, late: false });
  });

  it('特休(hard, 72h)、1 小時前送出 → ok=false, ADVANCE_TIME_NOT_MET', () => {
    const r = validateAdvanceTime(
      LT.annual,
      '2026-05-04T10:00:00+08:00',
      '2026-05-04T09:00:00+08:00',
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('ADVANCE_TIME_NOT_MET');
    expect(r.advance_hours).toBe(72);
    expect(r.gap_hours).toBeCloseTo(1, 5);
  });

  it('病假(soft, 0h)、1 小時前送出 → ok=true, late=false(advance_hours=0 永遠通過)', () => {
    const r = validateAdvanceTime(
      LT.sick,
      '2026-05-04T10:00:00+08:00',
      '2026-05-04T09:00:00+08:00',
    );
    expect(r).toEqual({ ok: true, late: false });
  });

  it('生理假(soft, 0h)、同時送出 → ok=true, late=false', () => {
    const r = validateAdvanceTime(
      LT.menstrual,
      '2026-05-04T09:00:00+08:00',
      '2026-05-04T09:00:00+08:00',
    );
    expect(r).toEqual({ ok: true, late: false });
  });

  it('育嬰留停(hard, 240h)、剛好 240h 前送出 → ok=true(邊界 inclusive)', () => {
    const r = validateAdvanceTime(
      LT.parental,
      '2026-05-11T09:00:00+08:00',
      '2026-05-01T09:00:00+08:00',
    );
    expect(r).toEqual({ ok: true, late: false });
  });

  it('育嬰留停(hard, 240h)、剛好 239h 前送出 → ok=false', () => {
    const r = validateAdvanceTime(
      LT.parental,
      '2026-05-11T09:00:00+08:00',
      '2026-05-01T10:00:00+08:00',
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('ADVANCE_TIME_NOT_MET');
    expect(r.gap_hours).toBeCloseTo(239, 5);
  });

  it('soft + advance_hours > 0、未達 → ok=true, late=true, requireLateReason=true', () => {
    const r = validateAdvanceTime(
      LT.fakeSoft,
      '2026-05-04T10:00:00+08:00',
      '2026-05-04T09:00:00+08:00',
    );
    expect(r.ok).toBe(true);
    expect(r.late).toBe(true);
    expect(r.requireLateReason).toBe(true);
    expect(r.advance_hours).toBe(24);
  });

  it('invalid advance_rule → throw', () => {
    expect(() => validateAdvanceTime(
      { advance_hours: 10, advance_rule: 'bogus' },
      '2026-05-04T09:00:00+08:00',
      '2026-05-01T09:00:00+08:00',
    )).toThrow(/advance_rule/);
  });

  it('null leaveType → throw', () => {
    expect(() => validateAdvanceTime(null, '2026-05-04T09:00:00+08:00')).toThrow(/leaveType/);
  });
});
