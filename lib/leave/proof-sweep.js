// lib/leave/proof-sweep.js — 過期 proof 批次掃描(純函式)
//
// 對應流程:
//   cron 每天台灣 04:00 跑 → 撈 proof_status='required' AND proof_due_at < NOW() 的 row →
//   call sweepExpiredProofs(rows, leaveTypesByCode, now) → 依 leaveType.proof_expiry_action
//   分流跑 UPDATE + 通知。
//
// 業務規則(Phase 1.5 升級拍板):
//   convert (sick / hospital_unpaid / 預設):
//     - leave_type 改 'personal'、proof_status='converted_to_personal'
//     - note 補「原假別 X、未補證明、自動轉事假」(供 HR 追蹤)
//   mark_expired (法定假 9 種):
//     - 只標 proof_status='expired'、leave_type / status 不動
//     - note 補「原假別 X、未補證明、HR 個案處理」
//     - 員工 + HR 都通知、由 HR 決定後續(Phase 1.6 backlog 補手動 endpoint)
//
//   不退餘額:過期 row 通常還在 pending_mgr/ceo、沒走到 approved 不會扣餘額。
//
// 純函式、不動 DB、給 cron + 未來 admin 手動掃共用。

import { isProofExpired } from './proof.js';

/**
 * 給定 leave_requests rows + leave_types map、回傳每筆要做的 action。
 *
 * @param {Array<{ id, leave_type, proof_status, proof_due_at, ... }>} rows
 * @param {Object<string, { proof_expiry_action?: 'convert'|'mark_expired' }>} leaveTypesByCode
 *   leave_type code → leave_types row(至少含 proof_expiry_action)。
 *   缺對應 row → fallback 'convert'(safety、防新增假別忘 backfill)
 * @param {Date|string} [now=new Date()]
 * @returns {Array<
 *   | { id: string, action: 'convert', leave_type: 'personal',
 *       proof_status: 'converted_to_personal', note_suffix: string, original_leave_type: string }
 *   | { id: string, action: 'mark_expired', proof_status: 'expired',
 *       note_suffix: string, original_leave_type: string }
 * >}
 */
export function sweepExpiredProofs(rows, leaveTypesByCode = {}, now = new Date()) {
  const actions = [];
  for (const r of (rows || [])) {
    if (!isProofExpired(r, now)) continue;
    const lt = leaveTypesByCode[r.leave_type] || null;
    // safety:對應假別在 leave_types map 裡找不到、或 proof_expiry_action 為空 → 走 convert
    // (確保不會因為 prod 漏 backfill 就 silent skip / throw)
    const action = lt?.proof_expiry_action === 'mark_expired' ? 'mark_expired' : 'convert';

    if (action === 'mark_expired') {
      actions.push({
        id: r.id,
        action: 'mark_expired',
        proof_status: 'expired',
        note_suffix: `原假別 ${r.leave_type}、未補證明、HR 個案處理`,
        original_leave_type: r.leave_type,
      });
    } else {
      actions.push({
        id: r.id,
        action: 'convert',
        leave_type: 'personal',
        proof_status: 'converted_to_personal',
        note_suffix: `原假別 ${r.leave_type}、未補證明、自動轉事假`,
        original_leave_type: r.leave_type,
      });
    }
  }
  return actions;
}
