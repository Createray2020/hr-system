// api/leaves/[id].js
// PUT    /api/leaves/:id  body { decision: 'approve'|'reject'|'terminate', reject_reason?, override_reason? }
//                          body { action: 'archive' }                       — HR 歸檔
//                          body { action: 'submit_proof', proof_url: ... }  — 員工 / HR 上傳證明
// DELETE /api/leaves/:id  → 員工本人撤回 pending_mgr / pending_ceo
//
// Phase 1.3:多階審核 stage-aware approve / reject + archive + submit_proof。
// Backward compat:舊 'pending' status 視為 'pending_mgr' 處理。
//
// 員工撤回走 DELETE 路徑、admin cancel endpoint Phase 1.6.1 拔除
// (YAGNI、真有需求再開新 endpoint、不要保留半成品 hack)

import { requireAuth, requireRole } from '../../lib/auth.js';
import { BACKOFFICE_ROLES } from '../../lib/roles.js';
import {
  approveLeaveRequest, rejectLeaveRequest, cancelLeaveRequest,
} from '../../lib/leave/request-flow.js';
import {
  canReview, canCancel, canArchive, canTerminate,
  canApprove, canReject,
  transitionApprove, transitionArchive, transitionTerminate,
} from '../../lib/leave/stages.js';
import { sendPushToEmployees, createNotifications } from '../../lib/push.js';
import { makeLeaveRepo } from './_repo.js';

/** 'pending'(legacy)→ 'pending_mgr'。其他原樣。
 *
 *  Phase 1.5 cleanup 後 prod 已無 'pending' row、CHECK 也移除 'pending'、
 *  legacy POST(api/leaves/index.js)也改寫 'pending_mgr'。理論上此函式回傳
 *  永遠不會走 status==='pending' branch。保留作 read-side safety net、
 *  防舊 export / 未來 hot-fix 直接 INSERT 'pending' 的漏網路徑、無害且清楚。 */
function normalizeStage(status) {
  return status === 'pending' ? 'pending_mgr' : status;
}

/** admin_edit audit log:把欄位 oldVal/newVal 印成短字串、長字串截斷。 */
function formatAuditVal(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'string' && v.length > 30) return v.slice(0,27) + '...';
  return String(v);
}

/** push 通知 helper(維持舊行為) */
async function notifyLeaveStatus(repo, requestRow, id) {
  try {
    if (!requestRow?.employee_id) return;
    let typeName = requestRow.leave_type;
    try {
      const lt = await repo.findLeaveType(requestRow.leave_type);
      if (lt?.name_zh) typeName = lt.name_zh;
    } catch (_) {}
    const titleMap = {
      approved: '✅ 假單已核准',
      rejected: '❌ 假單已退回',
      cancelled: '↩ 假單已撤回',
      archived:  '📦 假單已歸檔',
      pending_ceo: '⏳ 已轉給執行長',
      terminated: '📛 假單已由 HR 終止',
    };
    const status = requestRow.status;
    const bodyMap = {
      approved: '已核准',
      rejected: '已被退回',
      cancelled: '已撤回',
      archived: '已歸檔',
      pending_ceo: '主管已批、轉執行長審核',
      terminated: '因證明逾期已由 HR 終止',
    };
    const payload = {
      title: titleMap[status] || '假單異動',
      body:  `${typeName} 申請${bodyMap[status] || '狀態變更'}`,
      url:   '/leave',
      tag:   'leave-' + id,
    };
    sendPushToEmployees([requestRow.employee_id], payload).catch(() => {});
    createNotifications([requestRow.employee_id], { ...payload, type: 'leave' }).catch(() => {});
  } catch (_) {}
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  const id = req.query.id;
  if (!id) return res.status(400).json({ error: 'leave id required' });

  const repo = makeLeaveRepo();

  // ─── DELETE 員工本人撤回 ─────────────────────────────────────
  if (req.method === 'DELETE') {
    const caller = await requireAuth(req, res);
    if (!caller) return;
    try {
      const req_ = await repo.findLeaveRequestById(id);
      if (!req_) return res.status(404).json({ error: 'NOT_FOUND' });
      if (!canCancel({ id: caller.id }, { ...req_, status: normalizeStage(req_.status) })) {
        return res.status(403).json({ error: 'Cannot cancel:本人 + pending 階段才能撤回' });
      }
      const r = await cancelLeaveRequest(repo, { request_id: id, cancelled_by: caller.id });
      if (!r.ok) return res.status(400).json(r);
      return res.status(200).json({ ok: true, request: r.request });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (req.method !== 'PUT') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = req.body || {};
  const { decision, reject_reason, override_reason, action, proof_url } = body;

  // ─── PUT action='submit_proof' 員工 / HR 上傳證明 ──────────────
  if (action === 'submit_proof') {
    const caller = await requireAuth(req, res);
    if (!caller) return;
    const leaveRequest = await repo.findLeaveRequestById(id);
    if (!leaveRequest) return res.status(404).json({ error: 'NOT_FOUND' });

    const isOwn = leaveRequest.employee_id === caller.id;
    const isElevated = ['hr', 'admin'].includes(caller.role);
    if (!isOwn && !isElevated) {
      return res.status(403).json({ error: 'Forbidden:本人或 HR 才能上傳證明' });
    }
    if (leaveRequest.proof_status !== 'required') {
      return res.status(400).json({ error: 'INVALID_PROOF_STATUS', actual: leaveRequest.proof_status });
    }
    if (!proof_url || !String(proof_url).trim()) {
      return res.status(400).json({ error: 'proof_url required' });
    }
    try {
      const updated = await repo.updateLeaveRequest(id, {
        proof_url: String(proof_url).trim(),
        proof_status: 'submitted',
      });
      return res.status(200).json({ ok: true, request: updated });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ─── PUT action='admin_edit' HR / CEO / chairman 手動編輯既有 leave row ──
  // 用途:cron / 業務流程偶發 bug 後的人工修正、或員工提錯假別事後改正。
  // 範圍故意限縮:只開 leave_type / proof_status / proof_due_at 三個欄位、
  // 不開 status / 時間 / 員工 / hours(這些動了會破壞 state machine 或 balance、要走既有 flow)。
  // 故意不 cascade:改 leave_type='sick' 時不會自動把 proof_status 改 'required'、
  //                HR 要自己 call 第二次 admin_edit 一併處理 proof_status / proof_due_at。
  if (action === 'admin_edit') {
    const caller = await requireRole(req, res, ['hr', 'admin', 'ceo', 'chairman']);
    if (!caller) return;

    const leaveRequest = await repo.findLeaveRequestById(id);
    if (!leaveRequest) return res.status(404).json({ error: 'NOT_FOUND' });

    // 禁止改的欄位:body 帶到就 reject(defense in depth)
    const FORBIDDEN_FIELDS = ['status', 'start_at', 'end_at', 'start_date', 'end_date',
                               'hours', 'finalized_hours', 'days', 'employee_id', 'id'];
    for (const f of FORBIDDEN_FIELDS) {
      if (body[f] !== undefined) {
        return res.status(400).json({
          error: 'FORBIDDEN_FIELD',
          detail: `admin_edit 不能改 ${f}、請走既有 flow(reject / cancel / terminate / approve / 代提)`,
        });
      }
    }

    // 允許改的欄位 white list
    const ALLOWED_FIELDS = ['leave_type', 'proof_status', 'proof_due_at'];
    const patch = {};
    const auditEntries = [];

    for (const field of ALLOWED_FIELDS) {
      if (body[field] === undefined) continue;
      const newVal = body[field];
      const oldVal = leaveRequest[field];
      if (newVal === oldVal) continue;  // 無改動跳過
      patch[field] = newVal;
      auditEntries.push(`${field} ${formatAuditVal(oldVal)}→${formatAuditVal(newVal)}`);
    }

    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ error: 'NO_CHANGES', detail: '至少要改一個欄位 (leave_type / proof_status / proof_due_at)' });
    }

    // 驗證 leave_type 存在
    if (patch.leave_type !== undefined) {
      const lt = await repo.findLeaveType(patch.leave_type);
      if (!lt) {
        return res.status(400).json({ error: 'INVALID_LEAVE_TYPE', detail: `leave_type ${patch.leave_type} 不存在於 leave_types` });
      }
    }

    // 驗證 proof_status enum
    if (patch.proof_status !== undefined) {
      const VALID_PROOF_STATUS = ['not_required', 'required', 'submitted', 'expired', 'converted_to_personal'];
      if (!VALID_PROOF_STATUS.includes(patch.proof_status)) {
        return res.status(400).json({
          error: 'INVALID_PROOF_STATUS',
          detail: `proof_status 必須是 ${VALID_PROOF_STATUS.join(' / ')}`,
        });
      }
    }

    // 驗證 proof_due_at ISO timestamp 或 null
    if (patch.proof_due_at !== undefined && patch.proof_due_at !== null) {
      const t = Date.parse(patch.proof_due_at);
      if (!Number.isFinite(t)) {
        return res.status(400).json({ error: 'INVALID_PROOF_DUE_AT', detail: 'proof_due_at 必須是 ISO timestamp 或 null' });
      }
    }

    // audit handler_note
    const now = new Date().toISOString();
    const auditLine = `[${now.slice(0,10)}] ${caller.id} admin_edit: ${auditEntries.join('、')}`;
    patch.handler_note = leaveRequest.handler_note
      ? `${leaveRequest.handler_note}\n${auditLine}`
      : auditLine;

    try {
      const updated = await repo.updateLeaveRequest(id, patch);
      return res.status(200).json({ ok: true, request: updated, audit: auditLine });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ─── 以下:approve / reject / cancel / archive 都需要主管以上 ──
  const caller = await requireRole(req, res, BACKOFFICE_ROLES, { allowManager: true });
  if (!caller) return;
  const callerId = caller.id;

  // ─── PUT action='archive' HR 歸檔 ────────────────────────────
  if (action === 'archive') {
    const leaveRequest = await repo.findLeaveRequestById(id);
    if (!leaveRequest) return res.status(404).json({ error: 'NOT_FOUND' });
    if (!canArchive(caller, leaveRequest)) {
      return res.status(403).json({ error: 'Cannot archive:HR/admin + status=approved 才能歸檔' });
    }
    let nextStage;
    try { nextStage = transitionArchive(leaveRequest.status); }
    catch (e) { return res.status(400).json({ error: e.message }); }

    try {
      const updated = await repo.updateLeaveRequest(id, {
        status: nextStage,
        archived_by: callerId,
        archived_at: new Date().toISOString(),
      });
      await notifyLeaveStatus(repo, updated, id);
      return res.status(200).json({ ok: true, request: updated });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ─── PUT decision approve / reject / terminate ───────────────
  if (!['approve', 'reject', 'terminate'].includes(decision)) {
    return res.status(400).json({ error: 'decision must be approve / reject / terminate (or action archive / submit_proof)' });
  }

  try {
    let r;
    if (decision === 'approve') {
      r = await handleApprove({ repo, id, callerId, caller, body, override_reason });
    } else if (decision === 'reject') {
      r = await handleReject({ repo, id, callerId, caller, reject_reason });
    } else {
      r = await handleTerminate({ repo, id, callerId, caller });
    }
    if (!r.ok) {
      // canReview / canArchive / canTerminate 失敗的特殊回 403
      if (r.reason === 'FORBIDDEN') return res.status(403).json(r);
      // Phase 1.6:proof_status='expired' guard 擋下的 approve / reject / 不合格的 terminate
      if (r.reason === 'NOT_ELIGIBLE_TO_APPROVE'   ||
          r.reason === 'NOT_ELIGIBLE_TO_REJECT'    ||
          r.reason === 'NOT_ELIGIBLE_TO_TERMINATE') {
        return res.status(422).json(r);
      }
      return res.status(400).json(r);
    }
    await notifyLeaveStatus(repo, r.request, id);
    return res.status(200).json({ ok: true, request: r.request });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

// ─── multi-stage approve ───────────────────────────────────────
async function handleApprove({ repo, id, callerId, caller, body, override_reason }) {
  const leaveRequest = await repo.findLeaveRequestById(id);
  if (!leaveRequest) return { ok: false, reason: 'NOT_FOUND' };

  const stage = normalizeStage(leaveRequest.status);
  if (stage !== 'pending_mgr' && stage !== 'pending_ceo') {
    return { ok: false, reason: 'NOT_PENDING', actual: leaveRequest.status };
  }

  // canReview 需要 employee_dept_id(Phase 2.x dept+is_manager 嚴格設計)、從 employees 表撈
  const employee = await repo.findEmployeeById(leaveRequest.employee_id);
  const reviewable = {
    ...leaveRequest,
    status: stage,
    employee_dept_id: employee?.dept_id || null,
  };
  if (!canReview(caller, reviewable)) {
    return { ok: false, reason: 'FORBIDDEN', detail: 'Cannot review at stage ' + stage };
  }
  // Phase 1.6:proof 過期的 row 強迫走 terminate、不能 approve
  if (!canApprove(caller, reviewable)) {
    return { ok: false, reason: 'NOT_ELIGIBLE_TO_APPROVE',
             detail: 'Cannot approve row with proof_status=expired (use decision=terminate)' };
  }

  let nextStage;
  try { nextStage = transitionApprove(stage); }
  catch (e) { return { ok: false, reason: 'INVALID_TRANSITION', detail: e.message }; }

  const now = new Date().toISOString();

  // override 紀錄(申請是 late_application=true 且 caller 提供 override_reason)
  const overrideExtras = (leaveRequest.late_application && override_reason && String(override_reason).trim())
    ? { override_by: callerId, override_at: now, override_reason: String(override_reason).trim() }
    : {};

  if (nextStage === 'pending_ceo') {
    // 主管審完、推給執行長。不扣餘額。
    // 注意:DB 上的實際 status 可能是 'pending'(legacy)、用 .eq('status', stage_actual) 會抓不到、
    // 直接 updateLeaveRequest by id 沒 status 條件、安全。
    const updated = await repo.updateLeaveRequest(id, {
      status: 'pending_ceo',
      mgr_reviewed_by: callerId,
      mgr_reviewed_at: now,
      mgr_decision: 'approved',
      ...overrideExtras,
    });
    return { ok: true, request: updated };
  }

  // nextStage === 'approved':執行長最終批、扣餘額
  const stageExtras = {
    ceo_reviewed_by: callerId,
    ceo_reviewed_at: now,
    ceo_decision: 'approved',
    ...overrideExtras,
  };
  // approveLeaveRequest 內部會驗 status === expected_status、扣餘額、寫 status='approved'+ patch_extras
  return approveLeaveRequest(repo, {
    request_id: id,
    approved_by: callerId,
    expected_status: leaveRequest.status, // 用實際 status (可能是 'pending' 或 'pending_ceo')
    patch_extras: stageExtras,
  });
}

// ─── multi-stage reject ────────────────────────────────────────
async function handleReject({ repo, id, callerId, caller, reject_reason }) {
  if (!reject_reason || !String(reject_reason).trim()) {
    return { ok: false, reason: 'REJECT_REASON_REQUIRED' };
  }
  const leaveRequest = await repo.findLeaveRequestById(id);
  if (!leaveRequest) return { ok: false, reason: 'NOT_FOUND' };

  const stage = normalizeStage(leaveRequest.status);
  if (stage !== 'pending_mgr' && stage !== 'pending_ceo') {
    return { ok: false, reason: 'NOT_PENDING', actual: leaveRequest.status };
  }

  const employee = await repo.findEmployeeById(leaveRequest.employee_id);
  const reviewable = {
    ...leaveRequest,
    status: stage,
    employee_dept_id: employee?.dept_id || null,
  };
  if (!canReview(caller, reviewable)) {
    return { ok: false, reason: 'FORBIDDEN', detail: 'Cannot reject at stage ' + stage };
  }
  // Phase 1.6:proof 過期的 row 強迫走 terminate、不能 reject
  if (!canReject(caller, reviewable)) {
    return { ok: false, reason: 'NOT_ELIGIBLE_TO_REJECT',
             detail: 'Cannot reject row with proof_status=expired (use decision=terminate)' };
  }

  const now = new Date().toISOString();
  const trimmedReason = String(reject_reason).trim();
  const stageExtras = stage === 'pending_mgr'
    ? { mgr_reviewed_by: callerId, mgr_reviewed_at: now, mgr_decision: 'rejected', mgr_reject_reason: trimmedReason }
    : { ceo_reviewed_by: callerId, ceo_reviewed_at: now, ceo_decision: 'rejected', ceo_reject_reason: trimmedReason };

  return rejectLeaveRequest(repo, {
    request_id: id,
    rejected_by: callerId,
    reject_reason: trimmedReason,
    expected_status: leaveRequest.status,
    patch_extras: stageExtras,
  });
}

// ─── Phase 1.6:HR 終止 expired row ──────────────────────────────
async function handleTerminate({ repo, id, callerId, caller }) {
  const leaveRequest = await repo.findLeaveRequestById(id);
  if (!leaveRequest) return { ok: false, reason: 'NOT_FOUND' };

  if (!canTerminate(caller, leaveRequest)) {
    return { ok: false, reason: 'NOT_ELIGIBLE_TO_TERMINATE',
             detail: 'terminate requires hr/admin + status pending_* + proof_status=expired',
             actual_status: leaveRequest.status,
             actual_proof_status: leaveRequest.proof_status };
  }

  let nextStage;
  try { nextStage = transitionTerminate(leaveRequest.status); }
  catch (e) { return { ok: false, reason: 'INVALID_TRANSITION', detail: e.message }; }

  const now = new Date().toISOString();
  const noteAppendix = `[${now.slice(0,10)}] HR 終止申請(證明已過期)`;
  const newNote = leaveRequest.handler_note
    ? `${leaveRequest.handler_note}\n${noteAppendix}`
    : noteAppendix;

  const updated = await repo.updateLeaveRequest(id, {
    status: nextStage,            // 'terminated'
    terminated_by: callerId,
    terminated_at: now,
    handler_note: newNote,
    // proof_status 保留 'expired'(歷史紀錄、為「為何被終止」的依據)
  });
  return { ok: true, request: updated };
}
