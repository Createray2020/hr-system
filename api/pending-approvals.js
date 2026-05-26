// api/pending-approvals.js
// GET /api/pending-approvals
// 統一聚合「待我審批」list、合併 approval_steps 跟 leave_requests 兩個 source。
// caller-aware、依 caller role 自動分支:
//   manager:      approval_steps step=1 + leave_requests pending_mgr (兩邊都 dept-scope)
//   ceo/chairman: approval_steps step=2 role=ceo + leave_requests pending_ceo
//   hr:           approval_steps step=3 role=hr  + leave_requests []
//   admin / employee: 403
//
// 回統一 schema:
//   { source: 'approval'|'leave', id, request_id, title, applicant_name,
//     applicant_dept_name, applicant_avatar, created_at, ...source-specific 欄位 }
// 排序: created_at DESC

import { supabaseAdmin } from '../lib/supabase.js';
import { requireAuth } from '../lib/auth.js';
import { addDeptNameNested, addDeptNameSingle } from '../lib/dept-name-mapper.js';
import { resolveAuthScopeWithDeptIds, makeDeptEmpIdsRepo } from '../lib/auth-scope.js';

// 本 endpoint 的「pending 待審」context:admin 視為非審批角色、回 403
// (跟 lib/roles.js BACKOFFICE_ROLES 不同、後者含 admin、用於更廣的「後台 access」)
const PENDING_APPROVER_ROLES = ['hr', 'ceo', 'chairman'];

function canViewPending(u) {
  if (!u) return false;
  return PENDING_APPROVER_ROLES.includes(u.role) || u.is_manager === true;
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const caller = await requireAuth(req, res);
  if (!caller) return;

  if (!canViewPending(caller)) {
    return res.status(403).json({ error: 'Forbidden:無權限查看待審批列表' });
  }

  // Effective role(對齊 approvals.js line 91-99 + line 100 chairman→ceo)
  const callerEffRole = caller.is_manager ? 'manager' : caller.role;
  const approvalStepNum = callerEffRole === 'manager' ? 1
                       : (callerEffRole === 'ceo' || callerEffRole === 'chairman') ? 2
                       : 3;
  const approvalRole = callerEffRole === 'chairman' ? 'ceo' : callerEffRole;
  const leaveStage = callerEffRole === 'manager' ? 'pending_mgr'
                  : (callerEffRole === 'ceo' || callerEffRole === 'chairman') ? 'pending_ceo'
                  : null;

  const scope = await resolveAuthScopeWithDeptIds(
    caller, 'selfOrDept', makeDeptEmpIdsRepo(supabaseAdmin),
  );

  // ── 1. 撈 approval_steps ──
  const { data: stepsRaw, error: stepsErr } = await supabaseAdmin
    .from('approval_steps')
    .select('*, approval_requests(*, employees!applicant_id(name, dept_id, position, avatar, departments(name)))')
    .eq('step_number', approvalStepNum)
    .eq('approver_role', approvalRole)
    .eq('status', 'in_progress')
    .order('created_at', { ascending: false });

  if (stepsErr) return res.status(500).json({ error: 'approvals query failed: ' + stepsErr.message });

  let steps = stepsRaw || [];
  // dept-scope filter for manager(approvals.js 原本沒做、本 facade 補上)
  // TODO: 大 dataset 時改 supabase server-side filter、目前 manager dept 量級小、JS filter 足夠
  if (callerEffRole === 'manager' && scope.mode === 'dept') {
    const allowedEmpIds = new Set([scope.selfId, ...(scope.deptEmpIds || [])]);
    steps = steps.filter(s =>
      s.approval_requests && allowedEmpIds.has(s.approval_requests.applicant_id)
    );
  }
  addDeptNameNested(steps, 'employees', 'approval_requests');

  // ── 2. 撈 leave_requests ──
  let leaves = [];
  if (leaveStage) {
    let leaveQ = supabaseAdmin
      .from('leave_requests')
      .select('id, employee_id, leave_type, start_at, end_at, hours, applied_at, status, reason, late_application, proof_status, proof_due_at, attachment_url, employees!employee_id(name, dept_id, position, avatar, departments(name))')
      .is('deleted_at', null)
      .eq('status', leaveStage)
      .order('applied_at', { ascending: false });

    if (callerEffRole === 'manager' && scope.mode === 'dept') {
      leaveQ = leaveQ.in('employee_id', [scope.selfId, ...(scope.deptEmpIds || [])]);
    }

    const { data: leavesRaw, error: leavesErr } = await leaveQ;
    if (leavesErr) return res.status(500).json({ error: 'leaves query failed: ' + leavesErr.message });
    leaves = leavesRaw || [];
    for (const l of leaves) {
      if (l.employees) addDeptNameSingle(l.employees);
    }
  }

  // ── 3. Normalize 成統一 schema ──
  const unified = [
    ...steps.map(s => {
      const r = s.approval_requests || {};
      const emp = r.employees || {};
      return {
        source: 'approval',
        id: s.id,
        request_id: r.id || s.request_id,
        request_type: r.request_type,
        title: r.title,
        applicant_id: r.applicant_id,
        applicant_name: emp.name || null,
        applicant_dept_name: emp.dept_name || null,
        applicant_position: emp.position || null,
        applicant_avatar: emp.avatar || null,
        step_number: s.step_number,
        step_name: s.step_name,
        approver_role: s.approver_role,
        created_at: r.created_at,
      };
    }),
    ...leaves.map(l => {
      const emp = l.employees || {};
      return {
        source: 'leave',
        id: l.id,
        request_id: l.id,
        request_type: 'leave',
        title: `請假申請(${l.leave_type})`,
        applicant_id: l.employee_id,
        applicant_name: emp.name || null,
        applicant_dept_name: emp.dept_name || null,
        applicant_position: emp.position || null,
        applicant_avatar: emp.avatar || null,
        leave_type: l.leave_type,
        start_at: l.start_at,
        end_at: l.end_at,
        hours: l.hours,
        reason: l.reason,
        late_application: l.late_application,
        proof_status: l.proof_status,
        proof_due_at: l.proof_due_at,
        attachment_url: l.attachment_url,
        stage: l.status,
        created_at: l.applied_at,
      };
    }),
  ];

  unified.sort((a, b) => {
    const tA = a.created_at ? new Date(a.created_at).getTime() : 0;
    const tB = b.created_at ? new Date(b.created_at).getTime() : 0;
    return tB - tA;
  });

  return res.status(200).json(unified);
}
