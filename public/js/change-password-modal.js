// public/js/change-password-modal.js — 改密碼共用 component
//
// commit 1:只 export validateChangePasswordInput 純函式(供 vitest 與 component 共用)
// commit 2 將加上 init / open / close + modal HTML / CSS 注入 + submit + window.ChangePassword
//
// 規則順序(對齊 employee-profile.html L236-238 既有行為):
//   1) 任一欄位 falsy(空字串 / null / undefined)→ '請填寫所有欄位'
//   2) newPw !== confirm                          → '新密碼與確認密碼不一致'
//   3) newPw.length < 6                            → '新密碼至少需要 6 個字元'
//   4) 都通過                                      → { ok: true }
//
// 對應測試:tests/change-password-validation.test.js

/**
 * @param {{ oldPw?: string, newPw?: string, confirm?: string }} input
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
export function validateChangePasswordInput({ oldPw, newPw, confirm } = {}) {
  if (!oldPw || !newPw || !confirm) {
    return { ok: false, error: '請填寫所有欄位' };
  }
  if (newPw !== confirm) {
    return { ok: false, error: '新密碼與確認密碼不一致' };
  }
  if (newPw.length < 6) {
    return { ok: false, error: '新密碼至少需要 6 個字元' };
  }
  return { ok: true };
}
