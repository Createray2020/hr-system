// tests/night-allowance.test.js — computeNightAllowance 純函式測試
// 對應 lib/salary/night-allowance.js
//
// 規則:被認定為夜間班別(night_eligible=true)的班、整段 scheduled_work_minutes × 50/h
//   - night_eligible 由 repo 端解析過(schedule.override ?? shift_types.eligible),
//     本函式只看最終 boolean 結果

import { describe, it, expect } from 'vitest';
import {
  computeNightAllowance,
  NIGHT_ALLOWANCE_PER_HOUR,
} from '../lib/salary/night-allowance.js';

describe('computeNightAllowance — 班別分類 × 50/h', () => {
  it('eligible 1 筆、8h(480 分)→ 400', () => {
    expect(computeNightAllowance([
      { night_eligible: true, scheduled_work_minutes: 480 },
    ])).toBe(400);
  });

  it('not eligible 1 筆、8h → 0', () => {
    expect(computeNightAllowance([
      { night_eligible: false, scheduled_work_minutes: 480 },
    ])).toBe(0);
  });

  it('night_eligible 缺(undefined)→ 視為不領 → 0', () => {
    expect(computeNightAllowance([
      { scheduled_work_minutes: 480 },
    ])).toBe(0);
  });

  it('night_eligible 非 boolean(truthy 但非 true)→ 嚴格不認 → 0', () => {
    // 嚴格 === true 比對、防 schema 漂移帶字串 / 1 等異常值誤判
    expect(computeNightAllowance([
      { night_eligible: 'true', scheduled_work_minutes: 480 },
    ])).toBe(0);
    expect(computeNightAllowance([
      { night_eligible: 1, scheduled_work_minutes: 480 },
    ])).toBe(0);
  });

  it('多筆混合 [t/f/t]:eligible 兩筆相加、not eligible 跳過 → 800', () => {
    expect(computeNightAllowance([
      { night_eligible: true,  scheduled_work_minutes: 480 },
      { night_eligible: false, scheduled_work_minutes: 480 },
      { night_eligible: true,  scheduled_work_minutes: 480 },
    ])).toBe(800);
  });

  it('多段相加(同 eligible):240 + 180 = 420 分 = 7h → 350', () => {
    expect(computeNightAllowance([
      { night_eligible: true, scheduled_work_minutes: 240 },
      { night_eligible: true, scheduled_work_minutes: 180 },
    ])).toBe(350);
  });

  it('不滿整時:eligible 450 分 = 7.5h × 50 → 375', () => {
    expect(computeNightAllowance([
      { night_eligible: true, scheduled_work_minutes: 450 },
    ])).toBe(375);
  });

  it('scheduled_work_minutes 為 null → 不加(視為 0)', () => {
    expect(computeNightAllowance([
      { night_eligible: true, scheduled_work_minutes: null },
    ])).toBe(0);
    // 與正常 eligible 混合、null 不擾亂加總
    expect(computeNightAllowance([
      { night_eligible: true, scheduled_work_minutes: null },
      { night_eligible: true, scheduled_work_minutes: 120 },
    ])).toBe(100);
  });

  it('scheduled_work_minutes 為 undefined → 0', () => {
    expect(computeNightAllowance([
      { night_eligible: true },
    ])).toBe(0);
  });

  it('空陣列 → 0', () => {
    expect(computeNightAllowance([])).toBe(0);
  });

  it('null / undefined 入參 → 0(防呆)', () => {
    expect(computeNightAllowance(null)).toBe(0);
    expect(computeNightAllowance(undefined)).toBe(0);
  });

  it('元素為 null / undefined → 跳過、不爆', () => {
    expect(computeNightAllowance([
      null,
      undefined,
      { night_eligible: true, scheduled_work_minutes: 480 },
    ])).toBe(400);
  });

  it('自訂 perHour 參數生效:60/h × 8h = 480', () => {
    expect(computeNightAllowance(
      [{ night_eligible: true, scheduled_work_minutes: 480 }],
      60,
    )).toBe(480);
  });

  it('自訂 perHour=0 → 全 0(無夜津政策時)', () => {
    expect(computeNightAllowance(
      [{ night_eligible: true, scheduled_work_minutes: 480 }],
      0,
    )).toBe(0);
  });

  it('常數 export 正確', () => {
    expect(NIGHT_ALLOWANCE_PER_HOUR).toBe(50);
  });
});
