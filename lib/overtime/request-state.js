// lib/overtime/request-state.js — 加班申請狀態機(純 reducer)
//
// 對應設計文件:docs/attendance-system-design-v1.md §4.4
// 對應實作計畫:docs/attendance-system-implementation-plan-v1.md §9.3
//
// 設計 pattern 同 lib/schedule/period-state.js / lib/approvals_v2/state-machine.js:
//   純函式、無 I/O。業務層在 transition 後再透過 repo 寫 overtime_requests。
//
// 合法 transition(共 6 條,規範 §9.3 表):
//   pending     + manager_approve (is_manager)        → approved      if !is_over_limit
//   pending     + manager_approve (is_manager)        → pending_ceo   if  is_over_limit
//   pending     + manager_reject  (is_manager)        → rejected
//   pending     + cancel          (is_employee_self)  → cancelled
//   pending_ceo + ceo_approve     (is_ceo)            → approved
//   pending_ceo + ceo_reject      (is_ceo)            → rejected
//
// 其他組合一律 { ok: false, reason: ... }。
// exceeds_hard_cap 不在狀態機處理 — 由 API handler 在 POST 階段擋掉(規範明示)。

export const OVERTIME_STATES = Object.freeze([
  'pending', 'pending_ceo', 'approved', 'rejected', 'cancelled',
]);

export const OVERTIME_ACTIONS = Object.freeze([
  'manager_approve', 'manager_reject',
  'ceo_approve',     'ceo_reject',
  'cancel',
]);

const TERMINAL = new Set(['approved', 'rejected', 'cancelled']);

/**
 * @param {string} fromState
 * @param {string} action
 * @param {{ is_employee_self?: boolean, is_manager?: boolean, is_ceo?: boolean }} actor
 * @param {{ is_over_limit?: boolean }} requestMeta
 * @returns {{ ok: true, nextState: string } | { ok: false, reason: string }}
 */
export function canTransition(fromState, action, actor, requestMeta) {
  if (!OVERTIME_STATES.includes(fromState)) {
    return { ok: false, reason: 'UNKNOWN_STATE' };
  }
  if (!OVERTIME_ACTIONS.includes(action)) {
    return { ok: false, reason: 'UNKNOWN_ACTION' };
  }
  if (TERMINAL.has(fromState)) {
    return { ok: false, reason: 'TERMINAL_STATE' };
  }
  if (!actor) actor = {};
  const meta = requestMeta || {};

  if (fromState === 'pending') {
    if (action === 'manager_approve') {
      if (actor.is_manager !== true) return { ok: false, reason: 'FORBIDDEN_ACTOR (need is_manager)' };
      const next = meta.is_over_limit === true ? 'pending_ceo' : 'approved';
      return { ok: true, nextState: next };
    }
    if (action === 'manager_reject') {
      if (actor.is_manager !== true) return { ok: false, reason: 'FORBIDDEN_ACTOR (need is_manager)' };
      return { ok: true, nextState: 'rejected' };
    }
    if (action === 'cancel') {
      if (actor.is_employee_self !== true) return { ok: false, reason: 'FORBIDDEN_ACTOR (need is_employee_self)' };
      return { ok: true, nextState: 'cancelled' };
    }
    return { ok: false, reason: 'ILLEGAL_TRANSITION' };
  }

  if (fromState === 'pending_ceo') {
    if (action === 'ceo_approve') {
      if (actor.is_ceo !== true) return { ok: false, reason: 'FORBIDDEN_ACTOR (need is_ceo)' };
      return { ok: true, nextState: 'approved' };
    }
    if (action === 'ceo_reject') {
      if (actor.is_ceo !== true) return { ok: false, reason: 'FORBIDDEN_ACTOR (need is_ceo)' };
      return { ok: true, nextState: 'rejected' };
    }
    return { ok: false, reason: 'ILLEGAL_TRANSITION' };
  }

  return { ok: false, reason: 'ILLEGAL_TRANSITION' };
}
