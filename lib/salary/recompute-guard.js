// lib/salary/recompute-guard.js
// Phase 3C 重算防護(純函式、可被 vitest 直接 import)
//
// 動機:
//   prod 已有 4 筆 status='draft' 的 row 在 admin_audit_note 留 "[FORCE 本月一次性手動結算、
//   不再跑 calculator]" 字串,但這只是中文 audit 軌跡、無 enforce 效力 → 6/1 batch_v2 真的
//   把手調值沖掉,HR 又補復原。Phase 3C 用 manual_lock boolean 取代字串、提供真鎖。
//
//   同時補上對 status='paid'/'locked' 的 batch/scoped-recalc 防護(spec #13 偵察的 critical
//   risk:目前 calculator 完全沒擋已發放/已鎖期間)。
//
// 規則:
//   - manual_lock === true → 永遠跳過(任何重算路徑都不動);**不分 status**(draft 也要保護)
//   - status='paid' / 'locked' → batch / scoped-recalc 跳過(避免已發放月份被誤觸全批)
//   - 一般 row(null / draft / confirmed / pending_review / approved)→ 放行
//
// 用法分流:
//   - calculator.js:Step 1 後用 `isManuallyLocked(existing)` 早 return,不分 status
//     (要重算被鎖列,先透過 admin_edit PATCH manual_lock=false)
//   - batch / recalc / cascade entry point:用 `shouldSkipBatchRecalc({ existing })`
//     擋下 manual_lock + paid + locked、回傳 reason 供上層統計
//
// 設計:不提供 force escape hatch(spec 明示);要繞鎖必須走 admin_edit。
//   force 參數預留只為 future use,目前所有 caller 都不傳。

const FROZEN_STATUSES = new Set(['paid', 'locked']);

/**
 * 整列手動鎖判斷(calculator 內短路用)。
 * @param {Object|null} existing - salary_records row 或 null
 * @returns {boolean}
 */
export function isManuallyLocked(existing) {
  return !!(existing && existing.manual_lock === true);
}

/**
 * status='paid'/'locked' 判斷(batch / recalc 入口用)。
 * @param {Object|null} existing
 * @returns {boolean}
 */
export function isStatusFrozen(existing) {
  return !!(existing && FROZEN_STATUSES.has(existing.status));
}

/**
 * Batch / scoped-recalc / cascade 入口的綜合判斷。
 * @param {Object} args
 * @param {Object|null} args.existing - salary_records row 或 null(新 row 視為放行)
 * @param {boolean} [args.force=false] - 未來預留;目前所有 caller 都不傳、不可從 UI 觸發
 * @returns {{ skip: boolean, reason: 'manual_lock'|'paid'|'locked'|null }}
 */
export function shouldSkipBatchRecalc({ existing, force = false } = {}) {
  if (force)     return { skip: false, reason: null };
  if (!existing) return { skip: false, reason: null };
  if (isManuallyLocked(existing))   return { skip: true, reason: 'manual_lock' };
  if (existing.status === 'paid')   return { skip: true, reason: 'paid' };
  if (existing.status === 'locked') return { skip: true, reason: 'locked' };
  return { skip: false, reason: null };
}

export const FROZEN_STATUS_VALUES = [...FROZEN_STATUSES];
