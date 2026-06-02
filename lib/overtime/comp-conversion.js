// lib/overtime/comp-conversion.js — 加班通過 → 補休餘額轉換(純函式 + repo 注入式)
//
// 對應設計文件:docs/attendance-system-design-v1.md §4.4 / §4.3.4
// 對應實作計畫:docs/attendance-system-implementation-plan-v1.md §9.5
//
// 規則(規範 §9.5):
//   - 加班通過且 compensation_type='comp_leave' → 觸發
//   - earned_hours = overtimeRequest.hours(1:1 換算,**不依倍率**)
//   - earned_at = overtimeRequest.overtime_date 當日 00:00(台灣時區)
//   - expires_at = earned_at + 1 year(由 grantCompTime 自動算)
//   - 寫入後 update overtime_requests.comp_balance_id
//
// 不重發明輪子:直接 import grantCompTime from lib/comp-time/balance.js,Batch 6 已實作。

import { grantCompTime } from '../comp-time/balance.js';

/**
 * Repo 介面契約:
 *   (繼承 grantCompTime 需要的:insertCompBalance, insertBalanceLog)
 *   updateOvertimeCompBalanceId(request_id, comp_balance_id): updated row
 *
 * 呼叫端要保證 overtimeRequest 為 status='approved' 且 compensation_type='comp_leave'
 * 才呼叫此函式。本函式不重複檢查狀態(避免跟 state machine 重複邏輯)。
 */
export async function convertOvertimeToCompTime(repo, overtimeRequest) {
  if (!repo || typeof repo.updateOvertimeCompBalanceId !== 'function') {
    throw new Error('repo.updateOvertimeCompBalanceId is required');
  }
  if (!overtimeRequest) throw new Error('overtimeRequest required');
  if (overtimeRequest.compensation_type !== 'comp_leave') {
    throw new Error(`compensation_type must be 'comp_leave', got '${overtimeRequest.compensation_type}'`);
  }
  if (!overtimeRequest.id || !overtimeRequest.employee_id || !overtimeRequest.overtime_date) {
    throw new Error('overtimeRequest must have id / employee_id / overtime_date');
  }
  if (!Number.isFinite(+overtimeRequest.hours) || +overtimeRequest.hours <= 0) {
    throw new Error('overtimeRequest.hours must be positive');
  }

  const earnedAt = `${overtimeRequest.overtime_date}T00:00:00+08:00`;

  const created = await grantCompTime(repo, {
    employee_id: overtimeRequest.employee_id,
    hours:       Number(overtimeRequest.hours),
    source_overtime_request_id: overtimeRequest.id,
    earned_at:   earnedAt,
    changed_by:  overtimeRequest.manager_id ||
                 overtimeRequest.ceo_id ||
                 overtimeRequest.employee_id,
    // expires_at 不傳:grantCompTime 自動 earned_at + 1 year
  });

  if (!created || !created.id) {
    throw new Error('grantCompTime did not return a record with id');
  }

  await repo.updateOvertimeCompBalanceId(overtimeRequest.id, created.id);
  return created;
}

/**
 * convertOvertimeToCompTime 的 safe wrapper:
 *   - 成功 → { ok: true, comp_balance, warning: null }
 *   - 失敗 → 不 rethrow,改 durable 寫入 overtime_requests.admin_audit_note(若 repo 支援)
 *           + 嘗試通知 HR(若 repo 提供 notifyCompConversionFailure)
 *           + 回 { ok: false, comp_balance: null, warning: { code, message, detail } }
 *
 * 設計:加班核准本身已成功(updateOvertimeRequest 已完成),不因補休轉換失敗 rollback。
 * 但讓 endpoint 能在 response 帶 warning、HR 看 admin_audit_note 知道補休沒建起來。
 *
 * 第二層 try/catch 包住 audit / notify、record 失敗不可再 throw(避免 caller 連鎖崩潰)。
 *
 * Repo 介面契約(本 wrapper):
 *   (繼承 convertOvertimeToCompTime 需要的 method)
 *   appendOvertimeAuditNote(id, line): 可選、有就用、寫不進去吞錯
 *   notifyCompConversionFailure({ overtime_request_id, employee_id, error }): 可選
 */
export async function convertOvertimeToCompTimeSafe(repo, overtimeRequest) {
  try {
    const comp_balance = await convertOvertimeToCompTime(repo, overtimeRequest);
    return { ok: true, comp_balance, warning: null };
  } catch (e) {
    console.error('[convertOvertimeToCompTimeSafe] convert failed:', e.message);

    // durable audit:寫進 overtime_requests.admin_audit_note(HR 後台看得到)
    if (overtimeRequest?.id && typeof repo?.appendOvertimeAuditNote === 'function') {
      try {
        const today = new Date().toISOString().slice(0, 10);
        const line = `[${today}] ⚠ 補休轉換失敗:${e.message}。加班已核准但未建立補休餘額,需 HR 介入(手動執行 grant 或調整 compensation_type)。`;
        await repo.appendOvertimeAuditNote(overtimeRequest.id, line);
      } catch (auditErr) {
        console.error('[convertOvertimeToCompTimeSafe] audit write failed:', auditErr.message);
        // 不可再 throw — 記錄失敗也只能算了,至少 console.error 留軌跡
      }
    }

    // notify HR(可選):通知 helper 不存在就跳過
    if (typeof repo?.notifyCompConversionFailure === 'function') {
      try {
        await repo.notifyCompConversionFailure({
          overtime_request_id: overtimeRequest?.id,
          employee_id: overtimeRequest?.employee_id,
          error: e.message,
        });
      } catch (notifyErr) {
        console.error('[convertOvertimeToCompTimeSafe] notify failed:', notifyErr.message);
      }
    }

    return {
      ok: false,
      comp_balance: null,
      warning: {
        code: 'COMP_CONVERSION_FAILED',
        message: '加班已核准,但補休餘額建立失敗,請聯繫 HR。',
        detail: e.message,
      },
    };
  }
}
