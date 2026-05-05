// lib/leave/proof.js — 證明文件規則(純函式)
//
// 對應 schema:
//   leave_types.requires_proof / proof_grace_days(Phase 1.1 加)
//   leave_requests.proof_status / proof_due_at        (Phase 1.1 加)
//
// 對應流程:
//   submitLeave 時:用 getInitialProofStatus 決定 proof_status 起始值、
//                  computeProofDueAt 算 proof_due_at(若 requires_proof)
//   cron 每日掃描:用 shouldAutoConvertToPersonal 決定哪些 row 要轉事假
//                  (proof 沒交且過期 → 改 leave_type='personal' + proof_status='converted_to_personal')

/**
 * 證明補繳期限。requires_proof=false 回 null;否則回 Date。
 *   grace_days=0 → 期限 = leaveEndDate(當天 23:59 +08:00)
 *   grace_days=N → 期限 = leaveEndDate + N 天(以 UTC day 加減、避開 DST)
 *
 * @param {{ requires_proof: boolean, proof_grace_days?: number }} leaveType
 * @param {Date|string} leaveEndDate  接 Date 或 'YYYY-MM-DD' / 完整 ISO
 * @returns {Date|null}
 */
export function computeProofDueAt(leaveType, leaveEndDate) {
  if (!leaveType) throw new Error('leaveType required');
  if (!leaveType.requires_proof) return null;
  const grace = Math.max(0, Number(leaveType.proof_grace_days) || 0);
  const end = parseEndDate(leaveEndDate);
  if (grace === 0) return end;
  // 用 UTC 加減自然日、避免 DST 漂 1 小時
  const due = new Date(end);
  due.setUTCDate(due.getUTCDate() + grace);
  return due;
}

/**
 * 申請當下、新建 leaveRequest 的 proof_status 初值。
 *   requires_proof=true  → 'required'
 *   requires_proof=false → 'not_required'
 */
export function getInitialProofStatus(leaveType) {
  if (!leaveType) throw new Error('leaveType required');
  return leaveType.requires_proof ? 'required' : 'not_required';
}

/**
 * 給已存在的 leaveRequest、判斷是否應自動轉事假。
 * 回 true 條件:proof_status='required' AND proof_due_at < now。
 * 其他都 false(包含 status='submitted' / 'converted_to_personal' / 'not_required' / 沒 due_at)。
 *
 * @param {{ proof_status: string, proof_due_at: Date|string|null }} request
 * @param {Date|string} [now=new Date()]
 */
export function shouldAutoConvertToPersonal(request, now = new Date()) {
  if (!request) return false;
  if (request.proof_status !== 'required') return false;
  if (!request.proof_due_at) return false;
  const dueMs = toMs(request.proof_due_at);
  const nowMs = toMs(now);
  return dueMs < nowMs;
}

// ─── helpers ─────────────────────────────────────────────────

function parseEndDate(d) {
  if (d instanceof Date) {
    if (!Number.isFinite(d.getTime())) throw new Error('invalid Date');
    return d;
  }
  if (typeof d === 'string') {
    if (/^\d{4}-\d{2}-\d{2}$/.test(d)) {
      // 純日期字串、視為當日 23:59:59 +08:00(台灣時區)
      return new Date(`${d}T23:59:59+08:00`);
    }
    const ms = Date.parse(d);
    if (!Number.isFinite(ms)) throw new Error(`invalid date string: ${d}`);
    return new Date(ms);
  }
  throw new Error(`invalid date type: ${typeof d}`);
}

function toMs(t) {
  if (t instanceof Date) return t.getTime();
  if (typeof t === 'number') return t;
  if (typeof t === 'string') {
    const ms = Date.parse(t);
    if (!Number.isFinite(ms)) throw new Error(`invalid date string: ${t}`);
    return ms;
  }
  throw new Error(`invalid date type: ${typeof t}`);
}
