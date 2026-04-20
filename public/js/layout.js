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
  const navGroups = [
    {
      title: '總覽',
      items: [
        { page:'dashboard', icon:'🏠', label:'總覽',   href:'/dashboard.html' },
        { page:'calendar',  icon:'📅', label:'行事曆', href:'/calendar.html' },
      ]
    },
    {
      title: '人員管理',
      items: [
        { page:'employees',   icon:'👥', label:'員工資料', href:'/employees.html' },
        { page:'orgchart',    icon:'🗂️', label:'組織圖',   href:'/orgchart.html' },
        { page:'departments', icon:'🏢', label:'部門管理',   href:'/departments.html' },
      ]
    },
    {
      title: '勤務管理',
      items: [
        { page:'leave',      icon:'📋', label:'請假審批', href:'/leave.html' },
        { page:'attendance', icon:'⏱️', label:'出勤管理', href:'/attendance.html' },
        { page:'schedule',   icon:'🗓️', label:'排班管理', href:'/schedule.html' },
      ]
    },
    {
      title: '薪資管理',
      items: [
        { page:'salary',    icon:'💰', label:'薪資管理', href:'/salary.html' },
        { page:'insurance', icon:'🏥', label:'勞健保',   href:'/insurance.html' },
      ]
    },
  ];

  const sidebar = document.getElementById('sidebar');
  if (!sidebar) return;

  const userName = currentUser?.name || session.user.email.split('@')[0];
  const userRole = currentUser?.role === 'manager' ? '部門主管'
                 : currentUser?.role === 'hr'      ? '人資專員'
                 : currentUser?.role === 'admin'   ? '系統管理員'
                 : '員工';
  const avatarChar = currentUser?.avatar || userName[0];

  const navHTML = navGroups.map(g => `
    <div class="nav-section">
      <div class="nav-section-title">${g.title}</div>
      ${g.items.map(n => `
        <a class="nav-item ${page === n.page ? 'active' : ''}" href="${n.href}">
          <span class="nav-icon">${n.icon}</span> ${n.label}
        </a>`).join('')}
    </div>`).join('');

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
})();
