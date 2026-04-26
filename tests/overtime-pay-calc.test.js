import { describe, it, expect } from 'vitest';
import {
  calculateOvertimePay, getHourlyRate, pickFrozenPayMultiplier,
} from '../lib/overtime/pay-calc.js';

const config = {
  weekday_overtime_first_2h_rate:  1.34,
  weekday_overtime_after_2h_rate:  1.67,
  rest_day_overtime_first_2h_rate: 1.34,
  rest_day_overtime_after_2h_rate: 1.67,
};

describe('calculateOvertimePay — weekday', () => {
  it('1h 加班 → 1 × 200 × 1.34 = 268', () => {
    const r = calculateOvertimePay(1, 200, config, 'weekday');
    expect(r.amount).toBe(268);
    expect(r.breakdown.hours_first_2h).toBe(1);
    expect(r.breakdown.rate_first_2h).toBe(1.34);
    expect(r.breakdown.hours_after_2h).toBe(0);
  });

  it('2h 全用前 2h 倍率 → 2 × 200 × 1.34 = 536', () => {
    const r = calculateOvertimePay(2, 200, config, 'weekday');
    expect(r.amount).toBe(536);
  });

  it('3h:前 2h 用 1.34、後 1h 用 1.67 → 2×200×1.34 + 1×200×1.67 = 536+334 = 870', () => {
    const r = calculateOvertimePay(3, 200, config, 'weekday');
    expect(r.amount).toBe(870);
    expect(r.breakdown.hours_first_2h).toBe(2);
    expect(r.breakdown.hours_after_2h).toBe(1);
  });

  it('4h:2 × 200 × 1.34 + 2 × 200 × 1.67 = 536 + 668 = 1204', () => {
    const r = calculateOvertimePay(4, 200, config, 'weekday');
    expect(r.amount).toBe(1204);
  });
});

describe('calculateOvertimePay — rest_day', () => {
  it('1h 用 rest_day first_2h_rate', () => {
    const cfg = { ...config, rest_day_overtime_first_2h_rate: 1.34 };
    const r = calculateOvertimePay(1, 100, cfg, 'rest_day');
    expect(r.amount).toBe(134);
  });
});

describe('calculateOvertimePay — national_holiday', () => {
  it('整段用 holidays.pay_multiplier(2.0)', () => {
    const r = calculateOvertimePay(8, 200, config, 'national_holiday', 2.0);
    expect(r.amount).toBe(8 * 200 * 2.0); // 3200
    expect(r.breakdown.holiday_hours).toBe(8);
    expect(r.breakdown.holiday_rate).toBe(2.0);
  });

  it('沒傳 holidayMultiplier → fallback 2.0', () => {
    const r = calculateOvertimePay(4, 100, config, 'national_holiday');
    expect(r.amount).toBe(800); // 4 × 100 × 2.0
  });

  it('holidayMultiplier 為自訂(例如 company holiday 1.5)', () => {
    const r = calculateOvertimePay(4, 100, config, 'national_holiday', 1.5);
    expect(r.amount).toBe(600);
    expect(r.breakdown.holiday_rate).toBe(1.5);
  });
});

describe('calculateOvertimePay — 邊界', () => {
  it('hours 0 → 0', () => {
    expect(calculateOvertimePay(0, 200, config, 'weekday').amount).toBe(0);
  });
  it('hourlyRate 0 → 0', () => {
    expect(calculateOvertimePay(2, 0, config, 'weekday').amount).toBe(0);
  });
  it('hours 負數視為 0', () => {
    expect(calculateOvertimePay(-1, 200, config, 'weekday').amount).toBe(0);
  });
});

describe('getHourlyRate', () => {
  it('預設 base 240:48000 / 240 = 200', () => {
    expect(getHourlyRate(48000)).toBe(200);
  });
  it('指定 base 176', () => {
    expect(getHourlyRate(35200, 176)).toBe(200);
  });
  it('monthlySalary 0 → 0', () => {
    expect(getHourlyRate(0)).toBe(0);
  });
  it('base 0 → 0', () => {
    expect(getHourlyRate(48000, 0)).toBe(0);
  });
});

describe('pickFrozenPayMultiplier — 申請當下凍結', () => {
  it('national_holiday 用 holidayMultiplier', () => {
    expect(pickFrozenPayMultiplier('national_holiday', config, 2.0)).toBe(2.0);
  });
  it('weekday 用 first_2h_rate', () => {
    expect(pickFrozenPayMultiplier('weekday', config)).toBe(1.34);
  });
  it('rest_day 用 rest_day_first_2h_rate', () => {
    expect(pickFrozenPayMultiplier('rest_day', config)).toBe(1.34);
  });
});

describe('pay_multiplier 凍結:申請當下值不受後來改動影響', () => {
  it('申請時 multiplier=2.0,後來 holidays 表改為 2.5 → 已寫入 row 不變', () => {
    // 模擬申請當下取出 multiplier
    const frozenAtSubmit = pickFrozenPayMultiplier('national_holiday', config, 2.0);
    expect(frozenAtSubmit).toBe(2.0);

    // 後來 holidays 表被 HR 改成 2.5(模擬:重新呼叫但傳入新值)
    // 「凍結」語意:已 frozen 的值不應該被新值取代 — 這是業務層保證,本函式只負責「快照」
    // 所以本測試確認:同樣的輸入永遠回同樣的輸出(純函式)
    const sameQuery = pickFrozenPayMultiplier('national_holiday', config, 2.0);
    expect(sameQuery).toBe(frozenAtSubmit);

    // 用新 multiplier 查詢回新值(代表本函式不 mutate 也不快取)
    const newQuery = pickFrozenPayMultiplier('national_holiday', config, 2.5);
    expect(newQuery).toBe(2.5);

    // 業務層在 overtime_request.pay_multiplier 已存 2.0 → 該欄位之後讀仍為 2.0
    // (此語意由 schema + handler 保證,本 unit test 只驗證函式純度)
  });

  it('weekday 申請時 first_2h_rate=1.34,後來公司改為 1.5 → 已凍結值不變', () => {
    const frozen = pickFrozenPayMultiplier('weekday', config);
    expect(frozen).toBe(1.34);

    const newCfg = { ...config, weekday_overtime_first_2h_rate: 1.5 };
    const newFrozen = pickFrozenPayMultiplier('weekday', newCfg);
    expect(newFrozen).toBe(1.5);
    // 證明:函式查的是「當下傳入的 config」,寫入 row 後 row 的值不會跟著 config 變
    // 凍結語意由 handler 寫入 overtime_requests.pay_multiplier 欄位實現
  });
});
