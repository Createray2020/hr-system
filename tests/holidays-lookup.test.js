import { describe, it, expect, vi } from 'vitest';
import { getHolidayInfo } from '../lib/holidays/lookup.js';

describe('getHolidayInfo', () => {
  it('repo 缺 findHolidayByDate 時 throw', async () => {
    await expect(getHolidayInfo({}, '2026-01-01')).rejects.toThrow(/findHolidayByDate/);
    await expect(getHolidayInfo(null, '2026-01-01')).rejects.toThrow(/findHolidayByDate/);
  });

  it('date 為空時直接回 isHoliday:false', async () => {
    const repo = { findHolidayByDate: vi.fn() };
    expect(await getHolidayInfo(repo, null)).toEqual({ isHoliday: false });
    expect(await getHolidayInfo(repo, '')).toEqual({ isHoliday: false });
    expect(repo.findHolidayByDate).not.toHaveBeenCalled();
  });

  it('找不到 → isHoliday:false', async () => {
    const repo = { findHolidayByDate: vi.fn().mockResolvedValue(null) };
    const result = await getHolidayInfo(repo, '2026-04-25');
    expect(result).toEqual({ isHoliday: false });
    expect(repo.findHolidayByDate).toHaveBeenCalledWith('2026-04-25');
  });

  it('national holiday 回完整資訊', async () => {
    const repo = {
      findHolidayByDate: vi.fn().mockResolvedValue({
        id: 42,
        holiday_type: 'national',
        pay_multiplier: 2.00,
      }),
    };
    const result = await getHolidayInfo(repo, '2026-01-01');
    expect(result).toEqual({
      isHoliday: true,
      holiday_type: 'national',
      pay_multiplier: 2.00,
      holiday_id: 42,
    });
  });

  it('makeup_workday 回 multiplier 1.00', async () => {
    const repo = {
      findHolidayByDate: vi.fn().mockResolvedValue({
        id: 7,
        holiday_type: 'makeup_workday',
        pay_multiplier: 1.00,
      }),
    };
    const result = await getHolidayInfo(repo, '2026-02-07');
    expect(result.isHoliday).toBe(true);
    expect(result.holiday_type).toBe('makeup_workday');
    expect(result.pay_multiplier).toBe(1.00);
  });

  it('pay_multiplier 字串轉數字（DB 可能回 string）', async () => {
    const repo = {
      findHolidayByDate: vi.fn().mockResolvedValue({
        id: 1,
        holiday_type: 'national',
        pay_multiplier: '2.00',  // 模擬 NUMERIC 回傳字串
      }),
    };
    const result = await getHolidayInfo(repo, '2026-01-01');
    expect(result.pay_multiplier).toBe(2.00);
    expect(typeof result.pay_multiplier).toBe('number');
  });
});
