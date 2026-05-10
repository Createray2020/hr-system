// tests/sidebar-builder.test.js — public/js/sidebar/builder.js 純函式行為
//
// 抓 6 群組 sidebar 的:
//   1. group + items 結構正確
//   2. gate 過濾(全員 vs HR vs 主管)
//   3. 空 group 自動隱藏
//   4. current pathname 對應 group 預設展開 (.exp class)

import { describe, it, expect } from 'vitest';
import {
  getNavGroups,
  filterVisibleGroups,
  findExpandedGroupIdx,
  buildNavHTML,
  buildSidebarNav,
} from '../public/js/sidebar/builder.js';

// ─── Fake gates(模擬 layout.js 真的 gate) ──────────────────
const gatesAllowAll = {
  isHRish: () => true, isMgrOrHR: () => true, isMgrOrCEO: () => true,
  isBackofficeRole: () => true, canManageAnnouncements: () => true,
};
const gatesEmployeeOnly = {
  isHRish: () => false, isMgrOrHR: () => false, isMgrOrCEO: () => false,
  isBackofficeRole: () => false, canManageAnnouncements: () => false,
};
const gatesManagerOnly = {  // is_manager=true 但非 HR
  isHRish: () => false, isMgrOrHR: () => true, isMgrOrCEO: () => true,
  isBackofficeRole: () => false, canManageAnnouncements: () => false,
};

describe('getNavGroups - 結構', () => {
  it('回 6 個 group、順序對:我的工作區 → 資訊中心 → 員工管理 → 班表&出勤 → 假勤管理 → 薪資', () => {
    const groups = getNavGroups(gatesAllowAll);
    expect(groups).toHaveLength(6);
    expect(groups.map(g => g.title)).toEqual([
      '我的工作區', '資訊中心', '員工管理', '班表 & 出勤', '假勤管理', '薪資',
    ]);
  });
  it('每個 group 都有 headerIcon (ti-prefix)', () => {
    const groups = getNavGroups(gatesAllowAll);
    groups.forEach(g => {
      expect(g.headerIcon).toMatch(/^ti-/);
    });
  });
  it('group items 數對:6/6/4/6/6/3', () => {
    const groups = getNavGroups(gatesAllowAll);
    expect(groups.map(g => g.items.length)).toEqual([6, 6, 4, 6, 6, 3]);
  });
  it('每個 item 有 ti- 前綴 icon + href + label + page', () => {
    const groups = getNavGroups(gatesAllowAll);
    for (const g of groups) {
      for (const it of g.items) {
        expect(it.icon).toMatch(/^ti-/);
        expect(it.href).toMatch(/^\/.+\.html$/);
        expect(it.label).toBeTruthy();
        expect(it.page).toBeTruthy();
      }
    }
  });
  it('我的工作區 6 項全無 gate(全員可見)', () => {
    const groups = getNavGroups(gatesAllowAll);
    expect(groups[0].items.every(it => !it.gate)).toBe(true);
  });
});

describe('filterVisibleGroups', () => {
  it('HR(allow all)→ 全 6 group 可見、總計 31 個 item', () => {
    const groups = getNavGroups(gatesAllowAll);
    const visible = filterVisibleGroups(groups, {});
    expect(visible).toHaveLength(6);
    const total = visible.reduce((s, g) => s + g.items.length, 0);
    expect(total).toBe(31);
  });

  it('純員工(deny all)→ 只剩有「全員」項目的 group:我的工作區(6) + 資訊中心(行事曆+通知中心=2)', () => {
    const groups = getNavGroups(gatesEmployeeOnly);
    const visible = filterVisibleGroups(groups, {});
    expect(visible).toHaveLength(2);
    expect(visible[0].title).toBe('我的工作區');
    expect(visible[0].items).toHaveLength(6);
    expect(visible[1].title).toBe('資訊中心');
    expect(visible[1].items.map(it => it.page)).toEqual(['calendar', 'notifications']);
  });

  it('純主管(isMgrOrHR / isMgrOrCEO 通過、isHRish 不通過)→ 看到 4 群組', () => {
    const groups = getNavGroups(gatesManagerOnly);
    const visible = filterVisibleGroups(groups, {});
    // 我的工作區 6 / 資訊中心 (總覽+行事曆+公告欄+通知中心=4) /
    // 員工管理 (只 orgchart 通過 isMgrOrHR、其他 isHRish 不過、isBackofficeRole 不過 = 1) /
    // 班表&出勤 (排班管理+班表範本=2、其他 isHRish 不過) /
    // 假勤管理 (請假審批+加班審核=2、其他 isHRish 不過) /
    // 薪資 (全 isHRish 不過 = 0)
    expect(visible.map(g => g.title)).toEqual(['我的工作區', '資訊中心', '員工管理', '班表 & 出勤', '假勤管理']);
    expect(visible.find(g => g.title === '員工管理').items.map(it => it.page)).toEqual(['orgchart']);
    expect(visible.find(g => g.title === '薪資')).toBeUndefined();
  });

  it('空 group 自動隱藏 (filterEmployeeOnly 員工管理 / 班表&出勤 / 假勤管理 / 薪資 全部不見)', () => {
    const groups = getNavGroups(gatesEmployeeOnly);
    const visible = filterVisibleGroups(groups, {});
    expect(visible.find(g => g.title === '員工管理')).toBeUndefined();
    expect(visible.find(g => g.title === '班表 & 出勤')).toBeUndefined();
    expect(visible.find(g => g.title === '假勤管理')).toBeUndefined();
    expect(visible.find(g => g.title === '薪資')).toBeUndefined();
  });

  it('null/undefined 寬容', () => {
    expect(filterVisibleGroups(null, {})).toEqual([]);
    expect(filterVisibleGroups([], {})).toEqual([]);
  });
});

describe('findExpandedGroupIdx', () => {
  const groups = filterVisibleGroups(getNavGroups(gatesAllowAll), {});

  it('pathname /salary.html → 對應「薪資」group(idx 5)', () => {
    expect(findExpandedGroupIdx(groups, '/salary.html')).toBe(5);
  });
  it('pathname /attendance.html → 對應「我的工作區」(idx 0)', () => {
    expect(findExpandedGroupIdx(groups, '/attendance.html')).toBe(0);
  });
  it('pathname /dashboard.html → 對應「資訊中心」(idx 1)', () => {
    expect(findExpandedGroupIdx(groups, '/dashboard.html')).toBe(1);
  });
  it('pathname /schedule.html → 對應「班表 & 出勤」(idx 3)', () => {
    expect(findExpandedGroupIdx(groups, '/schedule.html')).toBe(3);
  });
  it('未知 pathname → -1', () => {
    expect(findExpandedGroupIdx(groups, '/nothing.html')).toBe(-1);
    expect(findExpandedGroupIdx(groups, '/')).toBe(-1);
  });
  it('null/undefined 寬容', () => {
    expect(findExpandedGroupIdx(null, '/x')).toBe(-1);
    expect(findExpandedGroupIdx(groups, null)).toBe(-1);
  });
});

describe('buildNavHTML', () => {
  const groups = filterVisibleGroups(getNavGroups(gatesAllowAll), {});

  it('輸出 6 個 .nav-section 區塊', () => {
    const html = buildNavHTML(groups, 0, '/');
    const sectionMatches = html.match(/class="nav-section( exp)?"/g) || [];
    expect(sectionMatches).toHaveLength(6);
  });
  it('expandedIdx 對應的 group 加 .exp class、其他不加', () => {
    const html = buildNavHTML(groups, 5, '/salary.html');
    expect(html).toContain('class="nav-section exp" data-group-idx="5"');
    expect(html).toContain('class="nav-section" data-group-idx="0"');
    expect(html).toContain('class="nav-section" data-group-idx="1"');
  });
  it('pathname 對應的 nav-item 加 .active class', () => {
    const html = buildNavHTML(groups, 5, '/salary.html');
    expect(html).toContain('class="nav-item active" href="/salary.html"');
  });
  it('header icon + chevron + 每個 item icon 都用 ti class', () => {
    const html = buildNavHTML(groups, 0, '/');
    expect(html).toContain('class="ti ti-user-circle nav-section-icon"');     // 我的工作區 header
    expect(html).toContain('class="ti ti-chevron-down nav-section-chevron"'); // chevron
    expect(html).toContain('class="ti ti-clock nav-item-icon"');              // 打卡
    expect(html).toContain('class="ti ti-bell nav-item-icon"');               // 通知中心
  });
  it('通知中心 item 帶 notif-badge span', () => {
    const html = buildNavHTML(groups, 0, '/notifications.html');
    expect(html).toContain('id="notif-badge"');
  });
  it('expandedIdx=-1 → 全部 collapsed', () => {
    const html = buildNavHTML(groups, -1, '/');
    expect(html).not.toContain(' exp"');
  });
  it('XSS escape:label 含 < > " 應被 escape', () => {
    const evilGroups = [{
      title: '<script>alert(1)</script>',
      headerIcon: 'ti-x',
      items: [{ page:'x', icon:'ti-x', label:'"><img>', href:'/x.html' }],
    }];
    const html = buildNavHTML(evilGroups, -1, '/');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

// ─── 階段 4.5.1: touch device click toggle ───────────────────
// 用 happy-dom 模擬瀏覽器 DOM、驗證 attachSidebarInteractions 在 supportsHover=false 時
// 接 click + 走手風琴。supportsHover=true 路徑信任既有 hover 行為 (desktop 已 prod 跑過)。

// @vitest-environment happy-dom
describe('attachSidebarInteractions — touch device click toggle (4.5.1)', async () => {
  const { attachSidebarInteractions, buildSidebarNav, getNavGroups } =
    await import('../public/js/sidebar/builder.js');
  const groups = getNavGroups(gatesAllowAll);

  function renderSidebar() {
    document.body.innerHTML = `<aside id="sidebar"><nav>${buildSidebarNav(groups, {}, '/')}</nav></aside>`;
    return document.getElementById('sidebar');
  }
  function clickHeader(idx) {
    const sections = document.querySelectorAll('.nav-section');
    const header = sections[idx].querySelector('.nav-section-header');
    header.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  }
  function expandedIndices() {
    return [...document.querySelectorAll('.nav-section.exp')].map(s => Number(s.dataset.groupIdx));
  }

  it('supportsHover=false → click header 展開 group + 加 .exp', () => {
    const sidebar = renderSidebar();
    attachSidebarInteractions(sidebar, { supportsHover: false });
    expect(expandedIndices()).toEqual([]);
    clickHeader(2);
    expect(expandedIndices()).toEqual([2]);
  });

  it('再點同一個 header → 收合 (.exp 拿掉)', () => {
    const sidebar = renderSidebar();
    attachSidebarInteractions(sidebar, { supportsHover: false });
    clickHeader(2);
    clickHeader(2);
    expect(expandedIndices()).toEqual([]);
  });

  it('手風琴:點別的 header 自動收合舊的 (同時只 1 個 expanded)', () => {
    const sidebar = renderSidebar();
    attachSidebarInteractions(sidebar, { supportsHover: false });
    clickHeader(0);
    expect(expandedIndices()).toEqual([0]);
    clickHeader(3);
    expect(expandedIndices()).toEqual([3]);  // 0 被收掉、只剩 3
    clickHeader(5);
    expect(expandedIndices()).toEqual([5]);
  });

  it('click sub-item (.nav-item) 不觸發 toggle (讓 <a href> 自然導頁)', () => {
    const sidebar = renderSidebar();
    attachSidebarInteractions(sidebar, { supportsHover: false });
    clickHeader(0);
    expect(expandedIndices()).toEqual([0]);
    // 模擬點 group 0 的第 1 個 sub-item
    const item = document.querySelectorAll('.nav-section')[0].querySelector('.nav-item');
    item.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    // 點 sub-item 不應改 .exp 狀態 (group 仍展開、由 browser 導頁清狀態)
    expect(expandedIndices()).toEqual([0]);
  });

  it('supportsHover=true → 不綁 click handler (按 click header 不變化)', () => {
    const sidebar = renderSidebar();
    attachSidebarInteractions(sidebar, { supportsHover: true });
    expect(expandedIndices()).toEqual([]);
    clickHeader(2);
    expect(expandedIndices()).toEqual([]);  // 沒反應、因為 click 沒被綁
  });

  it('null sidebar → 不爆', () => {
    expect(() => attachSidebarInteractions(null, { supportsHover: false })).not.toThrow();
  });
});

describe('buildSidebarNav (整合)', () => {
  const groups = getNavGroups(gatesAllowAll);

  it('HR + /salary.html → 6 group + 薪資 group .exp + salary 連結 active', () => {
    const html = buildSidebarNav(groups, {}, '/salary.html');
    const sections = html.match(/class="nav-section( exp)?"/g) || [];
    expect(sections).toHaveLength(6);
    expect(html).toContain('data-group-idx="5"');
    expect(html).toContain(' exp" data-group-idx="5"');
    expect(html).toContain('class="nav-item active" href="/salary.html"');
  });

  it('純員工 + /attendance.html → 2 group(我的工作區 + 資訊中心)、第 0 group 展開', () => {
    const empGroups = getNavGroups(gatesEmployeeOnly);
    const html = buildSidebarNav(empGroups, {}, '/attendance.html');
    const sections = html.match(/class="nav-section( exp)?"/g) || [];
    expect(sections).toHaveLength(2);
    expect(html).toContain(' exp" data-group-idx="0"');
    expect(html).toContain('class="nav-item active" href="/attendance.html"');
  });
});
