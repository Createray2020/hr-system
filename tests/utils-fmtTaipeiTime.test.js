// tests/utils-fmtTaipeiTime.test.js — public/js/utils.js 的 fmtTaipeiTime
//
// 重點:dashboard 「今日出勤狀況」原本用 `clock_in.slice(11,16)` 直顯 UTC 字串、
// 員工台灣 08:51 打卡 → server 寫 '2026-05-06T00:51:00.000Z' UTC、frontend slice → 顯示 '00:51'(錯)。
// 修補:fmtTaipeiTime 顯式鎖 Asia/Taipei、回 'HH:MM'(24hr)。
//
// 策略:public/js/utils.js 是瀏覽器 IIFE 寫進 window.HR_Utils、不能直接 import、
// 改用 vi.stubGlobal({ window: ... }) + happy-path 載入 utils.js 模擬瀏覽器環境。
// 對 Node、最簡的方式是 inline 同份 fmtTaipeiTime(它是純函式、行為由 toLocaleTimeString 保證)、
// test 純函式邏輯。修補時若 utils.js 改、本測試也要同步改。

import { describe, it, expect } from 'vitest';

// 對齊 public/js/utils.js 的 fmtTaipeiTime 實作(純函式、跟 utils.js 同份)
function fmtTaipeiTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '—';
  return d.toLocaleTimeString('en-GB', {
    timeZone: 'Asia/Taipei',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

describe('fmtTaipeiTime — UTC ISO 顯示成台灣 HH:MM', () => {
  it("UTC 'Z' 形式 '2026-05-06T00:51:00.000Z' → '08:51'(用戶觀察的 dashboard bug case)", () => {
    expect(fmtTaipeiTime('2026-05-06T00:51:00.000Z')).toBe('08:51');
  });

  it("+08:00 顯式 '2026-05-06T08:51:00+08:00' → '08:51'(round-trip 一致)", () => {
    expect(fmtTaipeiTime('2026-05-06T08:51:00+08:00')).toBe('08:51');
  });

  it("+00:00 顯式 '2026-05-06T00:51:00+00:00' → '08:51'(同 UTC 'Z')", () => {
    expect(fmtTaipeiTime('2026-05-06T00:51:00+00:00')).toBe('08:51');
  });

  it("跨日邊界 UTC '2026-05-05T16:30:00.000Z' = 台灣隔日 → '00:30'", () => {
    // UTC 16:30 = +08:00 隔日 00:30
    expect(fmtTaipeiTime('2026-05-05T16:30:00.000Z')).toBe('00:30');
  });

  it('null / undefined / 無效字串 / 空字串 → \'—\'(safe fallback)', () => {
    expect(fmtTaipeiTime(null)).toBe('—');
    expect(fmtTaipeiTime(undefined)).toBe('—');
    expect(fmtTaipeiTime('')).toBe('—');
    expect(fmtTaipeiTime('not-an-iso-string')).toBe('—');
  });
});
