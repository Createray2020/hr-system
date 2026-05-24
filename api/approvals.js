// api/approvals.js
// GET  /api/approvals?type=configs                              → 所有申請類型設定
// GET  /api/approvals?id=XXX                                   → 單筆詳情（含步驟）
// GET  /api/approvals?type=list&applicant_id=XXX               → 我的申請
// GET  /api/approvals?type=pending&role=manager                → 待我審批
// GET  /api/approvals                                          → 全部申請
// POST /api/approvals { action: create|approve|reject|cancel|update_config }
//
// Phase 2.x.1 hotfix(CRITICAL):原本整支 handler 完全無 requireAuth,
// 任何人(甚至 unauthed)可批 / 拒 / 取消任何 request、approver_id 由 client 傳。
// 修補:
//   1. 加 requireAuth(任何 authed user 都能讀、寫加分項權限)
//   2. approve/reject 加 step role gate(對齊 effectiveApprovalRole + dept)
//   3. self-approval guard(applicant 不能簽自己的 request)
//   4. 跨 step 同人連簽 guard(避免主管 + ceo 同人雙簽)
//   5. approver_id 強制用 caller.id、不接受 client 傳
//   6. cancel 嚴守申請人本人(其他 role 不能取消別人的)

import { supabaseAdmin } from '../lib/supabase.js';
import { requireAuth } from '../lib/auth.js';
import { sendPushToEmployees, sendPushToRoles, createNotifications, createNotificationsForRoles } from '../lib/push.js';
import { addDeptNameNested, addDeptNameSingle } from '../lib/dept-name-mapper.js';
// B13:GET 5 個 path 加 dept-scope / 本人 / HR-only 守門
import { resolveAuthScopeWithDeptIds, makeDeptEmpIdsRepo, canSeeEmployee } from '../lib/auth-scope.js';
import { isBackofficeRole } from '../lib/roles.js';

/**
 * canApproveStep — caller 能否簽某 step。
 *
 * 規則(對齊 leave Phase 2.x dept+is_manager 嚴格設計):
 *   step.approver_role='manager':caller.is_manager=true && caller.dept_id === applicant.dept_id
 *   step.approver_role='ceo':    caller.role IN ('ceo','chairman')(admin 不視同)
 *   step.approver_role='hr':     caller.role === 'hr'(admin 不視同)
 *   其他 role:caller.role === step.approver_role 嚴格對等
 *
 * self-approval 在外層擋(此函式只檢 role + dept、不看 applicant id)。
 */
function canApproveStep(caller, step, applicantDeptId) {
  if (!caller || !caller.id || !step) return false;
  const r = step.approver_role;
  if (r === 'manager') {
    return caller.is_manager === true
        && !!caller.dept_id
        && !!applicantDeptId
        && caller.dept_id === applicantDeptId;
  }
  if (r === 'ceo')  return caller.role === 'ceo' || caller.role === 'chairman';
  if (r === 'hr')   return caller.role === 'hr';
  return caller.role === r;
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Phase 2.x.1:整支 handler 加 requireAuth(原本完全無 auth、CRITICAL bug)
  const caller = await requireAuth(req, res);
  if (!caller) return;

  if (req.method === 'GET') {
    const { type, id, applicant_id, role, request_type } = req.query;

    // ── 申請類型設定 ────────────────────────────────────────────────────────
    // configs 是公開的流程定義(表單欄位 / 步驟 role)、不含個資、不需 scope
    if (type === 'configs') {
      const { data, error } = await supabaseAdmin
        .from('approval_flow_configs')
        .select('*').eq('is_active', true)
        .order('category').order('id');
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json(data);
    }

    // B13:其餘 GET path 共用 scope(selfOrDept、對齊 leaves / employees endpoint)
    const scope = await resolveAuthScopeWithDeptIds(
      caller, 'selfOrDept', makeDeptEmpIdsRepo(supabaseAdmin),
    );

    // ── 單筆申請詳情（含步驟） ───────────────────────────────────────────────
    if (id) {
      const { data: reqData, error } = await supabaseAdmin
        .from('approval_requests')
        .select('*, employees!applicant_id(name, dept_id, position, avatar, departments(name))')
        .eq('id', id).single();
      if (error) return res.status(404).json({ error: '找不到申請' });
      // B13:申請人本人 OR scope 看得到該員工 → OK,否則 403
      if (reqData.applicant_id !== caller.id && !canSeeEmployee(scope, reqData.applicant_id)) {
        return res.status(403).json({ error: '無權看此申請' });
      }
      if (reqData?.employees) addDeptNameSingle(reqData.employees);

      const { data: steps } = await supabaseAdmin
        .from('approval_steps')
        .select('*, employees!approver_id(name, position)')
        .eq('request_id', id).order('step_number');

      return res.status(200).json({ ...reqData, steps: steps || [] });
    }

    // ── 我的申請列表 ────────────────────────────────────────────────────────
    if (type === 'list' && applicant_id) {
      // B13:本人 OR scope 內 OK,亂猜別人 applicant_id → 403
      if (applicant_id !== caller.id && !canSeeEmployee(scope, applicant_id)) {
        return res.status(403).json({ error: '無權看此員工申請' });
      }
      let q = supabaseAdmin.from('approval_requests')
        .select('*').eq('applicant_id', applicant_id)
        .order('created_at', { ascending: false });
      if (request_type) q = q.eq('request_type', request_type);
      const { data, error } = await q;
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json(data);
    }

    // ── 待我審批（依角色取對應步驟） ──────────────────────────────────────────
    if (type === 'pending' && role) {
      const stepNum = role === 'manager' ? 1 : role === 'ceo' || role === 'chairman' ? 2 : 3;
      const { data: stepsRaw, error } = await supabaseAdmin
        .from('approval_steps')
        .select('*, approval_requests(*, employees!applicant_id(name, dept_id, position, avatar, departments(name)))')
        .eq('step_number', stepNum)
        .eq('approver_role', role === 'chairman' ? 'ceo' : role)
        .eq('status', 'in_progress')
        .order('created_at', { ascending: false });
      if (error) return res.status(500).json({ error: error.message });

      // B13:role='manager' 時 JS-side dept-scope filter(對齊 api/pending-approvals.js)
      // 注意:大 dataset 時應改 supabase server-side filter、目前 manager dept 量級小、JS 足夠
      let steps = stepsRaw || [];
      if (role === 'manager') {
        if (scope.mode === 'dept') {
          const allowed = new Set([scope.selfId, ...(scope.deptEmpIds || [])]);
          steps = steps.filter(s => s.approval_requests && allowed.has(s.approval_requests.applicant_id));
        } else if (scope.mode === 'self') {
          // 邊角:is_manager 但無 dept_id(資料異常)→ 看不到任何 pending
          steps = [];
        }
        // mode='all' (HR/CEO 偽 manager 查詢、極少)→ 不 filter
      }
      addDeptNameNested(steps, 'employees', 'approval_requests');
      return res.status(200).json(steps);
    }

    // ── 全部申請 ────────────────────────────────────────────────────────────
    // B13:fallthrough HR-only(對齊 frontend canViewAllApprovals gate)
    if (!isBackofficeRole(caller)) {
      return res.status(403).json({
        error: '無權看全部申請、請改用 ?type=list&applicant_id=自己 或 ?type=pending',
      });
    }
    const { data, error } = await supabaseAdmin
      .from('approval_requests')
      .select('*, employees!applicant_id(name, dept_id, position, avatar, departments(name))')
      .order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    addDeptNameNested(data, 'employees');
    return res.status(200).json(data);
  }

  if (req.method === 'POST') {
    const body = req.body;

    // ── 建立新申請 ──────────────────────────────────────────────────────────
    if (body.action === 'create') {
      const { request_type, applicant_id, form_data, note, attachments } = body;
      // applicant_id 強制用 caller.id(防客戶端代提別人的)
      const realApplicantId = caller.id;
      if (applicant_id && applicant_id !== caller.id) {
        return res.status(403).json({ error: '不可代他人提出申請' });
      }

      const { data: config, error: cfgErr } = await supabaseAdmin
        .from('approval_flow_configs').select('*').eq('request_type', request_type).single();
      if (cfgErr || !config) return res.status(400).json({ error: '找不到申請類型設定' });

      const steps = config.steps;
      const reqId = 'APR' + Date.now();

      // B12:撈 applicant 資料、判斷是否要自動跳過 manager step
      //   sole-manager dept(僅自己一個 manager)→ 自己送 → 找不到其他可批的人 → 跳過 step 1
      //   採 C 案:step 1 row 留著、status='skipped'、approver_id=NULL、audit note 記錄原因
      const { data: applicant } = await supabaseAdmin
        .from('employees').select('id, dept_id, is_manager')
        .eq('id', realApplicantId).maybeSingle();
      let skipManagerStep = false;
      if (applicant?.is_manager) {
        const otherMgrs = await findOtherActiveManagersInDept(applicant.dept_id, applicant.id);
        skipManagerStep = otherMgrs.length === 0;
      }

      // current_step:第一個不被 skip 的 step number(全 skip 退化 fallback 用 steps[0])
      const firstActive = steps.find(s => !(s.role === 'manager' && skipManagerStep)) || steps[0];
      const initialCurrentStep = firstActive.step;

      const { error: insertErr } = await supabaseAdmin.from('approval_requests').insert([{
        id: reqId,
        request_type,
        title: config.type_name,
        applicant_id: realApplicantId,
        current_step: initialCurrentStep,
        total_steps: steps.length,
        status: 'pending',
        form_data: form_data || {},
        attachments: attachments || [],
        note: note || '',
      }]);
      if (insertErr) return res.status(500).json({ error: insertErr.message });

      for (const step of steps) {
        const shouldSkip = step.role === 'manager' && skipManagerStep;
        const initialStatus = shouldSkip
          ? 'skipped'
          : (step.step === initialCurrentStep ? 'in_progress' : 'waiting');
        await supabaseAdmin.from('approval_steps').insert([{
          id: `${reqId}_S${step.step}`,
          request_id: reqId,
          step_number: step.step,
          step_name: step.name,
          approver_role: step.role,
          status: initialStatus,
          approver_id: null,
          handled_at: shouldSkip ? new Date().toISOString() : null,
          note: shouldSkip ? 'B12: auto-skipped (sole manager in dept)' : '',
        }]);
      }

      return res.status(201).json({
        id: reqId,
        message: '申請已送出',
        skipped_manager_step: skipManagerStep,
      });
    }

    // ── 審批通過 ────────────────────────────────────────────────────────────
    if (body.action === 'approve') {
      const { request_id, step_number, note } = body;
      // approver_id 強制用 caller.id、不接受 client 傳(防偽造)

      // 撈 request + applicant dept_id(canApproveStep 需要)
      const { data: request } = await supabaseAdmin
        .from('approval_requests').select('*').eq('id', request_id).single();
      if (!request) return res.status(404).json({ error: '找不到申請' });

      // self-approval guard
      if (caller.id === request.applicant_id) {
        return res.status(403).json({ error: '不可審核自己的申請' });
      }

      // 撈當下要簽的 step
      const { data: step } = await supabaseAdmin
        .from('approval_steps').select('*')
        .eq('request_id', request_id).eq('step_number', step_number).maybeSingle();
      if (!step) return res.status(404).json({ error: '找不到該步驟' });
      if (step.status !== 'in_progress') {
        return res.status(409).json({ error: '此步驟非進行中、無法簽', actual: step.status });
      }

      // role gate(canApproveStep + applicant dept_id)
      const { data: applicant } = await supabaseAdmin
        .from('employees').select('dept_id').eq('id', request.applicant_id).maybeSingle();
      if (!canApproveStep(caller, step, applicant?.dept_id)) {
        return res.status(403).json({
          error: '無權審核此步驟',
          step_role: step.approver_role,
          your_role: caller.role,
        });
      }

      // 跨 step 同人連簽 guard:caller.id 已在其他 step 簽過 → 403
      const { data: priorSteps } = await supabaseAdmin
        .from('approval_steps').select('approver_id, step_number, status')
        .eq('request_id', request_id).neq('step_number', step_number);
      const alreadySigned = (priorSteps || [])
        .filter(s => s.status === 'approved' && s.approver_id === caller.id);
      if (alreadySigned.length > 0) {
        return res.status(403).json({
          error: '同一人不可跨 step 連簽',
          previous_step: alreadySigned[0].step_number,
        });
      }

      await supabaseAdmin.from('approval_steps').update({
        status: 'approved',
        approver_id: caller.id,           // 強制用 caller.id
        note: note || '',
        handled_at: new Date().toISOString(),
      }).eq('request_id', request_id).eq('step_number', step_number);

      const nextStep = step_number + 1;
      if (nextStep > request.total_steps) {
        await supabaseAdmin.from('approval_requests').update({
          status: 'completed',
          current_step: step_number,
          completed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }).eq('id', request_id);

        // 補打卡(punch_correction):核准後自動寫入 attendance 表
        // 不寫的話 = 員工申請通過了但 DB 沒紀錄、薪資結算還是會少一天。
        if (request.request_type === 'punch_correction') {
          await applyPunchCorrection(request);
        }
        // B7:離職(resignation)核准 → cascade employees.status='resigned' + resigned_at + resigned_reason
        // 不 cascade 的話 HR 還要手動按「離職」button、容易漏(EMP_01251101 incident 根因)
        if (request.request_type === 'resignation') {
          await applyResignation(request, caller);
        }

        // 通知申請人:審批完成
        const _p1 = { title: '✅ 申請已全部通過', body: `你的「${request.title}」已完成所有審批流程`, url: '/approvals.html' };
        sendPushToEmployees([request.applicant_id], { ..._p1, tag: 'approval-' + request_id }).catch(() => {});
        createNotifications([request.applicant_id], { ..._p1, type: 'approval' }).catch(() => {});
      } else {
        await supabaseAdmin.from('approval_requests').update({
          status: 'in_progress',
          current_step: nextStep,
          updated_at: new Date().toISOString(),
        }).eq('id', request_id);
        await supabaseAdmin.from('approval_steps')
          .update({ status: 'in_progress' })
          .eq('request_id', request_id).eq('step_number', nextStep);

        // 通知申請人:本步驟通過,等待下一步
        const _p2 = { title: '✅ 審批步驟通過', body: `你的「${request.title}」第 ${step_number} 步已通過,進入下一審批`, url: '/approvals.html' };
        sendPushToEmployees([request.applicant_id], { ..._p2, tag: 'approval-' + request_id }).catch(() => {});
        createNotifications([request.applicant_id], { ..._p2, type: 'approval' }).catch(() => {});

        // 通知下一步審批人
        const { data: nextStepData } = await supabaseAdmin
          .from('approval_steps')
          .select('approver_role')
          .eq('request_id', request_id)
          .eq('step_number', nextStep)
          .single();
        if (nextStepData?.approver_role) {
          const _p3 = { title: '📋 有新的審批待辦', body: `「${request.title}」等待你審批(第 ${nextStep} 步)`, url: '/approvals.html' };
          sendPushToRoles([nextStepData.approver_role], { ..._p3, tag: 'pending-' + request_id }).catch(() => {});
          createNotificationsForRoles([nextStepData.approver_role], { ..._p3, type: 'approval' }).catch(() => {});
        }
      }

      return res.status(200).json({ message: '已審批通過' });
    }

    // ── 退回 ────────────────────────────────────────────────────────────────
    if (body.action === 'reject') {
      const { request_id, step_number, note } = body;

      const { data: request } = await supabaseAdmin
        .from('approval_requests').select('*').eq('id', request_id).single();
      if (!request) return res.status(404).json({ error: '找不到申請' });

      // self-approval guard
      if (caller.id === request.applicant_id) {
        return res.status(403).json({ error: '不可退回自己的申請' });
      }

      const { data: step } = await supabaseAdmin
        .from('approval_steps').select('*')
        .eq('request_id', request_id).eq('step_number', step_number).maybeSingle();
      if (!step) return res.status(404).json({ error: '找不到該步驟' });
      if (step.status !== 'in_progress') {
        return res.status(409).json({ error: '此步驟非進行中、無法退回', actual: step.status });
      }

      const { data: applicant } = await supabaseAdmin
        .from('employees').select('dept_id').eq('id', request.applicant_id).maybeSingle();
      if (!canApproveStep(caller, step, applicant?.dept_id)) {
        return res.status(403).json({
          error: '無權退回此步驟',
          step_role: step.approver_role,
          your_role: caller.role,
        });
      }

      await supabaseAdmin.from('approval_steps').update({
        status: 'rejected',
        approver_id: caller.id,
        note: note || '',
        handled_at: new Date().toISOString(),
      }).eq('request_id', request_id).eq('step_number', step_number);

      await supabaseAdmin.from('approval_requests').update({
        status: 'rejected',
        updated_at: new Date().toISOString(),
      }).eq('id', request_id);

      // 通知申請人:被退回
      const _p4 = { title: '❌ 申請已被退回', body: `你的「${request.title}」申請已被退回,請確認原因`, url: '/approvals.html' };
      sendPushToEmployees([request.applicant_id], { ..._p4, tag: 'approval-' + request_id }).catch(() => {});
      createNotifications([request.applicant_id], { ..._p4, type: 'approval' }).catch(() => {});

      return res.status(200).json({ message: '已退回' });
    }

    // ── 取消申請 ────────────────────────────────────────────────────────────
    if (body.action === 'cancel') {
      const { request_id } = body;
      const { data: request } = await supabaseAdmin
        .from('approval_requests').select('id, applicant_id, status').eq('id', request_id).maybeSingle();
      if (!request) return res.status(404).json({ error: '找不到申請' });
      if (caller.id !== request.applicant_id) {
        return res.status(403).json({ error: '只有申請人本人能取消' });
      }
      if (!['pending', 'in_progress'].includes(request.status)) {
        return res.status(409).json({ error: '此狀態不可取消', actual: request.status });
      }
      await supabaseAdmin.from('approval_requests').update({
        status: 'cancelled',
        updated_at: new Date().toISOString(),
      }).eq('id', request_id);
      return res.status(200).json({ message: '已取消' });
    }

    // ── 更新流程設定 ────────────────────────────────────────────────────────
    if (body.action === 'update_config') {
      // 僅 hr / admin 可改流程設定(對齊 lib/roles.js::canEditApprovalConfig)
      if (!['hr', 'admin'].includes(caller.role)) {
        return res.status(403).json({ error: '無權修改流程設定' });
      }
      const { config_id, steps } = body;
      const { error } = await supabaseAdmin.from('approval_flow_configs')
        .update({ steps }).eq('id', config_id);
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ message: '流程已更新' });
    }

    // ── 進階編輯既有申請 ────────────────────────────────────────────────────
    // P7.1:HR / admin / CEO / chairman 修正 applicant 提錯的 form_data / 漏附的
    // attachments。其他欄位走既有 flow:status / current_step 走 approve/reject/cancel、
    // request_type / applicant_id / created_at 不可改、approval_steps 不允許 step-level
    // admin_edit。Audit 寫進 admin_audit_note(2026-05-19 migration 新欄位)。
    if (body.action === 'admin_edit') {
      if (!['hr', 'admin', 'ceo', 'chairman'].includes(caller.role)) {
        return res.status(403).json({ error: '無權進階編輯申請' });
      }
      const { id } = body;
      if (!id) return res.status(400).json({ error: 'id required' });

      const { data: existing } = await supabaseAdmin
        .from('approval_requests').select('*').eq('id', id).maybeSingle();
      if (!existing) return res.status(404).json({ error: '找不到申請' });

      // 白名單:只 form_data + attachments
      const callerPatch = {};
      if (body.form_data !== undefined) callerPatch.form_data = body.form_data;
      if (body.attachments !== undefined) callerPatch.attachments = body.attachments;
      if (Object.keys(callerPatch).length === 0) {
        return res.status(400).json({ error: 'no allowed fields to update' });
      }

      // validate
      if ('form_data' in callerPatch) {
        const fd = callerPatch.form_data;
        if (fd === null || typeof fd !== 'object' || Array.isArray(fd)) {
          return res.status(400).json({ error: 'invalid form_data', detail: 'must be plain object' });
        }
      }
      if ('attachments' in callerPatch && !Array.isArray(callerPatch.attachments)) {
        return res.status(400).json({ error: 'invalid attachments', detail: 'must be array' });
      }

      // diff audit changes
      const changes = [];
      if ('form_data' in callerPatch) {
        const oldFd = existing.form_data || {};
        const newFd = callerPatch.form_data;
        const allKeys = new Set([...Object.keys(oldFd), ...Object.keys(newFd)]);
        const changedKeys = [];
        for (const k of allKeys) {
          if (JSON.stringify(oldFd[k]) !== JSON.stringify(newFd[k])) changedKeys.push(k);
        }
        if (changedKeys.length > 0) changes.push(`form_data.{${changedKeys.join(', ')}} updated`);
      }
      if ('attachments' in callerPatch) {
        const oldAtt = existing.attachments || [];
        const newAtt = callerPatch.attachments;
        if (JSON.stringify(oldAtt) !== JSON.stringify(newAtt)) changes.push('attachments updated');
      }
      if (changes.length === 0) {
        return res.status(400).json({ error: 'no actual changes', detail: 'all submitted fields equal existing values' });
      }

      // audit log
      const nowDate = new Date().toISOString().slice(0, 10);
      const auditLine = `[${nowDate}] admin_edit by ${caller.id}: ${changes.join(', ')}`;
      const finalPatch = {
        ...callerPatch,
        admin_audit_note: existing.admin_audit_note
          ? `${auditLine}\n${existing.admin_audit_note}`
          : auditLine,
        updated_at: new Date().toISOString(),
      };

      const { data, error } = await supabaseAdmin
        .from('approval_requests').update(finalPatch).eq('id', id).select().maybeSingle();
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ ok: true, request: data, audit: auditLine });
    }

    return res.status(400).json({ error: '未知的 action' });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

// ─────────────────────────────────────────────────────────────────
// 補打卡核准後 → 寫入 attendance 表
//
// form_data 從前端 approvals.html line 244-247 來:
//   correction_date  : 'YYYY-MM-DD'
//   correction_type  : '上班打卡' | '下班打卡'
//   expected_time    : 'HH:MM'
//   reason           : 員工說明
//
// 寫入策略:
//   1. 先找該員工該日已有的 attendance row(可能是漏打卡的同一天但只打了上班 / 下班)
//   2. 有 row → UPDATE 對應欄位(clock_in 或 clock_out)
//   3. 沒 row → INSERT 新 row、含 schedule_id(從 schedules 抓)
//   4. 若同時有 clock_in + clock_out,自動算 work_hours
//   5. 失敗(例如沒 schedule、或 DB error)只 log,不影響 approval status —
//      員工會在 attendance 列表發現沒寫進去、可請 HR 走人工補登
//      (寧可 approval 已 completed 但資料寫失敗,也不要 approval 已 completed 但 rollback)
// ─────────────────────────────────────────────────────────────────
async function applyPunchCorrection(request) {
  try {
    const fd = request.form_data || {};
    const employee_id = request.applicant_id;
    const work_date   = fd.correction_date;
    const punchTime   = fd.expected_time;     // 'HH:MM'
    const punchType   = fd.correction_type;   // '上班打卡' | '下班打卡'
    const reason      = fd.reason || '';

    if (!employee_id || !work_date || !punchTime || !punchType) {
      console.error('[applyPunchCorrection] 缺少必要欄位', { request_id: request.id, fd });
      return;
    }

    const isClockIn = punchType === '上班打卡';
    // 組 Asia/Taipei timezone 的 ISO timestamp
    const punchIso = `${work_date}T${punchTime}:00+08:00`;

    // 查當天已有 attendance row
    const { data: existing } = await supabaseAdmin
      .from('attendance').select('id, clock_in, clock_out, schedule_id, segment_no')
      .eq('employee_id', employee_id).eq('work_date', work_date)
      .maybeSingle();

    if (existing) {
      // 已有 row → 補對應欄位
      const update = isClockIn
        ? { clock_in: punchIso }
        : { clock_out: punchIso };
      // 兩端都有就算 work_hours
      const newClockIn  = isClockIn  ? punchIso : existing.clock_in;
      const newClockOut = isClockIn  ? existing.clock_out : punchIso;
      if (newClockIn && newClockOut) {
        update.work_hours = Math.max(0,
          Math.round((new Date(newClockOut) - new Date(newClockIn)) / 36000) / 100);
      }
      update.note = `補打卡(approval ${request.id}):${reason}`;
      await supabaseAdmin.from('attendance').update(update).eq('id', existing.id);
      return;
    }

    // 沒 row → INSERT 新 row,先撈 schedule_id 連結
    const { data: sched } = await supabaseAdmin
      .from('schedules').select('id, segment_no')
      .eq('employee_id', employee_id).eq('work_date', work_date)
      .order('segment_no').limit(1).maybeSingle();

    const insert = {
      id: `AC_${request.id}`, // AC = attendance from correction
      employee_id, work_date,
      schedule_id: sched?.id || null,
      segment_no: sched?.segment_no || 1,
      clock_in:  isClockIn ? punchIso : null,
      clock_out: isClockIn ? null     : punchIso,
      work_hours: 0,
      overtime_hours: 0,
      status: 'normal',
      note: `補打卡(approval ${request.id}):${reason}`,
    };
    await supabaseAdmin.from('attendance').insert([insert]);
  } catch (err) {
    // 不擋 approval status,只記 log
    console.error('[applyPunchCorrection] 寫入失敗', { request_id: request.id, err: err.message });
  }
}

// ─────────────────────────────────────────────────────────────────
// B7:離職核准 → 自動 cascade 員工 employees.status='resigned'
//
// form_data 從 approvals.html 的 FORM_SCHEMA.resignation 來:
//   resign_date : 'YYYY-MM-DD' 預計離職日(approve 後寫入 resigned_at)
//   reason      : 員工填的離職原因(寫入 resigned_reason)
//   handover    : 交接事項(不寫入 employees、保留在 form_data 給 HR 看)
//
// 設計:
//   1. β 方案:不寫 employee_change_logs(CHECK 不允許 'status' 欄位、不擴 schema)
//      audit 走 approval_requests.completed_at + approval_steps.approver_id/handled_at
//      + employees.resigned_at + Vercel function logs
//   2. Idempotent guard:先撈 employees row、status 已 'resigned' 直接 return
//      (兩張 resignation 都 approve 的極端 case、第二張不重複 cascade)
//   3. try/catch best-effort:cascade 失敗只 log、不擋 approval completed
//      (寧可 approval 已 completed 但 employees 沒同步、也不要 rollback approval)
//   4. resigned_at 寫成 `${resign_date}T00:00:00+08:00`(可能是未來日)、
//      login.html 透過 LoginCheck.shouldBlockResignedLogin 在預計離職日當下才擋
// ─────────────────────────────────────────────────────────────────
async function applyResignation(request, caller) {
  try {
    const fd = request.form_data || {};
    const employee_id = request.applicant_id;
    const resign_date = fd.resign_date;
    const reason      = fd.reason || null;

    if (!employee_id) {
      console.error('[applyResignation] missing applicant_id', { request_id: request.id });
      return;
    }

    // 撈現況 + idempotent guard
    const { data: before, error: beforeErr } = await supabaseAdmin
      .from('employees').select('id, status, resigned_at')
      .eq('id', employee_id).maybeSingle();

    if (beforeErr) {
      console.error('[applyResignation] employees fetch failed',
        { request_id: request.id, employee_id, err: beforeErr.message });
      return;
    }
    if (!before) {
      console.error('[applyResignation] employee not found',
        { request_id: request.id, employee_id });
      return;
    }
    if (before.status === 'resigned') {
      console.log('[applyResignation] employee already resigned, skip',
        { request_id: request.id, employee_id, before_resigned_at: before.resigned_at });
      return;
    }

    // resigned_at:預計離職日 +08:00。沒填 fallback 用 approve 完成的 NOW
    // (理論 resign_date 是 required、approvals.html FORM_SCHEMA.resignation 強制)
    const resignedAtIso = resign_date
      ? `${resign_date}T00:00:00+08:00`
      : new Date().toISOString();

    const { error: updErr } = await supabaseAdmin.from('employees').update({
      status: 'resigned',
      resigned_at: resignedAtIso,
      resigned_reason: reason,
    }).eq('id', employee_id);

    if (updErr) {
      console.error('[applyResignation] employees update failed',
        { request_id: request.id, employee_id, err: updErr.message });
      return;
    }

    console.log('[applyResignation] success', {
      request_id: request.id,
      employee_id,
      resigned_at: resignedAtIso,
      approver_id: caller?.id,
    });
  } catch (err) {
    console.error('[applyResignation] unexpected error',
      { request_id: request.id, err: err.message });
  }
}

// B12:撈申請人 dept 內其他 active manager(排除自己),用於 create flow
// 偵測 sole-manager dept 並自動跳過 step 1 manager(因 sole manager 無法 self-approve)。
// 同 dept 還有其他 active manager → step 1 走既有 manager 互批 flow(B13 dept-scope 已支援)。
async function findOtherActiveManagersInDept(deptId, excludeId) {
  if (!deptId) return [];  // applicant 無 dept_id(資料異常)→ 視同 sole manager、保險升 CEO
  const { data, error } = await supabaseAdmin
    .from('employees')
    .select('id')
    .eq('dept_id', deptId)
    .eq('is_manager', true)
    .eq('status', 'active')
    .neq('id', excludeId);
  if (error) throw error;
  return data || [];
}
