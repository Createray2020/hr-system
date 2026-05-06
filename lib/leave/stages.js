// lib/leave/stages.js — 多階審核 state machine + role 權限(純函式)
//
// 對應 schema:leave_requests.status enum(Phase 1.5 cleanup 後 6 值 + Phase 1.6 加 terminated)
//   'pending_mgr'     等主管審
//   'pending_ceo'     主管已批、等執行長審
//   'approved'        執行長已批、待 HR 歸檔
//   'archived'        HR 已歸檔(approved → archived 嚴守、最終)
//   'rejected'        任一階拒絕(最終)
//   'cancelled'       員工撤回(最終)
//   'terminated'      HR 終止 expired row(Phase 1.6、最終)
// (legacy 'pending' 在 Phase 1.5 cleanup 已從 CHECK 拔除、normalizeStage 仍保留 read-side safety net)
//
// 對應 employee 形狀:{ id, role, is_manager, manager_id, ... }
// 對應 leaveRequest 形狀:{ employee_id, status, employee_manager_id?, ... }
//   (employee_manager_id 由 caller 從 employees JOIN flatten 過來、簡化 state machine)

const ELEVATED_ROLES   = new Set(['ceo', 'chairman', 'hr', 'admin']);
const ARCHIVE_ROLES    = new Set(['hr', 'admin']);
const OVERRIDE_ROLES   = new Set(['ceo', 'chairman', 'hr', 'admin']);
const TERMINATE_ROLES  = new Set(['hr', 'admin']);
const PENDING_STAGES   = new Set(['pending_mgr', 'pending_ceo']);

/**
 * 員工送出時的初始 stage。
 *   role='ceo' / 'chairman' → 'approved'(自批、跳所有階、HR 之後 archive)
 *   is_manager=true        → 'pending_ceo'(跳 mgr 階、直接讓執行長審)
 *   一般員工                → 'pending_mgr'
 */
export function getInitialStage(employee) {
  if (!employee) throw new Error('employee required');
  if (employee.role === 'ceo' || employee.role === 'chairman') return 'approved';
  if (employee.is_manager === true) return 'pending_ceo';
  return 'pending_mgr';
}

/**
 * reviewer 能否審某筆 leaveRequest 在當前 stage。
 *   pending_mgr 階:reviewer.id === request.employee_manager_id 或 elevated role(往下批)
 *   pending_ceo 階:elevated role(ceo / chairman / hr / admin)
 *   非 pending_* 階:永遠 false
 */
export function canReview(reviewer, leaveRequest) {
  if (!reviewer || !leaveRequest) return false;
  const stage = leaveRequest.status;
  if (stage !== 'pending_mgr' && stage !== 'pending_ceo') return false;

  // elevated role 任何 pending_* 階都能批(高層往下批)
  if (ELEVATED_ROLES.has(reviewer.role)) return true;

  // pending_mgr:必須是直屬主管
  if (stage === 'pending_mgr') {
    return !!leaveRequest.employee_manager_id
        && reviewer.id === leaveRequest.employee_manager_id;
  }

  // pending_ceo 階非 elevated 無權審
  return false;
}

/**
 * approve 後的下一個 stage。invalid 時 throw。
 */
export function transitionApprove(currentStage) {
  if (currentStage === 'pending_mgr') return 'pending_ceo';
  if (currentStage === 'pending_ceo') return 'approved';
  throw new Error(`cannot approve from stage: ${currentStage}`);
}

/**
 * reject 後的 stage。invalid 時 throw。
 */
export function transitionReject(currentStage) {
  if (currentStage === 'pending_mgr' || currentStage === 'pending_ceo') return 'rejected';
  throw new Error(`cannot reject from stage: ${currentStage}`);
}

/**
 * 員工撤回:本人 + 在 pending_mgr / pending_ceo 階段。
 */
export function canCancel(actor, leaveRequest) {
  if (!actor || !leaveRequest) return false;
  if (actor.id !== leaveRequest.employee_id) return false;
  return leaveRequest.status === 'pending_mgr' || leaveRequest.status === 'pending_ceo';
}

/**
 * HR 歸檔:HR / admin role + status='approved'。
 */
export function canArchive(actor, leaveRequest) {
  if (!actor || !leaveRequest) return false;
  if (!ARCHIVE_ROLES.has(actor.role)) return false;
  return leaveRequest.status === 'approved';
}

/**
 * archive 後的 stage。invalid 時 throw。
 */
export function transitionArchive(currentStage) {
  if (currentStage === 'approved') return 'archived';
  throw new Error(`cannot archive from stage: ${currentStage}`);
}

/**
 * Override:審批人即便發現 late_application=true 也願意核准、可以 mark override。
 *   is_manager=true 或 role IN ('hr','ceo','chairman','admin')
 */
export function canOverride(actor) {
  if (!actor) return false;
  if (actor.is_manager === true) return true;
  return OVERRIDE_ROLES.has(actor.role);
}

/**
 * Phase 1.6:HR 終止 expired row。
 *   role hr/admin + status ∈ {pending_mgr, pending_ceo} + proof_status='expired'
 *
 * 設計:expired guard 強制 — 只有「Phase 1.5 cron 標 expired 但 status 仍 pending」的死 row
 * 能被終止。不允許 HR 用 terminate 隨意踢任意 pending row(那該走 reject)。
 */
export function canTerminate(actor, leaveRequest) {
  if (!actor || !leaveRequest) return false;
  if (!TERMINATE_ROLES.has(actor.role)) return false;
  if (!PENDING_STAGES.has(leaveRequest.status)) return false;
  return leaveRequest.proof_status === 'expired';
}

/**
 * terminate 後的 stage。invalid 時 throw。
 */
export function transitionTerminate(currentStage) {
  if (PENDING_STAGES.has(currentStage)) return 'terminated';
  throw new Error(`cannot terminate from stage: ${currentStage}`);
}

/**
 * Phase 1.6:approve / reject 對 expired row 的 guard。
 *   canReview 是 base permission(role + stage 可審)、
 *   canApprove / canReject 是「能不能對這筆 row 做動作」(包 expired guard)。
 *
 *   proof_status='expired' → false(強迫 HR 走 terminate、不要對死 row 假裝核准 / 拒絕)
 *   其他狀況 → 委任給 canReview
 */
export function canApprove(actor, leaveRequest) {
  if (!canReview(actor, leaveRequest)) return false;
  if (leaveRequest.proof_status === 'expired') return false;
  return true;
}

export function canReject(actor, leaveRequest) {
  if (!canReview(actor, leaveRequest)) return false;
  if (leaveRequest.proof_status === 'expired') return false;
  return true;
}
