// lib/auth-scope.js — caller-aware row-level scope filter(純函式 + thin async wrapper)
//
// Phase 2 後端權限收緊核心 helper。3 個 endpoint(leaves / employees / schedules)
// 共用同一決策邏輯、避免散落寫死。/api/salary 不用此 helper(主管也只看自己、邏輯簡單)。
//
// policy 三選一:
//   'selfOrDept' (default) — 員工本人 + 主管本部門 + HR/CEO/chairman/admin 全部
//   'selfOrAll'             — 員工本人 + HR 全部(主管不擴權、跟員工同)
//   'onlySelf'              — 員工 / 主管 / HR 都只看自己(salary-style、本階沒用、留 surface)
//
// 回 { mode } + 視 mode 補欄位:
//   { mode: 'all' }                              HR / CEO / chairman / admin
//   { mode: 'self', selfId }                     員工 / 純主管(無 dept_id) / fallback
//   { mode: 'dept', selfId, deptId }             純主管(is_manager + dept_id 有值)
//   { mode: 'dept', selfId, deptId, deptEmpIds } async 版補 ids
//
// 純函式不打 DB、async 版接 repo / supabaseAdmin 才會 fetch。

import { isBackofficeRole } from './roles.js';

const VALID_POLICIES = new Set(['selfOrDept', 'selfOrAll', 'onlySelf']);

/**
 * 同步純函式。caller 拿到 mode 後自己決定怎麼套 SQL filter。
 *
 * @param {{ id: string, role?: string, is_manager?: boolean, dept_id?: string }} caller
 * @param {string} [policy='selfOrDept']
 */
export function resolveAuthScope(caller, policy = 'selfOrDept') {
  if (!caller) throw new Error('caller required');
  if (!VALID_POLICIES.has(policy)) {
    throw new Error(`unknown policy: ${policy} (valid: ${[...VALID_POLICIES].join(', ')})`);
  }

  // onlySelf:無條件 self、不分 role
  if (policy === 'onlySelf') {
    return { mode: 'self', selfId: caller.id };
  }

  // HR / CEO / chairman / admin → 看全部
  if (isBackofficeRole(caller)) {
    return { mode: 'all' };
  }

  // selfOrAll:主管不擴權、跟員工同 self
  if (policy === 'selfOrAll') {
    return { mode: 'self', selfId: caller.id };
  }

  // selfOrDept:純主管 + 有 dept_id → dept
  if (caller.is_manager === true && caller.dept_id) {
    return { mode: 'dept', selfId: caller.id, deptId: caller.dept_id };
  }

  // 一般員工 / 主管沒 dept_id(資料異常)→ fallback self
  return { mode: 'self', selfId: caller.id };
}

/**
 * Async wrapper:mode='dept' 時呼 repo 補 deptEmpIds。
 *
 * repo 介面契約:
 *   findActiveEmployeeIdsByDept(deptId): Promise<string[]>
 *
 * 用 makeDeptEmpIdsRepo(supabaseAdmin) 拿現成 supabase 實作。
 */
export async function resolveAuthScopeWithDeptIds(caller, policy, repo) {
  const scope = resolveAuthScope(caller, policy);
  if (scope.mode !== 'dept') return scope;
  if (!repo || typeof repo.findActiveEmployeeIdsByDept !== 'function') {
    throw new Error('repo.findActiveEmployeeIdsByDept required for mode=dept');
  }
  const ids = await repo.findActiveEmployeeIdsByDept(scope.deptId);
  return { ...scope, deptEmpIds: ids || [] };
}

/**
 * 給 scope 跟 target employee_id、判斷 caller 能否看這個員工的 row。
 *   mode='all'  → 永遠 true
 *   mode='self' → empId === scope.selfId
 *   mode='dept' → empId === selfId OR empId ∈ deptEmpIds
 *
 * 給 endpoint 處理 ?employee_id=X 顯式 query 用。
 * mode='dept' 時若 deptEmpIds 還沒撈、需先呼 resolveAuthScopeWithDeptIds。
 */
export function canSeeEmployee(scope, empId) {
  if (!scope || !empId) return false;
  if (scope.mode === 'all') return true;
  if (scope.mode === 'self') return empId === scope.selfId;
  if (scope.mode === 'dept') {
    return empId === scope.selfId || (scope.deptEmpIds || []).includes(empId);
  }
  return false;
}

/**
 * Helper:給 supabaseAdmin、回符合 repo 介面契約的 thin object。
 * 3 個 endpoint 共用、不用各自重寫 SELECT employees by dept 的邏輯。
 */
export function makeDeptEmpIdsRepo(supabaseAdmin) {
  return {
    async findActiveEmployeeIdsByDept(deptId) {
      const { data, error } = await supabaseAdmin
        .from('employees')
        .select('id')
        .eq('dept_id', deptId)
        .eq('status', 'active');
      if (error) throw error;
      return (data || []).map(e => e.id);
    },
  };
}
