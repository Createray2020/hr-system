// lib/leave/overview-guard.js
// Phase 2 #3 補強:請假總覽編輯護欄(純函式、可被 vitest 直接 import)
//
// 規則:有餘額帳本的假別(leave_types.has_balance=true、目前 prod 為特休 annual / 補休 comp)
// 數量欄位(days / hours / finalized_hours)更正會跟 annual_leave_records / comp_time_balance
// 餘額帳本 drift,因此本頁禁止改;請走特休管理 / 補休管理頁。
//
// leave_type / admin_audit_note 不受此護欄限制(本頁仍允許改假別 + 留軌跡)。

const QUANTITY_FIELDS = ['days', 'hours', 'finalized_hours'];

/**
 * @param {Object} args
 * @param {boolean} args.hasBalance - 既有 leave_request 對應 leave_types.has_balance
 * @param {string[]} args.patchFields - PATCH 此次實際要改的欄位名(已過白名單)
 * @returns {boolean} true=擋下、false=放行
 *
 * 設計:用「既有 leave_type」而非「patch 後的新 leave_type」,因為帳本扣除是針對既有
 * leave_type 計算的;即使 caller 同時改 leave_type,既有帳本若被改動仍會 drift。
 */
export function shouldBlockQuantityEdit({ hasBalance, patchFields }) {
  if (!hasBalance) return false;
  if (!Array.isArray(patchFields) || patchFields.length === 0) return false;
  return patchFields.some(f => QUANTITY_FIELDS.includes(f));
}

export const BLOCKED_BY_BALANCE_FIELDS = QUANTITY_FIELDS;
