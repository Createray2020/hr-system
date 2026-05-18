// api/comp-time/[id].js
// PUT  /api/comp-time/:id  → HR / admin / CEO / chairman 修正 comp_time_balance row
// body: { expiry_payout_amount?, expiry_processed_at?, status?, expires_at? }
//
// 用途:cron expiry-sweep 標完 expired_paid / expired_void 後、HR 偶爾需要手動:
//   - 修 payout 金額(算錯時)
//   - 延長 expires_at(特殊情況、給員工多時間用)
//   - 修 status(誤標 / 撤銷 expired)
//   - 重設 expiry_processed_at(re-process)
//
// 白名單(只 4 欄):
//   expiry_payout_amount / expiry_processed_at / status / expires_at
// 黑名單:
//   earned_hours / used_hours (動了會跟 leave_requests 補休扣抵 + overtime_requests
//                              comp_balance_id link cascade 不一致、必須走既有 flow)
//   id / employee_id / earned_at / source_overtime_request_id (rebind 沒意義、會破壞 audit)
//
// Audit:寫進 admin_audit_note(新欄位、2026-05-19 migration)。
// format 對齊 P3.1 / P4.1 / P5.1: [YYYY-MM-DD] admin_edit by {caller.id}: field oldVal→newVal, ...
//
// comp_time_balance 是 leaf table、改完不 cascade(salary settlement 月底跑時讀
// expiry_payout_amount 自然會用新值)。

import { supabaseAdmin } from '../../lib/supabase.js';
import { requireRole } from '../../lib/auth.js';
import { BACKOFFICE_ROLES } from '../../lib/roles.js';

const ALLOWED_FIELDS = new Set(['expiry_payout_amount', 'expiry_processed_at', 'status', 'expires_at']);
const ALLOWED_STATUSES = new Set(['active', 'fully_used', 'expired_paid', 'expired_void']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'PUT') return res.status(405).json({ error: 'Method not allowed' });

  const caller = await requireRole(req, res, BACKOFFICE_ROLES);
  if (!caller) return;

  const id = req.query.id;
  if (!id) return res.status(400).json({ error: 'comp_time id required' });

  // 1. fetch existing
  const { data: existing, error: gErr } = await supabaseAdmin
    .from('comp_time_balance').select('*').eq('id', id).maybeSingle();
  if (gErr) return res.status(500).json({ error: gErr.message });
  if (!existing) return res.status(404).json({ error: 'comp_time row not found' });

  // 2. 白名單過濾
  const callerPatch = {};
  for (const k of Object.keys(req.body || {})) {
    if (!ALLOWED_FIELDS.has(k)) continue;
    callerPatch[k] = req.body[k];
  }
  if (Object.keys(callerPatch).length === 0) {
    return res.status(400).json({ error: 'no allowed fields to update' });
  }

  // 3. validate
  if (callerPatch.expiry_payout_amount !== undefined && callerPatch.expiry_payout_amount !== null) {
    const n = Number(callerPatch.expiry_payout_amount);
    if (!Number.isFinite(n) || n < 0) {
      return res.status(400).json({ error: 'invalid expiry_payout_amount', detail: 'must be >= 0 or null' });
    }
    callerPatch.expiry_payout_amount = n;
  }
  if (callerPatch.expiry_processed_at !== undefined && callerPatch.expiry_processed_at !== null) {
    const t = Date.parse(callerPatch.expiry_processed_at);
    if (!Number.isFinite(t)) {
      return res.status(400).json({ error: 'invalid expiry_processed_at', detail: 'must be ISO timestamp or null' });
    }
  }
  if (callerPatch.status !== undefined && !ALLOWED_STATUSES.has(callerPatch.status)) {
    return res.status(400).json({
      error: 'invalid status',
      detail: `must be one of: ${[...ALLOWED_STATUSES].join(', ')}`,
    });
  }
  if (callerPatch.expires_at !== undefined && callerPatch.expires_at !== null
      && !DATE_RE.test(String(callerPatch.expires_at))) {
    return res.status(400).json({ error: 'invalid expires_at', detail: 'must be YYYY-MM-DD or null' });
  }

  // 4. audit log + 「實際變更」檢查
  const auditChanges = [];
  for (const k of Object.keys(callerPatch)) {
    const oldVal = existing[k];
    const newVal = callerPatch[k];
    if (String(oldVal ?? '') === String(newVal ?? '')) continue;
    auditChanges.push(`${k} ${formatAuditVal(oldVal)}→${formatAuditVal(newVal)}`);
  }
  if (auditChanges.length === 0) {
    return res.status(400).json({ error: 'no actual changes', detail: 'all submitted fields equal existing values' });
  }

  const nowDate = new Date().toISOString().slice(0, 10);
  const auditLine = `[${nowDate}] admin_edit by ${caller.id}: ${auditChanges.join(', ')}`;
  const finalPatch = {
    ...callerPatch,
    admin_audit_note: existing.admin_audit_note
      ? `${auditLine}\n${existing.admin_audit_note}`
      : auditLine,
    updated_at: new Date().toISOString(),
  };

  // 5. update + return
  const { data, error } = await supabaseAdmin
    .from('comp_time_balance').update(finalPatch).eq('id', id).select().maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ ok: true, balance: data, audit: auditLine });
}

function formatAuditVal(v) {
  if (v === null || v === undefined) return 'null';
  return String(v);
}
