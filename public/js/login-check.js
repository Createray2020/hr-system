// public/js/login-check.js — 登入前置檢查工具(掛在 window.LoginCheck)
// 對齊 /js/roles.js 全域 pattern、由 login.html 載入(<script src=...>)。
// 同檔給 vitest happy-dom 環境 import 後讀 window.LoginCheck 直接驗。
(function () {
  /**
   * B7 / A2 邏輯:離職員工登入守門。
   *   - status !== 'resigned'        → 不擋(active / suspended 等)
   *   - status === 'resigned' 且
   *     · resigned_at 為 null/空     → 擋(safe fallback、視同已生效)
   *     · resigned_at <= now         → 擋(預計離職日已到)
   *     · resigned_at > now          → 不擋(預計離職日未到、員工仍可登入)
   *
   * 與 B7 cascade 配對:approve 時 employees.resigned_at 寫成 form_data.resign_date
   * 的 +08:00 ISO(可能是未來日),login 在預計離職日當下才生效。
   *
   * @param {{ status?: string, resigned_at?: string|null }} emp
   * @param {Date} [now] 注入給 unit test 用、prod 預設 new Date()
   * @returns {boolean}  true=擋下登入、false=放行
   */
  function shouldBlockResignedLogin(emp, now) {
    if (!emp) return false;
    if (emp.status !== 'resigned') return false;
    if (!emp.resigned_at) return true;
    const cmp = now || new Date();
    return new Date(emp.resigned_at) <= cmp;
  }

  window.LoginCheck = { shouldBlockResignedLogin };
})();
