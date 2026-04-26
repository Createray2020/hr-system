import { describe, it, expect, vi } from 'vitest';
import {
  applyPenaltyRules, matchesThreshold, calculatePenaltyAmount,
} from '../lib/attendance/penalty.js';

function makeRepo(over = {}) {
  return {
    findActivePenaltyRules: vi.fn(async () => []),
    countMonthlyTriggerEvents: vi.fn(async () => 1),
    insertPenaltyRecord: vi.fn(async (row) => ({ id: 1, ...row })),
    ...over,
  };
}

const att = (over = {}) => ({
  id: 'A1', employee_id: 'E001', work_date: '2026-04-26',
  status: 'late', late_minutes: 10, early_leave_minutes: 0,
  ...over,
});

const lateRule = (over = {}) => ({
  id: 1, trigger_type: 'late',
  threshold_minutes_min: 1, threshold_minutes_max: null,
  monthly_count_threshold: null,
  penalty_type: 'deduct_money_per_min', penalty_amount: 5, penalty_cap: null,
  is_active: true,
  ...over,
});

describe('matchesThreshold', () => {
  it('absent 不看 threshold', () => {
    expect(matchesThreshold({ trigger_type: 'absent', threshold_minutes_min: 99, threshold_minutes_max: 100 }, 0)).toBe(true);
  });
  it('min=1 max=null,minutes=10 → true', () => {
    expect(matchesThreshold(lateRule(), 10)).toBe(true);
  });
  it('min=1 max=5,minutes=10 → false(超過 max)', () => {
    expect(matchesThreshold(lateRule({ threshold_minutes_max: 5 }), 10)).toBe(false);
  });
  it('min=6 max=30,minutes=10 → true', () => {
    expect(matchesThreshold(lateRule({ threshold_minutes_min: 6, threshold_minutes_max: 30 }), 10)).toBe(true);
  });
  it('min=11,minutes=10 → false(未達 min)', () => {
    expect(matchesThreshold(lateRule({ threshold_minutes_min: 11 }), 10)).toBe(false);
  });
});

describe('calculatePenaltyAmount', () => {
  it('deduct_money_per_min:5/min × 10 min = 50', () => {
    expect(calculatePenaltyAmount(lateRule(), 10)).toBe(50);
  });
  it('deduct_money:固定金額不乘分鐘', () => {
    expect(calculatePenaltyAmount(lateRule({ penalty_type: 'deduct_money', penalty_amount: 100 }), 10)).toBe(100);
  });
  it('warning:0', () => {
    expect(calculatePenaltyAmount(lateRule({ penalty_type: 'warning', penalty_amount: 999 }), 10)).toBe(0);
  });
  it('penalty_cap:超過 cap 取 cap', () => {
    // 5/min × 60 min = 300,但 cap=200 → 200
    expect(calculatePenaltyAmount(lateRule({ penalty_cap: 200 }), 60)).toBe(200);
  });
  it('penalty_cap:沒超過 cap 用實算值', () => {
    expect(calculatePenaltyAmount(lateRule({ penalty_cap: 200 }), 30)).toBe(150);
  });
  it('deduct_attendance_bonus_pct:取 penalty_amount(由上層解讀為比例)', () => {
    expect(calculatePenaltyAmount(lateRule({ penalty_type: 'deduct_attendance_bonus_pct', penalty_amount: 30 }), 0)).toBe(30);
  });
  it('null penalty_amount → 0', () => {
    expect(calculatePenaltyAmount(lateRule({ penalty_amount: null }), 10)).toBe(0);
  });
});

describe('applyPenaltyRules — 觸發行為', () => {
  it('status=normal → 不觸發,回空陣列', async () => {
    const repo = makeRepo({ findActivePenaltyRules: vi.fn(async () => [lateRule()]) });
    const out = await applyPenaltyRules(repo, att({ status: 'normal' }));
    expect(out).toEqual([]);
    expect(repo.findActivePenaltyRules).not.toHaveBeenCalled();
  });

  it('status=late + 規則符合 → 寫一筆 record', async () => {
    const repo = makeRepo({
      findActivePenaltyRules: vi.fn(async () => [lateRule()]),
    });
    const out = await applyPenaltyRules(repo, att());
    expect(out).toHaveLength(1);
    const row = repo.insertPenaltyRecord.mock.calls[0][0];
    expect(row.employee_id).toBe('E001');
    expect(row.attendance_id).toBe('A1');
    expect(row.trigger_type).toBe('late');
    expect(row.trigger_minutes).toBe(10);
    expect(row.penalty_type).toBe('deduct_money_per_min');
    expect(row.penalty_amount).toBe(50); // 10 min × 5
    expect(row.applies_to_year).toBe(2026);
    expect(row.applies_to_month).toBe(4);
    expect(row.status).toBe('pending');
  });

  it('status=absent → trigger_type=absent', async () => {
    const absentRule = { id: 9, trigger_type: 'absent', penalty_type: 'deduct_attendance_bonus_pct', penalty_amount: 30, is_active: true };
    const repo = makeRepo({ findActivePenaltyRules: vi.fn(async () => [absentRule]) });
    const out = await applyPenaltyRules(repo, att({ status: 'absent', late_minutes: 0 }));
    expect(out).toHaveLength(1);
    expect(out[0].trigger_type).toBe('absent');
    expect(out[0].penalty_type).toBe('deduct_attendance_bonus_pct');
  });

  it('多階規則:late 3min 命中 1-5 階,不觸發 6-30 階', async () => {
    const r1 = lateRule({ id: 1, threshold_minutes_min: 1, threshold_minutes_max: 5,  penalty_amount: 10 });
    const r2 = lateRule({ id: 2, threshold_minutes_min: 6, threshold_minutes_max: 30, penalty_amount: 20 });
    const repo = makeRepo({ findActivePenaltyRules: vi.fn(async () => [r1, r2]) });
    const out = await applyPenaltyRules(repo, att({ late_minutes: 3 }));
    expect(out).toHaveLength(1);
    expect(repo.insertPenaltyRecord.mock.calls[0][0].penalty_rule_id).toBe(1);
  });

  it('monthly_count_threshold=3,當月才第 1 次 → 不觸發', async () => {
    const repo = makeRepo({
      findActivePenaltyRules: vi.fn(async () => [lateRule({ monthly_count_threshold: 3 })]),
      countMonthlyTriggerEvents: vi.fn(async () => 1),
    });
    const out = await applyPenaltyRules(repo, att());
    expect(out).toEqual([]);
    expect(repo.insertPenaltyRecord).not.toHaveBeenCalled();
  });

  it('monthly_count_threshold=3,第 3 次 → 觸發', async () => {
    const repo = makeRepo({
      findActivePenaltyRules: vi.fn(async () => [lateRule({ monthly_count_threshold: 3 })]),
      countMonthlyTriggerEvents: vi.fn(async () => 3),
    });
    const out = await applyPenaltyRules(repo, att());
    expect(out).toHaveLength(1);
  });

  it('沒 active rules → 空陣列', async () => {
    const repo = makeRepo({ findActivePenaltyRules: vi.fn(async () => []) });
    const out = await applyPenaltyRules(repo, att());
    expect(out).toEqual([]);
  });

  it('attendance 缺欄位 → throw', async () => {
    await expect(applyPenaltyRules(makeRepo(), {})).rejects.toThrow();
    await expect(applyPenaltyRules(makeRepo(), { employee_id: 'E001' })).rejects.toThrow();
  });

  it('repo 缺 method → throw', async () => {
    await expect(applyPenaltyRules({}, att())).rejects.toThrow();
  });
});
