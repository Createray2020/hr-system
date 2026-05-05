// lib/leave/proof-sweep.js — 過期 proof 批次掃描(純函式)
//
// 對應流程:
//   cron 每天台灣 04:00 跑 → 撈 proof_status='required' AND proof_due_at < NOW() 的 row →
//   call sweepExpiredProofs(rows, now) → 依 action 分流跑 UPDATE + 通知。
//
// 業務規則(Phase 1.5 拍板):
//   - 全部 requires_proof 過期 → convert_to_personal(簡單一致、先 ship)
//   - leave_type 改成 'personal'、proof_status='converted_to_personal'
//   - note 補「原假別 X、未補證明、自動轉事假」(供 HR 追蹤)
//   - 不退餘額(過期 row 通常還在 pending_mgr/ceo、沒走到 approved 不會扣餘額)
//
// 純函式、不動 DB、給 cron + 未來 admin 手動掃共用。

import { shouldAutoConvertToPersonal } from './proof.js';

/**
 * 給定 leave_requests rows、回傳每筆要做的 action。
 *
 * @param {Array<{ id, leave_type, proof_status, proof_due_at, ... }>} rows
 * @param {Date|string} [now=new Date()]
 * @returns {Array<{
 *   id: string,
 *   action: 'convert',
 *   leave_type: 'personal',
 *   proof_status: 'converted_to_personal',
 *   note_suffix: string,
 *   original_leave_type: string,
 * }>}
 */
export function sweepExpiredProofs(rows, now = new Date()) {
  const actions = [];
  for (const r of (rows || [])) {
    if (!shouldAutoConvertToPersonal(r, now)) continue;
    actions.push({
      id: r.id,
      action: 'convert',
      leave_type: 'personal',
      proof_status: 'converted_to_personal',
      note_suffix: `原假別 ${r.leave_type}、未補證明、自動轉事假`,
      original_leave_type: r.leave_type,
    });
  }
  return actions;
}
