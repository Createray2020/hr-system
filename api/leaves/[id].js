// api/leaves/[id].js
// PUT    /api/leaves/:id  body { decision: 'approve'|'reject'|'cancel', reject_reason? }
// DELETE /api/leaves/:id  → 員工撤回(等同 cancel)
//
// 對應設計文件：docs/attendance-system-design-v1.md §4.3.2
// 對應實作計畫：docs/attendance-system-implementation-plan-v1.md §7.6
//
// Routing 假設(Vercel file-system routing):同 holidays/[id].js precedent。
// vercel.json 中既有的 /api/leaves/:id/review rewrite 已在 Batch 5 移除,
// 否則本檔永遠不會被 hit(會被 rewrite 到 index.js?id=...)。

import { requireRole } from '../../lib/auth.js';
import { BACKOFFICE_ROLES } from '../../lib/roles.js';
import {
  approveLeaveRequest, rejectLeaveRequest, cancelLeaveRequest,
} from '../../lib/leave/request-flow.js';
import { sendPushToEmployees, createNotifications } from '../../lib/push.js';
import { makeLeaveRepo } from './_repo.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  const id = req.query.id;
  if (!id) return res.status(400).json({ error: 'leave id required' });

  const caller = await requireRole(req, res, BACKOFFICE_ROLES, { allowManager: true });
  if (!caller) return;
  const callerId = caller.id;

  const repo = makeLeaveRepo();

  if (req.method === 'PUT') {
    const { decision, reject_reason } = req.body || {};
    if (!['approve', 'reject', 'cancel'].includes(decision)) {
      return res.status(400).json({ error: 'decision must be approve / reject / cancel' });
    }

    try {
      let r;
      if (decision === 'approve') {
        r = await approveLeaveRequest(repo, { request_id: id, approved_by: callerId });
      } else if (decision === 'reject') {
        r = await rejectLeaveRequest(repo, { request_id: id, rejected_by: callerId, reject_reason });
      } else {
        // cancel:HR 強制撤回 = 走 reject 還是 cancel?規範說員工本人才能 cancel
        // 此處讓 HR 走 cancel(假設 HR 知道自己在做什麼)
        const req_ = await repo.findLeaveRequestById(id);
        if (!req_) return res.status(404).json({ error: 'NOT_FOUND' });
        r = await cancelLeaveRequest(repo, { request_id: id, cancelled_by: req_.employee_id });
      }
      if (!r.ok) return res.status(400).json(r);

      // 推播通知申請人(維持舊 push 行為)
      try {
        const req_ = r.request || await repo.findLeaveRequestById(id);
        if (req_?.employee_id) {
          const LEAVE_TYPES = { annual:'特休', sick:'病假', personal:'事假', maternity:'產假', funeral:'喪假', marriage:'婚假', comp:'補休', public:'公假' };
          const typeName = LEAVE_TYPES[req_.leave_type] || req_.leave_type;
          const titleMap = {
            approved: '✅ 假單已核准',
            rejected: '❌ 假單已退回',
            cancelled: '↩ 假單已撤回',
          };
          const status = req_.status;
          const payload = {
            title: titleMap[status] || '假單異動',
            body:  `${typeName} 申請${status === 'approved' ? '已核准' : status === 'rejected' ? '已被退回' : '已撤回'}`,
            url:   '/leave',
            tag:   'leave-' + id,
          };
          sendPushToEmployees([req_.employee_id], payload).catch(() => {});
          createNotifications([req_.employee_id], { ...payload, type: 'leave' }).catch(() => {});
        }
      } catch (_) {}

      return res.status(200).json({ ok: true, request: r.request });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (req.method === 'DELETE') {
    // 員工撤回(等同 cancel)
    try {
      const req_ = await repo.findLeaveRequestById(id);
      if (!req_) return res.status(404).json({ error: 'NOT_FOUND' });
      const r = await cancelLeaveRequest(repo, {
        request_id: id, cancelled_by: callerId || req_.employee_id,
      });
      if (!r.ok) return res.status(400).json(r);
      return res.status(200).json({ ok: true, request: r.request });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
