// api/approvals.js
// GET  /api/approvals?type=configs                              → 所有申請類型設定
// GET  /api/approvals?id=XXX                                   → 單筆詳情（含步驟）
// GET  /api/approvals?type=list&applicant_id=XXX               → 我的申請
// GET  /api/approvals?type=pending&role=manager                → 待我審批
// GET  /api/approvals                                          → 全部申請
// POST /api/approvals { action: create|approve|reject|cancel|update_config }
import { supabase } from '../lib/supabase.js';
import { sendPushToEmployees, sendPushToRoles, createNotifications, createNotificationsForRoles } from '../lib/push.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') {
    const { type, id, applicant_id, role, request_type } = req.query;

    // ── 申請類型設定 ────────────────────────────────────────────────────────
    if (type === 'configs') {
      const { data, error } = await supabase
        .from('approval_flow_configs')
        .select('*').eq('is_active', true)
        .order('category').order('id');
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json(data);
    }

    // ── 單筆申請詳情（含步驟） ───────────────────────────────────────────────
    if (id) {
      const { data: reqData, error } = await supabase
        .from('approval_requests')
        .select('*, employees!applicant_id(name, dept, position, avatar)')
        .eq('id', id).single();
      if (error) return res.status(404).json({ error: '找不到申請' });

      const { data: steps } = await supabase
        .from('approval_steps')
        .select('*, employees!approver_id(name, position)')
        .eq('request_id', id).order('step_number');

      return res.status(200).json({ ...reqData, steps: steps || [] });
    }

    // ── 我的申請列表 ────────────────────────────────────────────────────────
    if (type === 'list' && applicant_id) {
      let q = supabase.from('approval_requests')
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
      const { data: steps, error } = await supabase
        .from('approval_steps')
        .select('*, approval_requests(*, employees!applicant_id(name, dept, position, avatar))')
        .eq('step_number', stepNum)
        .eq('approver_role', role === 'chairman' ? 'ceo' : role)
        .eq('status', 'in_progress')
        .order('created_at', { ascending: false });
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json(steps || []);
    }

    // ── 全部申請 ────────────────────────────────────────────────────────────
    const { data, error } = await supabase
      .from('approval_requests')
      .select('*, employees!applicant_id(name, dept, position, avatar)')
      .order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json(data);
  }

  if (req.method === 'POST') {
    const body = req.body;

    // ── 建立新申請 ──────────────────────────────────────────────────────────
    if (body.action === 'create') {
      const { request_type, applicant_id, form_data, note, attachments, dept } = body;

      const { data: config, error: cfgErr } = await supabase
        .from('approval_flow_configs').select('*').eq('request_type', request_type).single();
      if (cfgErr || !config) return res.status(400).json({ error: '找不到申請類型設定' });

      const steps = config.steps;
      const reqId = 'APR' + Date.now();

      const { error: insertErr } = await supabase.from('approval_requests').insert([{
        id: reqId,
        request_type,
        title: config.type_name,
        applicant_id,
        dept: dept || '',
        current_step: 1,
        total_steps: steps.length,
        status: 'pending',
        form_data: form_data || {},
        attachments: attachments || [],
        note: note || '',
      }]);
      if (insertErr) return res.status(500).json({ error: insertErr.message });

      for (const step of steps) {
        await supabase.from('approval_steps').insert([{
          id: `${reqId}_S${step.step}`,
          request_id: reqId,
          step_number: step.step,
          step_name: step.name,
          approver_role: step.role,
          status: step.step === 1 ? 'in_progress' : 'waiting',
        }]);
      }

      return res.status(201).json({ id: reqId, message: '申請已送出' });
    }

    // ── 審批通過 ────────────────────────────────────────────────────────────
    if (body.action === 'approve') {
      const { request_id, step_number, approver_id, note } = body;

      await supabase.from('approval_steps').update({
        status: 'approved',
        approver_id: approver_id || null,
        note: note || '',
        handled_at: new Date().toISOString(),
      }).eq('request_id', request_id).eq('step_number', step_number);

      const { data: request } = await supabase
        .from('approval_requests').select('*').eq('id', request_id).single();
      if (!request) return res.status(404).json({ error: '找不到申請' });

      const nextStep = step_number + 1;
      if (nextStep > request.total_steps) {
        await supabase.from('approval_requests').update({
          status: 'completed',
          current_step: step_number,
          completed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }).eq('id', request_id);

        // 通知申請人：審批完成
        const _p1 = { title: '✅ 申請已全部通過', body: `你的「${request.title}」已完成所有審批流程`, url: '/approvals.html' };
        sendPushToEmployees([request.applicant_id], { ..._p1, tag: 'approval-' + request_id }).catch(() => {});
        createNotifications([request.applicant_id], { ..._p1, type: 'approval' }).catch(() => {});
      } else {
        await supabase.from('approval_requests').update({
          status: 'in_progress',
          current_step: nextStep,
          updated_at: new Date().toISOString(),
        }).eq('id', request_id);
        await supabase.from('approval_steps')
          .update({ status: 'in_progress' })
          .eq('request_id', request_id).eq('step_number', nextStep);

        // 通知申請人：本步驟通過，等待下一步
        const _p2 = { title: '✅ 審批步驟通過', body: `你的「${request.title}」第 ${step_number} 步已通過，進入下一審批`, url: '/approvals.html' };
        sendPushToEmployees([request.applicant_id], { ..._p2, tag: 'approval-' + request_id }).catch(() => {});
        createNotifications([request.applicant_id], { ..._p2, type: 'approval' }).catch(() => {});

        // 通知下一步審批人
        const { data: nextStepData } = await supabase
          .from('approval_steps')
          .select('approver_role')
          .eq('request_id', request_id)
          .eq('step_number', nextStep)
          .single();
        if (nextStepData?.approver_role) {
          const _p3 = { title: '📋 有新的審批待辦', body: `「${request.title}」等待你審批（第 ${nextStep} 步）`, url: '/approvals.html' };
          sendPushToRoles([nextStepData.approver_role], { ..._p3, tag: 'pending-' + request_id }).catch(() => {});
          createNotificationsForRoles([nextStepData.approver_role], { ..._p3, type: 'approval' }).catch(() => {});
        }
      }

      return res.status(200).json({ message: '已審批通過' });
    }

    // ── 退回 ────────────────────────────────────────────────────────────────
    if (body.action === 'reject') {
      const { request_id, step_number, approver_id, note } = body;

      await supabase.from('approval_steps').update({
        status: 'rejected',
        approver_id: approver_id || null,
        note: note || '',
        handled_at: new Date().toISOString(),
      }).eq('request_id', request_id).eq('step_number', step_number);

      await supabase.from('approval_requests').update({
        status: 'rejected',
        updated_at: new Date().toISOString(),
      }).eq('id', request_id);

      // 通知申請人：被退回
      const { data: rejReq } = await supabase
        .from('approval_requests').select('applicant_id, title').eq('id', request_id).single();
      if (rejReq) {
        const _p4 = { title: '❌ 申請已被退回', body: `你的「${rejReq.title}」申請已被退回，請確認原因`, url: '/approvals.html' };
        sendPushToEmployees([rejReq.applicant_id], { ..._p4, tag: 'approval-' + request_id }).catch(() => {});
        createNotifications([rejReq.applicant_id], { ..._p4, type: 'approval' }).catch(() => {});
      }

      return res.status(200).json({ message: '已退回' });
    }

    // ── 取消申請 ────────────────────────────────────────────────────────────
    if (body.action === 'cancel') {
      await supabase.from('approval_requests').update({
        status: 'cancelled',
        updated_at: new Date().toISOString(),
      }).eq('id', body.request_id);
      return res.status(200).json({ message: '已取消' });
    }

    // ── 更新流程設定 ────────────────────────────────────────────────────────
    if (body.action === 'update_config') {
      const { config_id, steps } = body;
      const { error } = await supabase.from('approval_flow_configs')
        .update({ steps }).eq('id', config_id);
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ message: '流程已更新' });
    }

    return res.status(400).json({ error: '未知的 action' });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
