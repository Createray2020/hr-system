// tests/schedule-finalize-auth.test.js — 時間閘門純函式 spec
//
// 對齊 lib/schedule/finalize-auth.js 兩個函式:
//   - computeForceWindows(period) → { managerForceFrom, ceoForceFrom }
//   - forceFinalizeAuth({ caller, period, employeeDeptId, now }) → { ok, tier|reason }

import { describe, it, expect } from 'vitest';
import { computeForceWindows, forceFinalizeAuth } from '../lib/schedule/finalize-auth.js';

describe('computeForceWindows', () => {
  it('6 月 period (period_start=2026-06-01) → manager 5/26、ceo 5/31', () => {
    const r = computeForceWindows({ period_start: '2026-06-01' });
    expect(r.managerForceFrom).toBe('2026-05-26');
    expect(r.ceoForceFrom).toBe('2026-05-31');
  });

  it('1 月跨年 period (period_start=2026-01-01) → manager 2025-12-26、ceo 2025-12-31', () => {
    const r = computeForceWindows({ period_start: '2026-01-01' });
    expect(r.managerForceFrom).toBe('2025-12-26');
    expect(r.ceoForceFrom).toBe('2025-12-31');
  });

  it('3 月 period (period_start=2026-03-01) → manager 2026-02-26、ceo 2026-02-28(非閏年)', () => {
    const r = computeForceWindows({ period_start: '2026-03-01' });
    expect(r.managerForceFrom).toBe('2026-02-26');
    expect(r.ceoForceFrom).toBe('2026-02-28');
  });

  it('3 月 period 閏年 (period_start=2024-03-01) → ceo 2024-02-29', () => {
    const r = computeForceWindows({ period_start: '2024-03-01' });
    expect(r.ceoForceFrom).toBe('2024-02-29');
  });

  it('缺欄位 / 格式不對 → null / null,不爆', () => {
    expect(computeForceWindows({}).managerForceFrom).toBeNull();
    expect(computeForceWindows({ period_start: '2026/06/01' }).managerForceFrom).toBeNull();
    expect(computeForceWindows(null).ceoForceFrom).toBeNull();
  });
});

describe('forceFinalizeAuth', () => {
  const period = { period_start: '2026-06-01' };  // → mgr 5/26、ceo 5/31

  const SAME_DEPT_MGR = { id: 'M1', role: 'employee', is_manager: true,  dept_id: 'D1' };
  const OTHER_DEPT_MGR= { id: 'M2', role: 'employee', is_manager: true,  dept_id: 'D2' };
  const NON_MGR_EMP   = { id: 'E1', role: 'employee', is_manager: false, dept_id: 'D1' };
  const CEO_USER      = { id: 'C1', role: 'ceo',      is_manager: false, dept_id: 'DX' };
  const CHAIRMAN      = { id: 'CH', role: 'chairman', is_manager: false, dept_id: 'DX' };
  const ADMIN         = { id: 'A1', role: 'admin',    is_manager: false, dept_id: 'DX' };

  it('manager 5/26 起 + 同部門 → manager_force', () => {
    const r = forceFinalizeAuth({
      caller: SAME_DEPT_MGR, period, employeeDeptId: 'D1', now: '2026-05-26',
    });
    expect(r).toEqual({ ok: true, tier: 'manager_force' });
  });

  it('manager 5/27 起 + 同部門 → manager_force', () => {
    const r = forceFinalizeAuth({
      caller: SAME_DEPT_MGR, period, employeeDeptId: 'D1', now: '2026-05-27',
    });
    expect(r.ok).toBe(true);
    expect(r.tier).toBe('manager_force');
  });

  it('manager 5/25 未到 + 同部門 → BEFORE_WINDOW(角色符合)', () => {
    const r = forceFinalizeAuth({
      caller: SAME_DEPT_MGR, period, employeeDeptId: 'D1', now: '2026-05-25',
    });
    expect(r).toEqual({ ok: false, reason: 'BEFORE_WINDOW' });
  });

  it('跨部門 manager 5/27 → NOT_AUTHORIZED(角色不符)', () => {
    const r = forceFinalizeAuth({
      caller: OTHER_DEPT_MGR, period, employeeDeptId: 'D1', now: '2026-05-27',
    });
    expect(r).toEqual({ ok: false, reason: 'NOT_AUTHORIZED' });
  });

  it('一般員工(非 manager / 非 ceo)5/31 → NOT_AUTHORIZED', () => {
    const r = forceFinalizeAuth({
      caller: NON_MGR_EMP, period, employeeDeptId: 'D1', now: '2026-05-31',
    });
    expect(r).toEqual({ ok: false, reason: 'NOT_AUTHORIZED' });
  });

  it('ceo 5/31 起 → ceo_force(不限部門)', () => {
    const r = forceFinalizeAuth({
      caller: CEO_USER, period, employeeDeptId: 'D1', now: '2026-05-31',
    });
    expect(r).toEqual({ ok: true, tier: 'ceo_force' });
  });

  it('ceo 5/30 未到 → BEFORE_WINDOW', () => {
    const r = forceFinalizeAuth({
      caller: CEO_USER, period, employeeDeptId: 'D1', now: '2026-05-30',
    });
    expect(r).toEqual({ ok: false, reason: 'BEFORE_WINDOW' });
  });

  it('chairman 5/31 → ceo_force', () => {
    const r = forceFinalizeAuth({
      caller: CHAIRMAN, period, employeeDeptId: 'D1', now: '2026-05-31',
    });
    expect(r.ok).toBe(true);
    expect(r.tier).toBe('ceo_force');
  });

  it('admin 6/1 → ceo_force', () => {
    const r = forceFinalizeAuth({
      caller: ADMIN, period, employeeDeptId: 'D1', now: '2026-06-01',
    });
    expect(r.ok).toBe(true);
    expect(r.tier).toBe('ceo_force');
  });

  it('既是同部門 manager 又到 manager 窗口 → 先 hit manager_force', () => {
    // SAME_DEPT_MGR 5/26 進 mgr 窗口、但還沒到 ceo 窗口(5/31)、tier 應該是 manager_force
    const r = forceFinalizeAuth({
      caller: SAME_DEPT_MGR, period, employeeDeptId: 'D1', now: '2026-05-26',
    });
    expect(r.tier).toBe('manager_force');
  });

  it('caller=null / period=null / now=null → NOT_AUTHORIZED 不爆', () => {
    expect(forceFinalizeAuth({ caller: null, period, employeeDeptId: 'D1', now: '2026-05-31' }))
      .toEqual({ ok: false, reason: 'NOT_AUTHORIZED' });
    expect(forceFinalizeAuth({ caller: CEO_USER, period: null, employeeDeptId: 'D1', now: '2026-05-31' }))
      .toEqual({ ok: false, reason: 'NOT_AUTHORIZED' });
    expect(forceFinalizeAuth({ caller: CEO_USER, period, employeeDeptId: 'D1', now: null }))
      .toEqual({ ok: false, reason: 'NOT_AUTHORIZED' });
  });
});
