// api/cron-leave-proof-expiry.js
// cron entry:每天台灣 04:00(UTC 20:00)跑(在 vercel.json crons 啟用)
//
// 對應流程:Phase 1.5 + 1.5 升級
//   - 撈 leave_requests 中 proof_status='required' AND proof_due_at < NOW()
//   - 撈 leave_types 全 row、做 code → proof_expiry_action map
//   - call lib/leave/proof-sweep.js::sweepExpiredProofs(rows, ltMap, now) 算每筆 action
//   - per row UPDATE 分流:
//       action='convert'      → set leave_type='personal' / proof_status='converted_to_personal'
//       action='mark_expired' → set proof_status='expired'(leave_type / status 不動、HR 個案處理)
//     兩種都追加 handler_note「[YYYY-MM-DD] 原假別 X、...」
//   - 通知員工本人 + HR 角色廣播(convert / mark_expired 模板分流)
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
    // 撈 leave_types(code → proof_expiry_action)、給 sweep 分流用
    // 失敗不致命、fallback 空 map(sweep 內部會 fallback 到 'convert')
    const { data: ltRows, error: ltErr } = await supabaseAdmin
      .from('leave_types')
      .select('code, proof_expiry_action');
    if (ltErr) console.error('[cron-leave-proof-expiry] 撈 leave_types 失敗、fallback 空 map:', ltErr.message);
    const ltMap = {};
    for (const lt of (ltRows || [])) ltMap[lt.code] = lt;

    // 撈所有可能過期的 row(用 nowIso filter、給 lib 再次驗證)
    const { data: rows, error } = await supabaseAdmin
      .from('leave_requests')
      .select('id, employee_id, leave_type, proof_status, proof_due_at, handler_note')
      .eq('proof_status', 'required')
      .lt('proof_due_at', nowIso)
      .eq('status', 'approved');  // 只動已批准的 leave、pending_* / cancelled / rejected / archived / terminated 一律不動
    if (error) throw error;

    const actions = sweepExpiredProofs(rows || [], ltMap, nowIso);
    if (!actions.length) {
      return res.status(200).json({
        ok: true, now: nowIso, scanned: rows?.length || 0,
        converted: 0, marked_expired: 0,
      });
    }

    let convertedCount = 0, markedExpiredCount = 0, failCount = 0;
    // 員工通知分兩 map(convert / mark_expired 文案不同)
    const convertNotify = new Map();        // employee_id → [original_leave_type, ...]
    const markExpiredNotify = new Map();    // 同上

    for (const a of actions) {
      const original = (rows || []).find(r => r.id === a.id);
      const newNote = original?.handler_note
        ? `${original.handler_note}\n[${nowIso.slice(0,10)}] ${a.note_suffix}`
        : `[${nowIso.slice(0,10)}] ${a.note_suffix}`;

      // 分流 UPDATE patch
      const patch = a.action === 'mark_expired'
        ? { proof_status: 'expired', handler_note: newNote }                 // leave_type 不動
        : { leave_type: a.leave_type, proof_status: a.proof_status, handler_note: newNote };

      const { error: uErr } = await supabaseAdmin
        .from('leave_requests')
        .update(patch)
        .eq('id', a.id);
      if (uErr) {
        console.error('[cron-leave-proof-expiry] UPDATE fail:', a.id, a.action, uErr.message);
        failCount++; continue;
      }

      if (a.action === 'mark_expired') {
        markedExpiredCount++;
        if (original?.employee_id) {
          const list = markExpiredNotify.get(original.employee_id) || [];
          list.push(a.original_leave_type);
          markExpiredNotify.set(original.employee_id, list);
        }
      } else {
        convertedCount++;
        if (original?.employee_id) {
          const list = convertNotify.get(original.employee_id) || [];
          list.push(a.original_leave_type);
          convertNotify.set(original.employee_id, list);
        }
      }
    }

    // 員工通知:convert(每人一通、合併假別)
    for (const [employee_id, types] of convertNotify.entries()) {
      const typesText = [...new Set(types)].join(' / ');
      const payload = {
        title: '⚠ 假單已自動轉事假',
        body:  `您的 ${typesText} 申請因未補證明已自動轉為事假`,
        url:   '/leave',
        tag:   `proof-expiry-convert-${employee_id}-${nowIso.slice(0,10)}`,
      };
      sendPushToEmployees([employee_id], payload).catch(() => {});
      createNotification(employee_id, { ...payload, type: 'leave' }).catch(() => {});
    }

    // 員工通知:mark_expired(每人一通、文案不同、url 仍指 /leave)
    for (const [employee_id, types] of markExpiredNotify.entries()) {
      const typesText = [...new Set(types)].join(' / ');
      const payload = {
        title: '⚠ 證明已過期',
        body:  `您的 ${typesText} 證明已過期、HR 將個案處理、暫不轉假`,
        url:   '/leave',
        tag:   `proof-expiry-mark-${employee_id}-${nowIso.slice(0,10)}`,
      };
      sendPushToEmployees([employee_id], payload).catch(() => {});
      createNotification(employee_id, { ...payload, type: 'leave' }).catch(() => {});
    }

    // HR 通知:批次摘要(轉事假 + 待處理合併一則)
    if (convertedCount > 0 || markedExpiredCount > 0) {
      const hrPayload = {
        title: '證明過期處理',
        body:  `已轉事假 ${convertedCount} 筆、待 HR 處理 ${markedExpiredCount} 筆`,
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
      converted: convertedCount,
      marked_expired: markedExpiredCount,
      failed: failCount,
    });
  } catch (e) {
    console.error('[cron-leave-proof-expiry]', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
