// lib/roles.js — 權限身份（role）與主管身份（is_manager）判定工具
//
// role         最終合法值：employee / hr / ceo / chairman / admin
// is_manager   獨立管理「是否為部門主管」（影響薪資加給、組織圖部門主管顯示、後台存取）
//
// 純 helper 不 import supabase，以避免測試環境載入時要求 env。
// 需要 DB 查詢的 resolve* 函式由呼叫方傳入 supabase client。

export const ROLES = Object.freeze({
  EMPLOYEE: 'employee',
  HR: 'hr',
  CEO: 'ceo',
  CHAIRMAN: 'chairman',
  ADMIN: 'admin',
});

export const BACKOFFICE_ROLES = Object.freeze(['hr', 'ceo', 'chairman', 'admin']);

// ── 權限判定 ──────────────────────────────────────────────

// 可建立/管理 Auth 帳號（密碼重設、帳號建立）
export function canManageAuthAccounts(emp) {
  return !!emp && ['hr', 'chairman', 'admin'].includes(emp.role);
}

// role 屬於後台白名單（不認 is_manager）。比 canAccessBackoffice 嚴格。
export function isBackofficeRole(emp) {
  return !!emp && BACKOFFICE_ROLES.includes(emp.role);
}

// 可進入後台。部門主管（is_manager=true）也允許。
export function canAccessBackoffice(emp) {
  if (!emp) return false;
  if (BACKOFFICE_ROLES.includes(emp.role)) return true;
  return emp.is_manager === true;
}

// 可看「全部審批」視圖
export function canViewAllApprovals(emp) {
  return !!emp && BACKOFFICE_ROLES.includes(emp.role);
}

// 可編輯審批流程設定
export function canEditApprovalConfig(emp) {
  return !!emp && ['hr', 'admin'].includes(emp.role);
}

// 可管理公告後台（不認 is_manager）
export function canManageAnnouncements(emp) {
  return !!emp && BACKOFFICE_ROLES.includes(emp.role);
}

// 可寫部門資料
export function canWriteDepartments(emp) {
  return canAccessBackoffice(emp);
}

// ── 主管身份判定 ──────────────────────────────────────────

export function isDepartmentManager(emp) {
  return !!emp && emp.is_manager === true;
}

// 不計出勤獎金（CEO/Chairman 因職級、is_manager 因身份）
export function skipAttendanceBonus(emp) {
  if (!emp) return false;
  if (['ceo', 'chairman'].includes(emp.role)) return true;
  return emp.is_manager === true;
}

// ── 舊 approvals 暫解 ────────────────────────────────────

// 把使用者映射到舊 approvals 系統的 approver_role 字串。
// is_manager 最優先（對應 step 1）；否則看 role。
export function effectiveApprovalRole(emp) {
  if (!emp) return '';
  if (emp.is_manager === true) return 'manager';
  return emp.role || '';
}

// 將舊 approval_steps.approver_role 解析為對應員工 id 清單。
// 'manager' → is_manager=true 的人；其他 role → employees.role 該值。
export async function resolveApproverRoleToEmployeeIds(approverRole, supabase) {
  if (approverRole === 'manager') {
    const { data } = await supabase.from('employees')
      .select('id').eq('is_manager', true).eq('status', 'active');
    return (data || []).map(r => r.id);
  }
  const { data } = await supabase.from('employees')
    .select('id').eq('role', approverRole).eq('status', 'active');
  return (data || []).map(r => r.id);
}

// 將多個 approver_role 集合解析成聯集的員工 id 清單（lib/push.js 用）。
// manager → is_manager=true；其他 → role IN (...)
export async function resolveRoleSetToEmployeeIds(roles, supabase) {
  if (!roles?.length) return [];
  const hasManager = roles.includes('manager');
  const normalRoles = roles.filter(r => r !== 'manager');
  const ids = new Set();
  if (normalRoles.length) {
    const { data } = await supabase.from('employees')
      .select('id').in('role', normalRoles).eq('status', 'active');
    (data || []).forEach(r => ids.add(r.id));
  }
  if (hasManager) {
    const { data } = await supabase.from('employees')
      .select('id').eq('is_manager', true).eq('status', 'active');
    (data || []).forEach(r => ids.add(r.id));
  }
  return [...ids];
}
