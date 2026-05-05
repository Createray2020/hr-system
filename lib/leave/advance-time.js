// lib/leave/advance-time.js — 前置時間規則(純函式)
//
// 對應 schema:leave_types.advance_hours / advance_rule(Phase 1.1 加)
// 對應流程:Phase 1.3 API submitLeave 會呼叫 validateAdvanceTime、決定 hard reject 還是 soft warn
//
// 規則總覽:
//   gap >= advance_hours      → ok=true, late=false
//   gap <  advance_hours, hard → ok=false, reason='ADVANCE_TIME_NOT_MET'
//   gap <  advance_hours, soft → ok=true, late=true, requireLateReason=true
//   advance_hours === 0       → 永遠 ok=true, late=false(當天可請類:病假 / 生理假等)
//
// 自然日 × 24h、不分工作日(parental 240h = 10 自然日;工作日邏輯 Phase 2 再考慮)。

/**
 * 計算「申請時間 → 假期起點」相差幾小時。
 * 兩者都接 Date / ISO string / number(epoch ms)。
 *
 * @param {Date|string|number} submittedAt
 * @param {Date|string|number} leaveStartAt
 * @returns {number}  小時數(浮點、可為負;leaveStartAt 在 submittedAt 之前回負)
 */
export function gapHoursBetween(submittedAt, leaveStartAt) {
  return (toMs(leaveStartAt) - toMs(submittedAt)) / 3600000;
}

/**
 * 主規則。回傳:
 *   { ok: true,  late: false }                                     — 通過
 *   { ok: true,  late: true,  requireLateReason: true, ... }       — soft 違反、需填遲報原因
 *   { ok: false, reason: 'ADVANCE_TIME_NOT_MET', ... }             — hard 違反
 *
 * @param {{ advance_hours: number, advance_rule: 'hard'|'soft' }} leaveType
 * @param {Date|string|number} leaveStartAt
 * @param {Date|string|number} [submittedAt=new Date()]
 */
export function validateAdvanceTime(leaveType, leaveStartAt, submittedAt = new Date()) {
  if (!leaveType) throw new Error('leaveType required');
  const rule = leaveType.advance_rule;
  if (rule !== 'hard' && rule !== 'soft') {
    throw new Error(`invalid advance_rule: ${rule}`);
  }
  const advanceHours = Number(leaveType.advance_hours) || 0;

  // advance_hours=0 永遠通過(病假 / 生理假 / 颱風假等當天可請類)
  if (advanceHours === 0) {
    return { ok: true, late: false };
  }

  const gap = gapHoursBetween(submittedAt, leaveStartAt);
  if (gap >= advanceHours) {
    return { ok: true, late: false };
  }

  if (rule === 'hard') {
    return {
      ok: false,
      reason: 'ADVANCE_TIME_NOT_MET',
      advance_hours: advanceHours,
      gap_hours: gap,
    };
  }
  // soft:可送出但 mark late、要求填遲報原因
  return {
    ok: true,
    late: true,
    requireLateReason: true,
    advance_hours: advanceHours,
    gap_hours: gap,
  };
}

// ─── helpers ─────────────────────────────────────────────────

function toMs(t) {
  if (t instanceof Date) {
    const ms = t.getTime();
    if (!Number.isFinite(ms)) throw new Error('invalid Date');
    return ms;
  }
  if (typeof t === 'number') {
    if (!Number.isFinite(t)) throw new Error('invalid number date');
    return t;
  }
  if (typeof t === 'string') {
    const ms = Date.parse(t);
    if (!Number.isFinite(ms)) throw new Error(`invalid date string: ${t}`);
    return ms;
  }
  throw new Error(`invalid date type: ${typeof t}`);
}
