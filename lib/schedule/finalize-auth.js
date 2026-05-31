// lib/schedule/finalize-auth.js — 時間閘門強制公告排班(純函式)
//
// 與 lib/schedule/period-state.js / period-coverage.js 同 layer,純 reducer、無 I/O。
// 由 api/schedule-periods/[id]/force-finalize.js + 前端 (public/js/schedule/finalize-auth.js
// 鏡像版) 共用語意。
//
// 兩個窗口、兩個 tier:
//   - manager_force: period_start 前一個月 26 號起,同部門主管可一刀公告
//   - ceo_force:     period_start 前一天起,CEO / chairman / admin 可一刀公告
//
// reducer 級的純函式不檢查狀態合法性、也不檢查 isPeriodFullyScheduled,
// 那兩個守門由 endpoint 套 canTransition + isPeriodFullyScheduled 處理。

const CEO_LIKE_ROLES = Object.freeze(['ceo', 'chairman', 'admin']);

/**
 * @param {{ period_start?: string }} period
 * @returns {{ managerForceFrom: string|null, ceoForceFrom: string|null }}
 *   YYYY-MM-DD 字串、跨年用 UTC Date 自動 rollover。
 */
export function computeForceWindows(period) {
  if (!period?.period_start || !/^\d{4}-\d{2}-\d{2}$/.test(period.period_start)) {
    return { managerForceFrom: null, ceoForceFrom: null };
  }
  const [y, m, d] = period.period_start.split('-').map(Number);
  // ceo:period_start − 1 day(= 前一個月最後一天)
  const ceoDate = new Date(Date.UTC(y, m - 1, d - 1));
  // manager:前一個月 26 號(Date.UTC 月份 0-indexed,-1 跨年自動)
  const managerDate = new Date(Date.UTC(y, m - 2, 26));
  return {
    managerForceFrom: managerDate.toISOString().slice(0, 10),
    ceoForceFrom:     ceoDate.toISOString().slice(0, 10),
  };
}

/**
 * @param {{
 *   caller: { id?: string, role?: string, is_manager?: boolean, dept_id?: string|null },
 *   period: { period_start?: string },
 *   employeeDeptId: string|null,
 *   now: string  YYYY-MM-DD(呼叫端自己用 server time 取台北今日)
 * }} args
 * @returns {{ ok: true, tier: 'manager_force'|'ceo_force' }
 *          | { ok: false, reason: 'BEFORE_WINDOW'|'NOT_AUTHORIZED' }}
 */
export function forceFinalizeAuth({ caller, period, employeeDeptId, now }) {
  if (!caller || !period || !now) {
    return { ok: false, reason: 'NOT_AUTHORIZED' };
  }
  const { managerForceFrom, ceoForceFrom } = computeForceWindows(period);

  // 角色資格(不論時間)
  const isSameDeptManager =
    caller.is_manager === true &&
    !!caller.dept_id &&
    !!employeeDeptId &&
    caller.dept_id === employeeDeptId;
  const isCeoLike = CEO_LIKE_ROLES.includes(caller.role);

  // 時間 + 角色 雙條件
  const managerOk = isSameDeptManager && managerForceFrom && String(now) >= String(managerForceFrom);
  const ceoOk     = isCeoLike         && ceoForceFrom     && String(now) >= String(ceoForceFrom);

  if (managerOk) return { ok: true, tier: 'manager_force' };
  if (ceoOk)     return { ok: true, tier: 'ceo_force' };

  // 區分 BEFORE_WINDOW vs NOT_AUTHORIZED:角色符合但時間未到 = BEFORE_WINDOW
  if (isSameDeptManager || isCeoLike) {
    return { ok: false, reason: 'BEFORE_WINDOW' };
  }
  return { ok: false, reason: 'NOT_AUTHORIZED' };
}
