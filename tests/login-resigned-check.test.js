// tests/login-resigned-check.test.js — B7 A2:離職員工登入守門邏輯
//
// 對應實作:public/js/login-check.js + public/login.html:188
// 重點:resigned_at 是「預計離職日」、可能是未來日;真正擋登入要等該日期到了才生效

// @vitest-environment happy-dom
import { describe, it, expect, beforeAll } from 'vitest';

beforeAll(async () => {
  await import('../public/js/login-check.js');
});

describe('LoginCheck.shouldBlockResignedLogin (B7 A2 邏輯)', () => {
  const now = new Date('2026-05-26T10:00:00+08:00');

  it('status=resigned + resigned_at 過去日 → block', () => {
    const emp = { status: 'resigned', resigned_at: '2026-05-14T00:00:00+08:00' };
    expect(window.LoginCheck.shouldBlockResignedLogin(emp, now)).toBe(true);
  });

  it('status=resigned + resigned_at 未來日 → 允許登入(預計離職日未到、A2 邏輯)', () => {
    const emp = { status: 'resigned', resigned_at: '2026-05-31T00:00:00+08:00' };
    expect(window.LoginCheck.shouldBlockResignedLogin(emp, now)).toBe(false);
  });

  it('status=resigned + resigned_at NULL → block(fallback、視同已生效)', () => {
    const emp = { status: 'resigned', resigned_at: null };
    expect(window.LoginCheck.shouldBlockResignedLogin(emp, now)).toBe(true);
  });

  it('status=active → 不擋', () => {
    const emp = { status: 'active', resigned_at: null };
    expect(window.LoginCheck.shouldBlockResignedLogin(emp, now)).toBe(false);
  });

  it('emp=null → 不擋(讓上層自己處理 not-found)', () => {
    expect(window.LoginCheck.shouldBlockResignedLogin(null, now)).toBe(false);
  });

  it('沒傳 now → 預設用 new Date()、跟 prod 一致', () => {
    const emp = { status: 'resigned', resigned_at: '2000-01-01T00:00:00+08:00' };
    expect(window.LoginCheck.shouldBlockResignedLogin(emp)).toBe(true);
  });
});
