// public/js/schedule/finalize-auth.js — 時間閘門純函式(browser 鏡像版)
//
// 與 lib/schedule/finalize-auth.js 同語意、同函式簽名;前端透過
// <script type="module"> import 後掛 window.ScheduleFinalizeAuth、
// 給 schedule.html 內聯 script 算 force-button 視覺用。
// 真正授權閘門在後端 endpoint(api/schedule-periods/[id]/force-finalize.js)。

const CEO_LIKE_ROLES = Object.freeze(['ceo', 'chairman', 'admin']);

export function computeForceWindows(period) {
  if (!period?.period_start || !/^\d{4}-\d{2}-\d{2}$/.test(period.period_start)) {
    return { managerForceFrom: null, ceoForceFrom: null };
  }
  const [y, m, d] = period.period_start.split('-').map(Number);
  const ceoDate     = new Date(Date.UTC(y, m - 1, d - 1));
  const managerDate = new Date(Date.UTC(y, m - 2, 26));
  return {
    managerForceFrom: managerDate.toISOString().slice(0, 10),
    ceoForceFrom:     ceoDate.toISOString().slice(0, 10),
  };
}

export function forceFinalizeAuth({ caller, period, employeeDeptId, now }) {
  if (!caller || !period || !now) {
    return { ok: false, reason: 'NOT_AUTHORIZED' };
  }
  const { managerForceFrom, ceoForceFrom } = computeForceWindows(period);

  const isSameDeptManager =
    caller.is_manager === true &&
    !!caller.dept_id &&
    !!employeeDeptId &&
    caller.dept_id === employeeDeptId;
  const isCeoLike = CEO_LIKE_ROLES.includes(caller.role);

  const managerOk = isSameDeptManager && managerForceFrom && String(now) >= String(managerForceFrom);
  const ceoOk     = isCeoLike         && ceoForceFrom     && String(now) >= String(ceoForceFrom);

  if (managerOk) return { ok: true, tier: 'manager_force' };
  if (ceoOk)     return { ok: true, tier: 'ceo_force' };

  if (isSameDeptManager || isCeoLike) {
    return { ok: false, reason: 'BEFORE_WINDOW' };
  }
  return { ok: false, reason: 'NOT_AUTHORIZED' };
}
