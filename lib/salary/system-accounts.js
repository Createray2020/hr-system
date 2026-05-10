// lib/salary/system-accounts.js — 排除系統帳號不進薪資計算
//
// 背景: prod 有 EMP_99999999(系統管理員、虛擬帳號、status=active 但不是真員工)、
//       會被 batch_v2 撈進 calc loop。其他 base_salary=0 的員工是真實兼職、保留不能擋。
//
// 設計選擇(hot fix minimal):
//   - 不動 employees schema、不加 is_system_account 欄位
//   - 用硬編碼的 ID 黑名單擋下、3 個入口共用此 module
//   - 將來若虛擬帳號變多(>3)再考慮加欄位
//
// 排除點:
//   - api/salary/_repo.js listActiveEmployees() 加 .neq() query filter(batch enum)
//   - api/salary/index.js handleNewBatch 對 explicit employee_id 加 isSystemAccount guard
//   - api/salary/recalculate.js 同樣 guard(防 HR 從 UI 直接觸發單筆重算)

export const SYSTEM_ACCOUNT_IDS = Object.freeze(['EMP_99999999']);

/**
 * 判定 employee_id 是否為系統帳號(不該進薪資計算)
 * @param {string} employee_id
 * @returns {boolean}
 */
export function isSystemAccount(employee_id) {
  return SYSTEM_ACCOUNT_IDS.includes(employee_id);
}

/**
 * 從 employee array 過濾掉系統帳號(client-side filter、防 query filter 漏接的 belt-and-suspenders)
 * @param {Array<{id: string}>} employees
 * @returns {Array}
 */
export function excludeSystemAccounts(employees) {
  return (employees || []).filter(e => !isSystemAccount(e?.id));
}

/**
 * 把 NOT-system-accounts filter 串到 supabase query builder
 * 目前只 1 個 ID、用 .neq();將來 ≥2 個再改成 .not('id', 'in', ...)
 *
 * @param {Object} query - supabase query builder(.neq method)
 * @returns {Object} 同一個 query builder(chainable)
 */
export function applyExcludeSystemAccountsQuery(query) {
  return query.neq('id', SYSTEM_ACCOUNT_IDS[0]);
}
