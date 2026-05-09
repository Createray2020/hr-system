// lib/salary/period-state.js — payroll_periods 狀態機 transition rules
//
// 純函式 module、無 repo 注入需求(不碰 DB、只判斷狀態合法性)。
// 對齊 lib/schedule/period-state.js 風格。
//
// 狀態流轉:
//   draft         → calculating  (HR 按「跑試算」)
//   calculating   → pending_review (calculator 跑完自動)
//                 → draft         (跑失敗回退)
//   pending_review → approved     (老闆審核通過)
//                 → calculating   (HR 改了 _manual 要重算)
//   approved      → paid          (HR 按「標記發放」)
//                 → calculating   (老闆退回重算、需 reason)
//   paid          → locked        (月底 cron 自動 / admin 手動)
//   locked        → (終態、不可轉)

export const STATUSES = ['draft','calculating','pending_review','approved','paid','locked'];

export const ALLOWED_TRANSITIONS = {
  draft:           ['calculating'],
  calculating:     ['draft', 'pending_review'],
  pending_review:  ['calculating', 'approved'],
  approved:        ['calculating', 'paid'],
  paid:            ['locked'],
  locked:          [],
};

// 哪些角色可做特定 transition
// 'hr' 系: hr / admin / ceo / chairman 都能(BACKOFFICE_ROLES)
// 'ceo' 限: 只有 ceo / chairman(老闆審核 / 退回)
// 'admin' 限: 只有 admin(或 cron service role)
const TRANSITION_ROLES = {
  'draft->calculating':          ['hr','admin','ceo','chairman'],
  'calculating->draft':          ['hr','admin','ceo','chairman'],
  'calculating->pending_review': ['hr','admin','ceo','chairman'],
  'pending_review->calculating': ['hr','admin','ceo','chairman'],
  'pending_review->approved':    ['ceo','chairman'],
  'approved->calculating':       ['ceo','chairman'],
  'approved->paid':              ['hr','admin','ceo','chairman'],
  'paid->locked':                ['admin','cron'],
};

export function isValidStatus(status) {
  return STATUSES.includes(status);
}

export function canTransition(from, to) {
  if (!isValidStatus(from) || !isValidStatus(to)) return false;
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}

export function isFinalState(status) {
  return isValidStatus(status) && ALLOWED_TRANSITIONS[status].length === 0;
}

export function getAllowedNextStates(from) {
  return ALLOWED_TRANSITIONS[from] || [];
}

export function getRolesForTransition(from, to) {
  if (!canTransition(from, to)) return [];
  return TRANSITION_ROLES[`${from}->${to}`] || [];
}

export function isRoleAllowedForTransition(role, from, to) {
  return getRolesForTransition(from, to).includes(role);
}

// 高階輔助:caller role + from + to → 是否可執行
// 失敗 reason: 'INVALID_TRANSITION' | 'FORBIDDEN_ROLE'
export function canExecuteTransition({ callerRole, from, to }) {
  if (!canTransition(from, to)) {
    return { ok: false, reason: 'INVALID_TRANSITION' };
  }
  if (!isRoleAllowedForTransition(callerRole, from, to)) {
    return { ok: false, reason: 'FORBIDDEN_ROLE' };
  }
  return { ok: true };
}
