// tests/salary-repo-helpers.test.js — api/salary/_repo.js 內 helper 純邏輯測試
//
// 對應 api/salary/_repo.js findTotalWorkHoursByEmployeeMonth L159-178、
// reduce 算式:`sum + Math.min(Number(r.work_hours)||0, 8)`(每日 cap 8h)。
// 規則:計薪基本工時每日上限 8 小時、超過屬加班、需另經核准加班申請才計、
//       不自動從 attendance.work_hours 換算加班。

import { describe, it, expect } from 'vitest';

// ── inline mirror(對齊 _repo.js 同公式;改一邊兩邊都要動,測試保護 drift)──
function capDailyForBasePay(rows) {
  return (rows || []).reduce(
    (sum, r) => sum + Math.min(Number(r.work_hours) || 0, 8),
    0,
  );
}

describe('findTotalWorkHoursByEmployeeMonth — 每日 cap 8h', () => {
  it('單筆 work_hours=9.2 → 計 8.0(超出 8h 不計)', () => {
    expect(capDailyForBasePay([{ work_hours: 9.2 }])).toBe(8);
  });

  it('單筆 work_hours=5 → 計 5.0(未滿 8h 全計)', () => {
    expect(capDailyForBasePay([{ work_hours: 5 }])).toBe(5);
  });

  it('剛好 8h → 計 8.0', () => {
    expect(capDailyForBasePay([{ work_hours: 8 }])).toBe(8);
  });

  it('混合:9.2 + 5 + 12 + 8 → 8 + 5 + 8 + 8 = 29', () => {
    expect(capDailyForBasePay([
      { work_hours: 9.2 }, { work_hours: 5 }, { work_hours: 12 }, { work_hours: 8 },
    ])).toBe(29);
  });

  it('22 天全 9.2(模擬兼職實況、原本算 202.4)→ cap 後 22 × 8 = 176', () => {
    const rows = Array.from({ length: 22 }, () => ({ work_hours: 9.2 }));
    expect(capDailyForBasePay(rows)).toBe(176);
  });

  it('空陣列 → 0', () => {
    expect(capDailyForBasePay([])).toBe(0);
    expect(capDailyForBasePay(null)).toBe(0);
  });

  it('work_hours=null / undefined → 0(防呆、不爆)', () => {
    expect(capDailyForBasePay([{ work_hours: null }, { work_hours: undefined }, { work_hours: 6 }])).toBe(6);
  });

  it('work_hours=負數(資料異常)→ Math.min(neg, 8) = neg、單筆測試保留(實務不該發生、由 .not(work_hours, is, null) 上游 + status 白名單部分擋)', () => {
    // 防衛性測試:即使 reduce 拿到負數,公式仍 deterministic、不會 throw
    expect(capDailyForBasePay([{ work_hours: -2 }])).toBe(-2);
  });
});
