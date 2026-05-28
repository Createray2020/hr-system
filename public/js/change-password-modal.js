// public/js/change-password-modal.js — 改密碼共用 component(ESM 模組)
//
// 用法(mobile / desktop 通用):
//   <script type="module" src="/js/change-password-modal.js"></script>
//   <button onclick="ChangePassword.open()">🔑 修改密碼</button>
//
// 設計:
//   - 純函式 validateChangePasswordInput 由 commit 1 完成、vitest 測過
//   - init() idempotent:重複呼叫不重複注入 CSS / modal HTML
//   - open() 內部 lazy 呼叫 init()、caller 可省略顯式 init()
//   - submit() 驗證 → 解析 emp_no(async race-safe)→ 呼叫 API → 成功 toast / 失敗紅字
//   - emp_no 取法:
//       1) window.waitForCurrentUser 存在 → await(desktop layout.js 提供;見 commit 4)
//       2) window.currentUser?.emp_no(已載入快速路徑)
//       3) window._empNo(mobile employee-profile.html fallback)
//       4) 都無 → 「無法取得帳號資訊,請重新整理」、不送出
//   - API helper 偵測順序:apiFetch → api → raw fetch
//   - CSS prefix cp-* 避開既有 .pw-*(employee-profile.html commit 3 才會刪舊)
//   - media query:mobile bottom-sheet(≤768px)/ desktop center modal(≥769px)

// ─── 純函式(commit 1 已測,供 vitest import 與內部 submit 共用)────────

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

// ─── CSS / HTML 模板 ─────────────────────────────────────────

const STYLES = `
.cp-modal-bg{display:none;position:fixed;inset:0;background:rgba(0,0,0,.7);backdrop-filter:blur(4px);z-index:200;padding:0}
.cp-modal-bg.open{display:flex}
.cp-modal{background:#181C27;color:#E8EAF0;font-family:'Noto Sans TC',sans-serif;border:0.5px solid rgba(255,255,255,.1);box-sizing:border-box}
.cp-modal-title{font-size:17px;font-weight:700;margin-bottom:20px}
.cp-label{font-size:12px;color:rgba(255,255,255,.4);display:block;margin-bottom:6px}
.cp-input{width:100%;background:rgba(255,255,255,.06);border:0.5px solid rgba(255,255,255,.1);border-radius:10px;padding:12px 14px;font-size:15px;color:#E8EAF0;font-family:'Noto Sans TC',sans-serif;outline:none;-webkit-appearance:none;margin-bottom:12px;transition:border-color .2s;box-sizing:border-box}
.cp-input:focus{border-color:rgba(91,141,239,.5)}
.cp-err{font-size:12px;color:#F87171;margin-bottom:10px;display:none;padding-left:2px}
.cp-err.show{display:block}
.cp-submit{width:100%;padding:14px;background:#5B8DEF;border:none;border-radius:12px;color:#fff;font-size:15px;font-weight:700;font-family:'Noto Sans TC',sans-serif;cursor:pointer;margin-top:4px}
.cp-submit:disabled{opacity:.5;cursor:not-allowed}
.cp-cancel{width:100%;padding:12px;background:transparent;border:none;color:rgba(255,255,255,.4);font-size:14px;font-family:'Noto Sans TC',sans-serif;cursor:pointer;margin-top:6px}
/* mobile bottom-sheet (對齊 employee-profile.html 既有 .pw-modal 風格) */
@media (max-width:768px){
  .cp-modal-bg{align-items:flex-end;justify-content:center}
  .cp-modal{border-radius:20px 20px 0 0;width:100%;max-width:430px;padding:24px 20px 48px}
}
/* desktop center modal */
@media (min-width:769px){
  .cp-modal-bg{align-items:center;justify-content:center}
  .cp-modal{border-radius:14px;width:100%;max-width:380px;padding:28px}
}
`.trim();

const MODAL_HTML = `
<div class="cp-modal-bg" id="cp-modal-bg">
  <div class="cp-modal">
    <div class="cp-modal-title">🔑 修改密碼</div>
    <label class="cp-label">目前密碼</label>
    <input class="cp-input" id="cp-old" type="password" placeholder="目前使用的密碼" autocomplete="current-password">
    <label class="cp-label">新密碼</label>
    <input class="cp-input" id="cp-new" type="password" placeholder="至少 6 個字元" autocomplete="new-password">
    <label class="cp-label">確認新密碼</label>
    <input class="cp-input" id="cp-confirm" type="password" placeholder="再輸入一次新密碼" autocomplete="new-password">
    <div class="cp-err" id="cp-err"></div>
    <button class="cp-submit" id="cp-submit-btn" type="button">確認修改</button>
    <button class="cp-cancel" id="cp-cancel-btn" type="button">取消</button>
  </div>
</div>
`.trim();

// ─── 私有 helper ────────────────────────────────────────────

let initialized = false;

function injectStyles() {
  if (document.getElementById('cp-styles')) return;
  const style = document.createElement('style');
  style.id = 'cp-styles';
  style.textContent = STYLES;
  document.head.appendChild(style);
}

function injectModal() {
  if (document.getElementById('cp-modal-bg')) return;
  const wrap = document.createElement('div');
  wrap.innerHTML = MODAL_HTML;
  document.body.appendChild(wrap.firstElementChild);
}

function bindEvents() {
  document.getElementById('cp-submit-btn').addEventListener('click', submit);
  document.getElementById('cp-cancel-btn').addEventListener('click', close);
  document.getElementById('cp-modal-bg').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) close();
  });
}

function showError(msg) {
  const errEl = document.getElementById('cp-err');
  errEl.textContent = msg;
  errEl.classList.add('show');
}

function clearError() {
  const errEl = document.getElementById('cp-err');
  errEl.textContent = '';
  errEl.classList.remove('show');
}

function showSuccessToast() {
  // 對齊 mobile employee-profile.html L248-252 既有綠 toast 風格(inline、避免 caller 必須有 toast helper)
  const wrap = document.createElement('div');
  wrap.style.cssText = 'position:fixed;top:20px;left:50%;transform:translateX(-50%);background:#1E2333;border:1px solid rgba(74,222,128,.3);border-left:3px solid #4ADE80;border-radius:20px;padding:10px 20px;font-size:13px;color:#4ADE80;z-index:999;white-space:nowrap';
  wrap.textContent = '✅ 密碼已更新，下次登入生效';
  document.body.appendChild(wrap);
  setTimeout(() => wrap.remove(), 3500);
}

/**
 * 解析 emp_no(async race-safe):
 *   1. window.waitForCurrentUser 存在 → await(desktop layout.js 提供)
 *   2. window.currentUser?.emp_no(已載入快速路徑)
 *   3. window._empNo(mobile employee-profile.html fallback)
 *   4. 都無 → null(caller 顯示錯誤)
 */
async function resolveEmpNo() {
  if (typeof window.waitForCurrentUser === 'function') {
    try {
      const u = await window.waitForCurrentUser();
      if (u && u.emp_no) return u.emp_no;
    } catch (_) { /* timeout / reject 落到下面 fallback */ }
  }
  if (window.currentUser && window.currentUser.emp_no) return window.currentUser.emp_no;
  if (window._empNo) return window._empNo;
  return null;
}

/**
 * 呼叫 change-password API。
 *   1. window.apiFetch(mobile employee-profile.html 定義)
 *   2. window.api(desktop layout.js 定義)
 *   3. raw fetch 帶 Authorization(從 window._supabase 取 session)
 * 三層 fallback、不需要 caller 額外帶 token。
 */
async function callChangePasswordAPI(body) {
  const path = '/api/auth?action=change-password';
  const opts = { method: 'POST', body: JSON.stringify(body) };

  if (typeof window.apiFetch === 'function') return window.apiFetch(path, opts);
  if (typeof window.api      === 'function') return window.api(path, opts);

  // raw fetch fallback
  let token = null;
  if (window._supabase && typeof window._supabase.auth?.getSession === 'function') {
    try {
      const { data: { session } } = await window._supabase.auth.getSession();
      token = session?.access_token || null;
    } catch (_) {}
  }
  const apiBase = window.API ?? '';
  const res = await fetch(apiBase + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
    },
    body: opts.body,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `${res.status}`);
  }
  return res.json();
}

async function submit() {
  const oldPw     = document.getElementById('cp-old').value;
  const newPw     = document.getElementById('cp-new').value;
  const confirmPw = document.getElementById('cp-confirm').value;
  const btn       = document.getElementById('cp-submit-btn');

  clearError();

  // 1. 純函式驗證
  const v = validateChangePasswordInput({ oldPw, newPw, confirm: confirmPw });
  if (!v.ok) { showError(v.error); return; }

  // 2. emp_no(async race-safe)
  const empNo = await resolveEmpNo();
  if (!empNo) { showError('無法取得帳號資訊，請重新整理'); return; }

  // 3. API call
  btn.disabled = true;
  const originalText = btn.textContent;
  btn.textContent = '更新中…';
  try {
    await callChangePasswordAPI({
      emp_no: empNo,
      old_password: oldPw,
      new_password: newPw,
    });
    // 4. 成功:close + 綠 toast
    close();
    showSuccessToast();
  } catch (e) {
    // 5. 失敗:.cp-err 紅字、modal 保留不關
    showError(e?.message || '更新失敗');
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
  }
}

// ─── public API ─────────────────────────────────────────────

function init() {
  if (initialized) return;
  if (typeof document === 'undefined') return; // SSR / node test 環境守
  injectStyles();
  injectModal();
  bindEvents();
  initialized = true;
}

function open() {
  init(); // lazy init、首次呼叫才注入,避免 caller 必須 explicit init
  ['cp-old', 'cp-new', 'cp-confirm'].forEach(id => {
    document.getElementById(id).value = '';
  });
  clearError();
  document.getElementById('cp-modal-bg').classList.add('open');
}

function close() {
  const bg = document.getElementById('cp-modal-bg');
  if (bg) bg.classList.remove('open');
}

// ─── 對 window 暴露(只在 browser 環境、避開 vitest node env 報錯)──

if (typeof window !== 'undefined') {
  window.ChangePassword = { init, open, close };
}
