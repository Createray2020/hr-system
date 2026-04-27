// public/js/layout.js — 動態注入 Sidebar 和初始化 Auth
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

  window.logout = async () => { await _sb.auth.signOut(); location.href = '/login.html'; };

  // 取得目前登入員工資料
  let currentUser = null;
  try {
    const data = await window.api(`/api/employees/me`);
    currentUser = data;
    window.currentUser = data;
  } catch(e) { console.warn('無法取得使用者資料', e); }

  // 注入 Sidebar
  const page = document.body.dataset.page || '';
  const isHRish     = u => !!u && ['hr','admin','ceo','chairman'].includes(u.role);
  const isMgrOrHR   = u => !!u && (u.is_manager === true || ['hr','admin','ceo','chairman'].includes(u.role));
  const isMgrOrCEO  = u => !!u && (u.is_manager === true || ['ceo','chairman'].includes(u.role));
  const navGroups = [
    {
      title: '總覽',
      items: [
        { page:'dashboard',     icon:'🏠', label:'總覽',   href:'/dashboard.html' },
        { page:'calendar',      icon:'📅', label:'行事曆', href:'/calendar.html' },
        { page:'announcements', icon:'📢', label:'公告欄', href:'/announcements.html' },
      ]
    },
    {
      title: '人員管理',
      items: [
        { page:'employees',          icon:'👥', label:'員工資料', href:'/employees.html', gate: u => window.Roles?.isBackofficeRole(u) },
        { page:'orgchart',           icon:'🗂️', label:'組織圖',   href:'/orgchart.html' },
        { page:'departments',        icon:'🏢', label:'部門管理', href:'/departments.html' },
        { page:'announcement-admin', icon:'📝', label:'公告管理', href:'/announcement-admin.html', gate: u => window.Roles?.canManageAnnouncements(u) },
      ]
    },
    {
      title: '我的勤務',
      items: [
        { page:'attendance',        icon:'⏱️', label:'打卡',     href:'/attendance.html' },
        { page:'employee-schedule', icon:'🗓️', label:'我的排班', href:'/employee-schedule.html' },
        { page:'leave',             icon:'📋', label:'請假',     href:'/leave.html' },
        { page:'comp-time',         icon:'🌴', label:'補休',     href:'/comp-time.html' },
        { page:'overtime',          icon:'⏰', label:'加班申請', href:'/overtime.html' },
      ]
    },
    {
      title: '勤務管理',
      items: [
        { page:'leave-admin',              icon:'✅', label:'請假審批',     href:'/leave-admin.html',              gate: isMgrOrHR },
        { page:'schedule',                 icon:'📆', label:'排班管理',     href:'/schedule.html',                  gate: isMgrOrHR },
        { page:'overtime-review',          icon:'👔', label:'加班審核',     href:'/overtime-review.html',          gate: isMgrOrCEO },
        { page:'attendance-admin',         icon:'🛠️', label:'打卡管理',     href:'/attendance-admin.html',         gate: isHRish },
        { page:'annual-leave-admin',       icon:'🏖️', label:'特休管理',     href:'/annual-leave-admin.html',       gate: isHRish },
        { page:'comp-time-admin',          icon:'🌅', label:'補休管理',     href:'/comp-time-admin.html',          gate: isHRish },
        { page:'overtime-admin',           icon:'⚙️', label:'加班管理',     href:'/overtime-admin.html',           gate: isHRish },
        { page:'attendance-penalty-admin', icon:'⚖️', label:'出勤獎懲後台', href:'/attendance-penalty-admin.html', gate: isHRish },
        { page:'holidays-admin',           icon:'🎌', label:'假日管理',     href:'/holidays-admin.html',           gate: isHRish },
      ]
    },
    {
      title: '薪資管理',
      items: [
        { page:'employee-salary', icon:'💵', label:'我的薪資', href:'/employee-salary.html' },
        { page:'salary',          icon:'💰', label:'薪資管理', href:'/salary.html', gate: isHRish },
        { page:'insurance',       icon:'🏥', label:'勞健保',   href:'/insurance.html' },
      ]
    },
    {
      title: '行政管理',
      items: [
        { page:'approvals',      icon:'✅', label:'審批管理',  href:'/approvals.html' },
        { page:'notifications',  icon:'🔔', label:'通知中心',  href:'/notifications.html' },
      ]
    },
  ];

  const sidebar = document.getElementById('sidebar');
  if (!sidebar) return;

  const userName = currentUser?.name || session.user.email.split('@')[0];
  const userRole = currentUser?.role === 'chairman' ? '董事長'
                 : currentUser?.role === 'ceo'      ? '執行長'
                 : currentUser?.role === 'admin'    ? '系統管理員'
                 : currentUser?.role === 'hr'       ? '人資專員'
                 : currentUser?.is_manager          ? '部門主管'
                 : '員工';
  const avatarChar = currentUser?.avatar || userName[0];

  const isAdmin = window.Roles?.canAccessBackoffice(currentUser);
  const visibleItem = n => {
    if (typeof n.gate === 'function') return n.gate(currentUser);
    if (n.adminOnly) return isAdmin;
    return true;
  };
  const navHTML = navGroups.map(g => {
    const visible = g.items.filter(visibleItem);
    if (visible.length === 0) return '';
    return `
    <div class="nav-section">
      <div class="nav-section-title">${g.title}</div>
      ${visible.map(n => `
        <a class="nav-item ${page === n.page ? 'active' : ''}" href="${n.href}">
          <span class="nav-icon">${n.icon}</span> ${n.label}
          ${n.page === 'notifications' ? `<span id="notif-badge" style="display:none;margin-left:auto;background:#F87171;color:#fff;border-radius:10px;min-width:18px;height:18px;font-size:10px;font-weight:700;display:flex;align-items:center;justify-content:center;padding:0 4px"></span>` : ''}
        </a>`).join('')}
    </div>`;
  }).join('');

  sidebar.innerHTML = `
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
    </div>`;

  // 載入未讀通知數量
  if (currentUser?.id) {
    try {
      const { data: unread, error } = await _sb
        .from('notifications')
        .select('id')
        .eq('employee_id', currentUser.id)
        .eq('is_read', false);
      if (!error) window.PWA?.updateBadge(unread?.length || 0);
    } catch(_) {}
  }
})();
