// public/js/sidebar/builder.js — 純函式 sidebar HTML builder
//
// 用途:layout.js 動態 import、vitest 直接 import 測純行為。
// 對齊既有 lib pattern (lib/insurance/excel-builder.js / lib/leave/overlay.js)。
//
// 架構:
//   - getNavGroups(gates) → 6 個 group template、含 header icon + items
//   - filterVisibleGroups(groups, currentUser) → 過濾 gate、空 group 自動拿掉
//   - findExpandedGroupIdx(visibleGroups, pathname) → 當前頁所在 group idx (找不到回 -1)
//   - buildNavHTML(visibleGroups, expandedIdx, pathname) → 全 nav 區 HTML 字串
//   - buildSidebarNav(...) → 一站式入口 (filter + expand + html)
//
// gate 函式由 caller 傳入(layout.js 用真的、test 用 fake)。
// 預設 gate = undefined → 視為全員可見。

/**
 * @param {Object} gates - { isHRish, isMgrOrHR, isMgrOrCEO, isBackofficeRole, canManageAnnouncements }
 * @returns {Array<Group>}
 */
export function getNavGroups(gates = {}) {
  const { isHRish, isMgrOrHR, isMgrOrCEO, isBackofficeRole, canManageAnnouncements } = gates;
  return [
    {
      title: '我的工作區',
      headerIcon: 'ti-user-circle',
      items: [
        { page:'attendance',         icon:'ti-clock',           label:'打卡',     href:'/attendance.html' },
        { page:'employee-schedule',  icon:'ti-calendar-event',  label:'我的排班', href:'/employee-schedule.html' },
        { page:'employee-salary',    icon:'ti-cash',            label:'我的薪資', href:'/employee-salary.html' },
        { page:'leave',              icon:'ti-clipboard-text',  label:'請假',     href:'/leave.html' },
        { page:'comp-time',          icon:'ti-palm-tree',       label:'補休',     href:'/comp-time.html' },
        { page:'overtime',           icon:'ti-alarm-plus',      label:'加班申請', href:'/overtime.html' },
      ],
    },
    {
      title: '資訊中心',
      headerIcon: 'ti-layout-dashboard',
      items: [
        { page:'dashboard',          icon:'ti-home',            label:'總覽',     href:'/dashboard.html',          gate: isMgrOrHR },
        { page:'calendar',           icon:'ti-calendar',        label:'行事曆',   href:'/calendar.html' },
        { page:'announcements',      icon:'ti-speakerphone',    label:'公告欄',   href:'/announcements.html',      gate: isMgrOrHR },
        { page:'announcement-admin', icon:'ti-edit',            label:'公告管理', href:'/announcement-admin.html', gate: canManageAnnouncements },
        { page:'notifications',      icon:'ti-bell',            label:'通知中心', href:'/notifications.html' },
        { page:'approvals',          icon:'ti-checks',          label:'審批管理', href:'/approvals.html',          gate: isHRish },
      ],
    },
    {
      title: '員工管理',
      headerIcon: 'ti-users',
      items: [
        { page:'employees',          icon:'ti-user',            label:'員工資料',     href:'/employees.html',          gate: isBackofficeRole },
        { page:'orgchart',           icon:'ti-sitemap',         label:'組織圖',       href:'/orgchart.html',           gate: isMgrOrHR },
        { page:'departments',        icon:'ti-building',        label:'部門管理',     href:'/departments.html',        gate: isHRish },
        { page:'resigned-archive',   icon:'ti-archive',         label:'離職員工檔案', href:'/resigned-archive.html',   gate: isHRish },
      ],
    },
    {
      title: '班表 & 出勤',
      headerIcon: 'ti-calendar-stats',
      items: [
        { page:'schedule',                   icon:'ti-template',        label:'排班管理', href:'/schedule.html',                  gate: isMgrOrHR },
        { page:'schedule-templates',         icon:'ti-layout-list',     label:'班表範本', href:'/schedule-templates.html',        gate: isMgrOrHR },
        { page:'shift-types-admin',          icon:'ti-palette',         label:'班別管理', href:'/shift-types-admin.html',         gate: isHRish },
        { page:'holidays-admin',             icon:'ti-flag',            label:'假日管理', href:'/holidays-admin.html',            gate: isHRish },
        { page:'attendance-admin',           icon:'ti-device-watch',    label:'打卡管理', href:'/attendance-admin.html',          gate: isHRish },
        { page:'attendance-locations-admin', icon:'ti-map-pin',         label:'據點管理', href:'/attendance-locations-admin.html', gate: isHRish },
      ],
    },
    {
      title: '假勤管理',
      headerIcon: 'ti-clipboard-check',
      items: [
        { page:'leave-admin',              icon:'ti-checkbox',     label:'請假審批', href:'/leave-admin.html',              gate: isMgrOrHR },
        { page:'overtime-review',          icon:'ti-user-check',   label:'加班審核', href:'/overtime-review.html',          gate: isMgrOrCEO },
        { page:'annual-leave-admin',       icon:'ti-umbrella',     label:'特休管理', href:'/annual-leave-admin.html',       gate: isHRish },
        { page:'comp-time-admin',          icon:'ti-sun',          label:'補休管理', href:'/comp-time-admin.html',          gate: isHRish },
        { page:'overtime-admin',           icon:'ti-settings',     label:'加班管理', href:'/overtime-admin.html',           gate: isHRish },
        { page:'attendance-penalty-admin', icon:'ti-scale',        label:'出勤獎懲', href:'/attendance-penalty-admin.html', gate: isHRish },
      ],
    },
    {
      title: '薪資',
      headerIcon: 'ti-coin',
      items: [
        { page:'salary',         icon:'ti-receipt',          label:'薪資管理', href:'/salary.html',         gate: isHRish },
        { page:'salary-period',  icon:'ti-calendar-dollar',  label:'薪資期間', href:'/salary-period.html',  gate: isHRish },
        { page:'insurance',      icon:'ti-shield-check',     label:'勞健保',   href:'/insurance.html',      gate: isHRish },
      ],
    },
  ];
}

/**
 * 過濾每個 group 的 items by gate;空 group 整個拿掉。
 * @param {Array} groups
 * @param {Object} currentUser
 * @returns {Array}
 */
export function filterVisibleGroups(groups, currentUser) {
  return (groups || [])
    .map(g => ({ ...g, items: (g.items || []).filter(it => !it.gate || it.gate(currentUser)) }))
    .filter(g => g.items.length > 0);
}

/**
 * 找 pathname 對應的 group 在 visibleGroups 的 index。找不到回 -1。
 * @param {Array} visibleGroups
 * @param {string} pathname
 * @returns {number}
 */
export function findExpandedGroupIdx(visibleGroups, pathname) {
  for (let i = 0; i < (visibleGroups || []).length; i++) {
    if ((visibleGroups[i].items || []).some(it => it.href === pathname)) return i;
  }
  return -1;
}

/**
 * 生 nav HTML 字串。
 * @param {Array} visibleGroups
 * @param {number} expandedIdx
 * @param {string} pathname
 * @returns {string}
 */
export function buildNavHTML(visibleGroups, expandedIdx, pathname) {
  return (visibleGroups || []).map((g, gi) => {
    const expanded = gi === expandedIdx;
    const itemsHTML = g.items.map(it => `
      <a class="nav-item${pathname === it.href ? ' active' : ''}" href="${it.href}">
        <i class="ti ${it.icon} nav-item-icon"></i>
        <span class="nav-item-label">${escHtml(it.label)}</span>
        ${it.page === 'notifications' ? '<span id="notif-badge" class="notif-badge" style="display:none"></span>' : ''}
      </a>`).join('');
    return `
    <div class="nav-section${expanded ? ' exp' : ''}" data-group-idx="${gi}">
      <div class="nav-section-header">
        <i class="ti ${g.headerIcon} nav-section-icon"></i>
        <span class="nav-section-title">${escHtml(g.title)}</span>
        <i class="ti ti-chevron-down nav-section-chevron"></i>
      </div>
      <div class="nav-section-items">${itemsHTML}
      </div>
    </div>`;
  }).join('');
}

/**
 * 一站式入口:filter + expand + render。
 */
export function buildSidebarNav(groups, currentUser, pathname) {
  const visible = filterVisibleGroups(groups, currentUser);
  const expandedIdx = findExpandedGroupIdx(visible, pathname);
  return buildNavHTML(visible, expandedIdx, pathname);
}

function escHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;',
  }[c]));
}

/**
 * 階段 4.5.1 + 4.5.2:綁 sidebar group expand/collapse + mobile drawer 互動。
 * 2026-05-19:桌機從 hover-expand 改成 click-expand(對齊 mobile)、所有裝置統一:
 *   - group header click → toggle .exp、手風琴(開新的收舊的)
 *   - hamburger / mask / close 按鈕 → 開關 sidebar.open + mask.open class
 *     (mobile 才有這些 element、desktop 自動 skip via if 守)
 *   - sub-item click → 收抽屜(mobile 有效、desktop 無 .open class、無副作用)
 *
 * @param {HTMLElement} sidebarRoot - <aside id="sidebar">
 * @param {Object} opts
 * @param {boolean} [opts.supportsHover] - DEPRECATED 2026-05-19:桌機改 click-expand 後不再使用、保留只為 backward compat(layout.js 仍會傳、本函式忽略)
 * @param {HTMLElement|null} [opts.hamburger] - mobile header 漢堡按鈕、null 則自己 query
 * @param {HTMLElement|null} [opts.closeBtn]  - drawer 內 close 按鈕、null 則自己 query
 * @param {HTMLElement|null} [opts.mask]      - 半透明遮罩、null 則自己 query
 * @returns {void}
 */
export function attachSidebarInteractions(sidebarRoot, opts = {}) {
  if (!sidebarRoot) return;
  const sections = Array.from(sidebarRoot.querySelectorAll('.nav-section'));

  // 2026-05-19:桌機 hover-expand 改成 click-expand(對齊 mobile 邏輯)。
  // 原因:桌機 hover 展開時 group 寬度變化、滑鼠位置 hit target 跳動、
  // sub-item 點不到。改成 click toggle 後、移開滑鼠不影響展開狀態。
  // opts.supportsHover 保留為 backward compat、本函式不再依賴。

  // ── 統一 group expand / mobile drawer 邏輯(桌機 + mobile 同) ──
  // 1. group header click → toggle .exp + 手風琴
  for (const sec of sections) {
    const header = sec.querySelector('.nav-section-header');
    if (!header) continue;
    header.addEventListener('click', (e) => {
      if (e.target.closest('.nav-item')) return;  // sub-item 不觸發 group toggle
      const wasExp = sec.classList.contains('exp');
      for (const other of sections) other.classList.remove('exp');
      if (!wasExp) sec.classList.add('exp');
    });
  }

  // 2. mobile drawer 開關 (hamburger / mask / close 按鈕)
  const doc = sidebarRoot.ownerDocument || document;
  const hamburger = opts.hamburger ?? doc.querySelector('.hamburger-btn');
  const closeBtn  = opts.closeBtn  ?? sidebarRoot.querySelector('.close-btn');
  const mask      = opts.mask      ?? doc.querySelector('.sidebar-mask');

  const openDrawer = () => {
    sidebarRoot.classList.add('open');
    if (mask) mask.classList.add('open');
  };
  const closeDrawer = () => {
    sidebarRoot.classList.remove('open');
    if (mask) mask.classList.remove('open');
  };

  if (hamburger) hamburger.addEventListener('click', openDrawer);
  if (closeBtn)  closeBtn.addEventListener('click',  closeDrawer);
  if (mask)      mask.addEventListener('click',      closeDrawer);

  // 3. sub-item click → 收抽屜 (不 preventDefault、讓 <a href> 自然導頁)
  // 用事件委派、綁在 sidebar 上、避免 31 個 sub-item 各別綁
  sidebarRoot.addEventListener('click', (e) => {
    const item = e.target.closest('.nav-item');
    if (item) closeDrawer();
  });
}
