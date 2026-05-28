// tests/change-password-validation.test.js — change-password component 純函式
//
// 對應 public/js/change-password-modal.js::validateChangePasswordInput
// 規則對齊 employee-profile.html L236-238 既有行為(順序:空檢查 → 一致性 → 長度):
//   1) 任一欄位 falsy(空字串 / null / undefined)→ '請填寫所有欄位'
//   2) newPw !== confirm                            → '新密碼與確認密碼不一致'
//   3) newPw.length < 6                              → '新密碼至少需要 6 個字元'
//   4) 都通過                                        → { ok: true }

import { describe, it, expect } from 'vitest';
import { validateChangePasswordInput } from '../public/js/change-password-modal.js';

describe('validateChangePasswordInput — 空欄位', () => {
  it('三欄位全空 → 請填寫所有欄位', () => {
    expect(validateChangePasswordInput({ oldPw: '', newPw: '', confirm: '' })).toEqual({
      ok: false, error: '請填寫所有欄位',
    });
  });

  it('只 oldPw 空 → 請填寫所有欄位', () => {
    expect(validateChangePasswordInput({ oldPw: '', newPw: 'abcdef', confirm: 'abcdef' })).toEqual({
      ok: false, error: '請填寫所有欄位',
    });
  });

  it('只 newPw 空 → 請填寫所有欄位', () => {
    expect(validateChangePasswordInput({ oldPw: 'old1234', newPw: '', confirm: 'abcdef' })).toEqual({
      ok: false, error: '請填寫所有欄位',
    });
  });

  it('只 confirm 空 → 請填寫所有欄位', () => {
    expect(validateChangePasswordInput({ oldPw: 'old1234', newPw: 'abcdef', confirm: '' })).toEqual({
      ok: false, error: '請填寫所有欄位',
    });
  });

  it('null / undefined 欄位 → 請填寫所有欄位', () => {
    expect(validateChangePasswordInput({ oldPw: null, newPw: 'abcdef', confirm: 'abcdef' })).toEqual({
      ok: false, error: '請填寫所有欄位',
    });
    expect(validateChangePasswordInput({ oldPw: 'old1234', newPw: undefined, confirm: 'abcdef' })).toEqual({
      ok: false, error: '請填寫所有欄位',
    });
  });
});

describe('validateChangePasswordInput — 新/確認不一致', () => {
  it('新密碼與確認密碼不一致 → 對應錯誤(空檢查通過、長度足夠)', () => {
    expect(validateChangePasswordInput({ oldPw: 'old1234', newPw: 'abcdef', confirm: 'abcdeg' })).toEqual({
      ok: false, error: '新密碼與確認密碼不一致',
    });
  });

  it('檢查順序:空檢查優先於不一致(空欄位先擋下、不會報「不一致」)', () => {
    expect(validateChangePasswordInput({ oldPw: 'old1234', newPw: 'abc', confirm: '' })).toEqual({
      ok: false, error: '請填寫所有欄位',
    });
  });
});

describe('validateChangePasswordInput — 長度', () => {
  it('newPw < 6 字元 → 對應錯誤(空檢查與一致性都通過)', () => {
    expect(validateChangePasswordInput({ oldPw: 'old1234', newPw: 'abc12', confirm: 'abc12' })).toEqual({
      ok: false, error: '新密碼至少需要 6 個字元',
    });
  });

  it('newPw 剛好 6 字元 + 一致 → ok(邊界)', () => {
    expect(validateChangePasswordInput({ oldPw: 'old1234', newPw: 'abcdef', confirm: 'abcdef' })).toEqual({
      ok: true,
    });
  });

  it('newPw 5 字元(<6)+ 一致 → 長度錯誤(邊界相反)', () => {
    expect(validateChangePasswordInput({ oldPw: 'old1234', newPw: 'abcde', confirm: 'abcde' })).toEqual({
      ok: false, error: '新密碼至少需要 6 個字元',
    });
  });

  it('檢查順序:一致性優先於長度(不一致先擋下、不會報「長度不足」)', () => {
    expect(validateChangePasswordInput({ oldPw: 'old1234', newPw: 'abc', confirm: 'xyz' })).toEqual({
      ok: false, error: '新密碼與確認密碼不一致',
    });
  });
});

describe('validateChangePasswordInput — happy path', () => {
  it('長密碼 + 一致 → ok', () => {
    expect(validateChangePasswordInput({
      oldPw: 'oldsecret', newPw: 'newSuperSecret123', confirm: 'newSuperSecret123',
    })).toEqual({ ok: true });
  });

  it('純數字 6 位 → ok', () => {
    expect(validateChangePasswordInput({ oldPw: '123456', newPw: '654321', confirm: '654321' })).toEqual({
      ok: true,
    });
  });
});
