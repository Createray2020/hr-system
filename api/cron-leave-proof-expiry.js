// api/cron-leave-proof-expiry.js
// cron entry:每天台灣 04:00(UTC 20:00)跑(在 vercel.json crons 啟用)
//
// 對應流程:Phase 1.5
//   - 撈 leave_requests 中 proof_status='required' AND proof_due_at < NOW()
//   - call lib/leave/proof-sweep.js::sweepExpiredProofs 算每筆要做的 action
//   - per row UPDATE:leave_type='personal'、proof_status='converted_to_personal'、
//     handler_note 追加「原假別 X、未補證明、自動轉事假」
//   - 通知員工本人 + HR 角色廣播
//
// thin wrapper pattern(同 cron-comp-expiry.js)、邏輯在 lib/leave/proof-sweep.js。

import { supabaseAdmin } from '../lib/supabase.js';
import { sweepExpiredProofs } from '../lib/leave/proof-sweep.js';
import { sendPushToEmployees, sendPushToRoles, createNotification, createNotificationsForRoles } from '../lib/push.js';
import { requireCron } from '../lib/cron-auth.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!requireCron(req, res)) return;

  // 測試 / 手動觸發可帶 ?now=ISO 覆寫(預設用 server NOW)
  const nowIso = req.query?.now || new Date().toISOString();

  try {
    // 撈所有可能過期的 row(用 nowIso filter、給 lib 再次驗證)
    const { data: rows, error } = await supabaseAdmin
      .from('leave_requests')
      .select('id, employee_id, leave_type, proof_status, proof_due_at, handler_note')
      .eq('proof_status', 'required')
      .lt('proof_due_at', nowIso);
    if (error) throw error;

    const actions = sweepExpiredProofs(rows || [], nowIso);
    if (!actions.length) {
      return res.status(200).json({ ok: true, now: nowIso, scanned: rows?.length || 0, converted: 0 });
    }

    let okCount = 0, failCount = 0;
    const notifyByEmployee = new Map();  // employee_id → [original_leave_type, ...]

    for (const a of actions) {
      const original = (rows || []).find(r => r.id === a.id);
      const newNote = original?.handler_note
        ? `${original.handler_note}\n[${nowIso.slice(0,10)}] ${a.note_suffix}`
        : `[${nowIso.slice(0,10)}] ${a.note_suffix}`;
      const { error: uErr } = await supabaseAdmin
        .from('leave_requests')
        .update({
          leave_type:   a.leave_type,        // 'personal'
          proof_status: a.proof_status,      // 'converted_to_personal'
          handler_note: newNote,
        })
        .eq('id', a.id);
      if (uErr) { console.error('[cron-leave-proof-expiry] UPDATE fail:', a.id, uErr.message); failCount++; continue; }
      okCount++;
      if (original?.employee_id) {
        const list = notifyByEmployee.get(original.employee_id) || [];
        list.push(a.original_leave_type);
        notifyByEmployee.set(original.employee_id, list);
      }
    }

    // 通知員工:每人一通(把所有被轉的假別合併在一則)
    for (const [employee_id, types] of notifyByEmployee.entries()) {
      const typesText = [...new Set(types)].join(' / ');
      const payload = {
        title: '⚠ 假單已自動轉事假',
        body:  `您的 ${typesText} 申請因未補證明已自動轉為事假`,
        url:   '/leave',
        tag:   `proof-expiry-${employee_id}-${nowIso.slice(0,10)}`,
      };
      sendPushToEmployees([employee_id], payload).catch(() => {});
      createNotification(employee_id, { ...payload, type: 'leave' }).catch(() => {});
    }

    // 通知 HR:批次摘要
    if (okCount > 0) {
      const hrPayload = {
        title: '證明過期自動轉事假',
        body:  `${okCount} 筆假單因未補證明已自動轉事假`,
        url:   '/leave-admin',
        tag:   `proof-expiry-summary-${nowIso.slice(0,10)}`,
      };
      sendPushToRoles(['hr'], hrPayload).catch(() => {});
      createNotificationsForRoles(['hr'], { ...hrPayload, type: 'leave' }).catch(() => {});
    }

    return res.status(200).json({
      ok: true,
      now: nowIso,
      scanned: rows?.length || 0,
      converted: okCount,
      failed: failCount,
    });
  } catch (e) {
    console.error('[cron-leave-proof-expiry]', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
