// public/js/roles.js — 前端權限判定工具（掛在 window.Roles）
// 與 lib/roles.js 同語意。在會用到的 HTML 頁面於 layout.js 之前載入：
//   <script src="/js/roles.js"></script>
(function () {
  const BACKOFFICE = ['hr', 'ceo', 'chairman', 'admin'];

  window.Roles = {
    canManageAuthAccounts(u) {
      return !!u && ['hr', 'chairman', 'admin'].includes(u.role);
    },

    canAccessBackoffice(u) {
      if (!u) return false;
      if (BACKOFFICE.includes(u.role)) return true;
      return u.is_manager === true;
    },

    canViewAllApprovals(u) {
      return !!u && BACKOFFICE.includes(u.role);
    },

    canEditApprovalConfig(u) {
      return !!u && ['hr', 'admin'].includes(u.role);
    },

    // 不認 is_manager（決策：部門主管不能發公告）
    canManageAnnouncements(u) {
      return !!u && BACKOFFICE.includes(u.role);
    },

    canWriteDepartments(u) {
      return this.canAccessBackoffice(u);
    },

    isDepartmentManager(u) {
      return !!u && u.is_manager === true;
    },

    skipAttendanceBonus(e) {
      if (!e) return false;
      if (['ceo', 'chairman'].includes(e.role)) return true;
      return e.is_manager === true;
    },

    // 舊 approvals 暫解：is_manager 優先，否則用 role
    effectiveApprovalRole(u) {
      if (!u) return '';
      if (u.is_manager === true) return 'manager';
      return u.role || '';
    },

    ROLE_LABEL: {
      chairman: '董事長', ceo: '執行長', hr: '人資',
      admin: '管理員', employee: '員工',
    },
    // 含 manager key，供舊 approver_role 顯示相容用
    ROLE_LABEL_WITH_MGR: {
      chairman: '董事長', ceo: '執行長', hr: '人資',
      admin: '管理員', employee: '員工', manager: '主管',
    },
  };
})();
