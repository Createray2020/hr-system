// lib/schedule/period-state.js — 排班週期狀態機（純 reducer）
//
// 對應設計文件：docs/attendance-system-design-v1.md §4.2.1
// 對應實作計畫：docs/attendance-system-implementation-plan-v1.md §5.2
//
// 設計 pattern 同 lib/approvals_v2/state-machine.js：純函式、無 I/O。
// 由業務層在執行 transition 後再透過 repo 寫 schedule_periods + schedule_change_logs。
//
// 合法 transition（C12-2 + F3 + executive unlock 後共 11 條）：
//   draft     + submit    (is_employee_self) → submitted
//   submitted + approve   (is_manager)       → approved
//   submitted + adjust    (is_manager)       → submitted   主管調整但仍 submitted
//   approved  + adjust    (is_manager)       → approved    定案後主管又改，仍 approved
//   approved  + publish   (is_manager)       → published   主管公告、員工才能打卡
//   approved  + lock      (is_system)        → locked      cron 月份開始觸發
//   published + adjust    (is_manager)       → published   公告後主管又改、仍 published
//   published + lock      (is_system)        → locked      cron 月份開始觸發
//   published + unpublish (is_manager)       → approved    F3:主管 / admin / chairman / ceo 撤回公告
//   locked    + adjust    (is_manager)       → locked      鎖定後主管當天改
//   locked    + unlock    (is_executive)     → approved    executive 解鎖、重回編輯流程

export const SCHEDULE_PERIOD_STATES = Object.freeze([
  'draft', 'submitted', 'approved', 'published', 'locked',
]);

export const SCHEDULE_PERIOD_ACTIONS = Object.freeze([
  'submit', 'approve', 'publish', 'adjust', 'lock', 'unpublish', 'unlock',
]);

const RULES = [
  { from: 'draft',     action: 'submit',    actorKey: 'is_employee_self', to: 'submitted' },
  { from: 'submitted', action: 'approve',   actorKey: 'is_manager',       to: 'approved'  },
  { from: 'submitted', action: 'adjust',    actorKey: 'is_manager',       to: 'submitted' },
  { from: 'approved',  action: 'adjust',    actorKey: 'is_manager',       to: 'approved'  },
  { from: 'approved',  action: 'publish',   actorKey: 'is_manager',       to: 'published' },
  { from: 'approved',  action: 'lock',      actorKey: 'is_system',        to: 'locked'    },
  { from: 'published', action: 'adjust',    actorKey: 'is_manager',       to: 'published' },
  { from: 'published', action: 'lock',      actorKey: 'is_system',        to: 'locked'    },
  { from: 'published', action: 'unpublish', actorKey: 'is_manager',       to: 'approved'  }, // F3
  { from: 'locked',    action: 'adjust',    actorKey: 'is_manager',       to: 'locked'    },
  { from: 'locked',    action: 'unlock',    actorKey: 'is_executive',     to: 'approved'  }, // 2026-06 executive unlock
];

/**
 * @param {string} fromState
 * @param {string} action
 * @param {{ is_employee_self?: boolean, is_manager?: boolean, is_system?: boolean }} actor
 * @returns {{ ok: true, nextState: string } | { ok: false, reason: string }}
 */
export function canTransition(fromState, action, actor) {
  if (!SCHEDULE_PERIOD_STATES.includes(fromState)) {
    return { ok: false, reason: 'UNKNOWN_STATE' };
  }
  if (!SCHEDULE_PERIOD_ACTIONS.includes(action)) {
    return { ok: false, reason: 'UNKNOWN_ACTION' };
  }
  const rule = RULES.find(r => r.from === fromState && r.action === action);
  if (!rule) return { ok: false, reason: 'ILLEGAL_TRANSITION' };
  if (!actor || actor[rule.actorKey] !== true) {
    return { ok: false, reason: `FORBIDDEN_ACTOR (need ${rule.actorKey})` };
  }
  return { ok: true, nextState: rule.to };
}
