// api/leave-overview/[id].js
// PATCH /api/leave-overview/:id   HR/admin/ceo/chairman 修正單一請假紀錄
//
// 可改欄位(白名單):
//   leave_type (text、需存在於 leave_types.code)
//   days (numeric ≥ 0)
//   hours (numeric ≥ 0)
//   finalized_hours (numeric ≥ 0)
//
// 必填:
//   admin_audit_note(本次修改理由、缺少 → 400)
//
// 行為:
//   - 對每個「實際變動」的欄位寫一筆 leave_request_change_logs(含 leave_request_id /
//     employee_id snapshot / changed_field / before/after / changed_by)
//   - 同步把 admin_audit_note 寫進 leave_requests.admin_audit_note(若 row 已有舊值、append 一行;
//     對齊 leave_requests admin_audit_note 既有用法)
//   - **不改 status / 不改 start/end / 不改 employee_id / 不觸發重算 balance**
//
// 不提供 PUT / POST / DELETE(新增走既有請假申請流程、刪除走 admin/chairman 的 PUT action=delete)。

import { requireRole } from '../../lib/auth.js';
import { BACKOFFICE_ROLES } from '../../lib/roles.js';
import { makeLeaveOverviewRepo } from './_repo.js';
import { shouldBlockQuantityEdit } from '../../lib/leave/overview-guard.js';

const ALLOWED_PATCH  = new Set(['leave_type', 'days', 'hours', 'finalized_hours']);
const NUMERIC_FIELDS = new Set(['days', 'hours', 'finalized_hours']);

function normalizeValue(field, raw) {
  if (NUMERIC_FIELDS.has(field)) {
    if (raw === null || raw === '') return null;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return undefined;  // signal invalid
    // days NUMERIC(5,2)、hours/finalized_hours 通常 NUMERIC(5,2);round 2dp
    return Math.round(n * 100) / 100;
  }
  if (field === 'leave_type') {
    if (raw == null) return undefined;
    const s = String(raw).trim();
    return s || undefined;
  }
  return raw;
}

function logValue(v) {
  if (v === null || v === undefined) return null;
  return String(v);
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'PATCH')   return res.status(405).json({ error: 'Method not allowed' });

  const caller = await requireRole(req, res, BACKOFFICE_ROLES);
  if (!caller) return;

  const id = req.query.id;
  if (!id) return res.status(400).json({ error: 'leave_request id required' });

  const body = req.body || {};
  const reason = typeof body.admin_audit_note === 'string' ? body.admin_audit_note.trim() : '';
  if (!reason) {
    return res.status(400).json({ error: 'admin_audit_note(修改理由)必填' });
  }
  if (reason.length > 500) {
    return res.status(400).json({ error: 'admin_audit_note 過長(上限 500 字)' });
  }

  const repo = makeLeaveOverviewRepo();
  const existing = await repo.getById(id);
  if (!existing) return res.status(404).json({ error: 'leave_request not found', id });

  // 白名單 + 規範化
  const patch = {};
  const errors = [];
  for (const k of Object.keys(body)) {
    if (!ALLOWED_PATCH.has(k)) continue;
    const v = normalizeValue(k, body[k]);
    if (v === undefined) {
      errors.push(`${k} 格式錯誤(數字需 ≥ 0)`);
      continue;
    }
    patch[k] = v;
  }
  if (errors.length) return res.status(400).json({ error: errors.join('、') });
  if (Object.keys(patch).length === 0) {
    return res.status(400).json({ error: 'no allowed fields to update' });
  }

  // 驗 leave_type 存在
  if ('leave_type' in patch) {
    const lt = await repo.getLeaveType(patch.leave_type);
    if (!lt) {
      return res.status(400).json({ error: 'leave_type 不存在', detail: patch.leave_type });
    }
  }

  // Phase 2 #3 補強護欄:有餘額帳本的假別(特休/補休)禁止改數量欄位、
  // 走特休管理 / 補休管理頁;leave_type / admin_audit_note 不受此限。
  // 判斷對象:既有 leave_request 對應的 leave_type(因為帳本扣除是針對既有 type)。
  const existingLT = await repo.getLeaveType(existing.leave_type);
  const hasBalance = existingLT?.has_balance === true;
  const patchFields = Object.keys(patch);
  if (shouldBlockQuantityEdit({ hasBalance, patchFields })) {
    return res.status(400).json({
      error: '此假別有餘額帳本(特休/補休),數量更正請至特休管理/補休管理,本頁不調整餘額。',
      detail: {
        leave_type:      existing.leave_type,
        leave_type_name: existingLT?.name_zh,
        has_balance:     true,
        blocked_fields:  patchFields.filter(f => ['days','hours','finalized_hours'].includes(f)),
      },
    });
  }

  // 收集實際變動欄位(舊值===新值就跳過)
  const changes = [];
  const realPatch = {};
  for (const k of Object.keys(patch)) {
    const before = existing[k];
    const after  = patch[k];
    if (String(before ?? '') === String(after ?? '')) continue;
    changes.push({
      leave_request_id: existing.id,
      employee_id:      existing.employee_id,
      changed_field:    k,
      before_value:     logValue(before),
      after_value:      logValue(after),
      changed_by:       caller.id,
    });
    realPatch[k] = after;
  }

  if (changes.length === 0) {
    return res.status(200).json({
      leave_request: existing,
      message: 'no actual changes',
      change_logs_inserted: 0,
    });
  }

  // 寫進 leave_requests.admin_audit_note:append 一行(對齊 handler_note prepend 慣例)
  const today = new Date().toISOString().slice(0, 10);
  const auditLine = `[${today}] ${caller.id} leave-overview-edit: ${reason}`;
  realPatch.admin_audit_note = existing.admin_audit_note
    ? `${existing.admin_audit_note}\n${auditLine}`
    : auditLine;

  try {
    const updated = await repo.updateLeaveRequest(id, realPatch);
    await repo.insertChangeLogs(changes);
    return res.status(200).json({
      leave_request: updated,
      change_logs_inserted: changes.length,
      audit_line: auditLine,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
