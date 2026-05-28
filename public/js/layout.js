// public/js/layout.js — 動態注入 Sidebar 和初始化 Auth
//
// 階段 4.5:31 項扁平 sidebar → 6 群組 hover-expand。
// 純 builder 邏輯在 public/js/sidebar/builder.js (vitest 抓行為)、本檔負責:
//   - Tabler icon CSS 注入(若未載入)
//   - Auth + api helper init
//   - sidebar HTML 注入 + hover-expand event 綁定
//   - 使用者卡片 + 手機版切換按鈕 + unread badge

(async function() {
  const SUPABASE_URL      = 'https://scsgqxixmbompnoypuuw.supabase.co';
  const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNjc2dxeGl4bWJvbXBub3lwdXV3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY0MzkxODMsImV4cCI6MjA5MjAxNTE4M30.DRuX4OoQDQSQfvqb71VgSmDysli7e_w8lvsdp3p_VA8';
  const _sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  window._supabase = _sb;

  // Auth guard
  const { data: { session } } = await _sb.auth.getSession();
  if (!session) { window.location.href = '/login.html'; return; }

  // API base
  window.API = (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
    ? 'http://localhost:3000' : '';

  // API helper (帶 JWT)
  window.api = async (path, opts = {}) => {
    const { data: { session: s } } = await _sb.auth.getSession();
    const res = await fetch(window.API + path, {
      headers: { 'Content-Type':'application/json', ...(s ? {'Authorization':`Bearer ${s.access_token}`} : {}) },
      ...opts
    });
    if (!res.ok) { const e = await res.json().catch(()=>({})); throw new Error(e.error||`${res.status}`); }
    return res.json();
  };

  window.logout = async () => {
    await _sb.auth.signOut();
    localStorage.removeItem('preferred_version');
    location.href = '/login.html';
  };

  window.switchToMobile = () => {
    localStorage.setItem('preferred_version', 'mobile');
    location.href = '/employee-app.html';
  };

  // 注入 Tabler icon CSS(只注入一次、避免重複 link)
  if (!document.querySelector('link[href*="tabler-icons"]')) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'https://cdnjs.cloudflare.com/ajax/libs/tabler-icons/3.35.0/tabler-icons.min.css';
    document.head.appendChild(link);
  }

  // 取得目前登入員工資料
  let currentUser = null;
  try {
    const data = await window.api(`/api/employees/me`);
    currentUser = data;
    window.currentUser = data;
  } catch(e) { console.warn('無法取得使用者資料', e); }

  // 暴露 waitForCurrentUser 給共用 component 用(對齊各 desktop 頁既有 local helper 行為)。
  // 此處 layout.js 已 await /api/employees/me、window.currentUser 已寫入,因此呼叫立即回值;
  // fetch 失敗時輪詢 5 秒、仍無 → return null。
  // public/js/change-password-modal.js::resolveEmpNo() 第 1 順位會 await 它。
  window.waitForCurrentUser = async (maxMs = 5000) => {
    const step = 100;
    for (let i = 0; i < maxMs / step; i++) {
      if (window.currentUser) return window.currentUser;
      await new Promise(r => setTimeout(r, step));
    }
    return null;
  };

  // 載入改密碼 component(dynamic import,對齊既有 sidebar builder L77 pattern)。
  // 載入完成後 window.ChangePassword = { init, open, close } ready、
  // sidebar 注入按鈕時 onclick="ChangePassword.open()" 即可使用、無 race。
  // 失敗不擋 layout(改密碼不能用是 graceful degradation、不該擋整個 sidebar)。
  try {
    await import('/js/change-password-modal.js');
  } catch(e) { console.warn('改密碼 component 載入失敗', e); }

  // 角色 gate(對齊 lib/roles.js + public/js/roles.js)
  const isHRish     = u => !!u && ['hr','admin','ceo','chairman'].includes(u.role);
  const isMgrOrHR   = u => !!u && (u.is_manager === true || ['hr','admin','ceo','chairman'].includes(u.role));
  const isMgrOrCEO  = u => !!u && (u.is_manager === true || ['ceo','chairman'].includes(u.role));
  const gates = {
    isHRish, isMgrOrHR, isMgrOrCEO,
    isBackofficeRole:        u => window.Roles?.isBackofficeRole(u),
    canManageAnnouncements:  u => window.Roles?.canManageAnnouncements(u),
  };

  const sidebar = document.getElementById('sidebar');
  if (!sidebar) return;

  // 動態 import sidebar builder(對齊 insurance.html 的 dynamic import pattern)
  const { getNavGroups, buildSidebarNav, attachSidebarInteractions } =
    await import('/js/sidebar/builder.js');
  const navGroups = getNavGroups(gates);
  const navHTML = buildSidebarNav(navGroups, currentUser, location.pathname);

  const userName = currentUser?.name || session.user.email.split('@')[0];
  const userRole = currentUser?.role === 'chairman' ? '董事長'
                 : currentUser?.role === 'ceo'      ? '執行長'
                 : currentUser?.role === 'admin'    ? '系統管理員'
                 : currentUser?.role === 'hr'       ? '人資專員'
                 : currentUser?.is_manager          ? '部門主管'
                 : '員工';
  const avatarChar = currentUser?.avatar || userName[0];

  sidebar.innerHTML = `
    <div class="drawer-header">
      <button class="close-btn" aria-label="關閉選單"><i class="ti ti-x"></i></button>
      <span class="drawer-title">選單</span>
    </div>
    <div class="logo">
      <div class="logo-mark">HR · SYSTEM</div>
      <div class="logo-title">人資管理平台</div>
    </div>
    <nav class="nav">
      ${navHTML}
    </nav>
    <div class="sidebar-user">
      <div class="avatar-sm" title="點擊登出" onclick="logout()">${avatarChar}</div>
      <div class="user-info">
        <div class="name">${userName}</div>
        <div class="role">${userRole}</div>
      </div>
      <button class="change-pw-btn" onclick="ChangePassword.open()" title="修改密碼"
        style="margin-left:auto;background:transparent;border:1px solid var(--border);color:var(--text-dim);width:32px;height:32px;border-radius:8px;cursor:pointer;font-size:16px;flex-shrink:0;display:flex;align-items:center;justify-content:center;padding:0">🔑</button>
      ${isMgrOrHR(currentUser) ? `
      <button class="switch-mobile-btn" onclick="switchToMobile()" title="切換到手機版"
        style="margin-left:6px;background:transparent;border:1px solid var(--border);color:var(--text-dim);width:32px;height:32px;border-radius:8px;cursor:pointer;font-size:16px;flex-shrink:0;display:flex;align-items:center;justify-content:center;padding:0">📱</button>` : ''}
    </div>`;

  // 階段 4.5.2:mobile drawer 模式 — 注入 header / mask
  // (desktop CSS @media (min-width: 769px) hide、不影響桌機)
  if (!document.querySelector('.app-mobile-header')) {
    const mh = document.createElement('div');
    mh.className = 'app-mobile-header';
    mh.innerHTML = `
      <button class="hamburger-btn" aria-label="開啟選單"><i class="ti ti-menu-2"></i></button>
      <span class="app-mobile-title">人資管理平台</span>
    `;
    document.body.insertBefore(mh, document.body.firstChild);
  }
  if (!document.querySelector('.sidebar-mask')) {
    const mask = document.createElement('div');
    mask.className = 'sidebar-mask';
    document.body.appendChild(mask);
  }

  // ── group expand/collapse 事件綁定 (階段 4.5.1) ──────────────
  // 偵測 hover 能力:desktop 用 hover、touch (mobile / tablet / no hover)
  // 用 click toggle 走手風琴、避免 sidebar 在手機完全點不開。
  // 詳:public/js/sidebar/builder.js attachSidebarInteractions
  const supportsHover = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  attachSidebarInteractions(sidebar, { supportsHover });

  // 載入未讀通知數量
  if (currentUser?.id) {
    try {
      const { data: unread, error } = await _sb
        .from('notifications')
        .select('id')
        .eq('employee_id', currentUser.id)
        .eq('is_read', false);
      if (!error) {
        window.PWA?.updateBadge(unread?.length || 0);
        const badge = document.getElementById('notif-badge');
        const cnt = unread?.length || 0;
        if (badge && cnt > 0) {
          badge.textContent = cnt > 99 ? '99+' : String(cnt);
          badge.style.display = '';
        }
      }
    } catch(_) {}
  }
})();
