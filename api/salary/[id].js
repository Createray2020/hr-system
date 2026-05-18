// api/salary/[id].js
// PUT /api/salary/:id                 一般 PUT(更新欄位;白名單)+ audit + period lock 守
// PUT /api/salary/:id?action=confirm  狀態轉 confirmed(period lock 守)
// PUT /api/salary/:id?action=pay      狀態轉 paid + pay_date(period lock 守)
//
// 同 Batch 3/4 模式:legacy + 新路徑共存,白名單合併。
// GENERATED column(gross_salary / net_salary)永遠不允許覆寫;_auto 欄位也不接受手改。
//
// P6.1:
//   - audit log 寫進 admin_audit_note(2026-05-19 migration 新欄位)
//   - payroll_periods.status='locked' 拒絕修改、除非 ?force=true(會留 [FORCE] 標記)
//   - action=confirm / action=pay 也尊重 lock(可被 ?force=true override)

import { supabaseAdmin } from '../../lib/supabase.js';
import { requireRole } from '../../lib/auth.js';
import { BACKOFFICE_ROLES } from '../../lib/roles.js';

const ALLOWED_PUT = new Set([
  // legacy 欄位
  'overtime_pay', 'bonus', 'allowance', 'extra_allowance',
  'deduct_absence', 'deduct_labor_ins', 'deduct_health_ins', 'deduct_tax',
  'note',
  // Batch 9 新增 _manual 欄位
  'overtime_pay_manual', 'overtime_pay_note',
  'settlement_note',
  // 階段 2.6.1 / 3.3:讓 HR 鎖定 deduct_tax 不被 calculator 覆蓋
  'deduct_tax_manual_override',
  // 不接受:gross_salary / net_salary(GENERATED)、
  //         overtime_pay_auto / attendance_penalty_total / attendance_bonus_actual /
  //         comp_expiry_payout / settlement_amount / holiday_work_pay (_auto)、
  //         daily_wage_snapshot(凍結值)、absence_days(系統算)
]);

// P6.1: audit 格式分類
const NUMERIC_FIELDS = new Set([
  'overtime_pay', 'bonus', 'allowance', 'extra_allowance',
  'deduct_absence', 'deduct_labor_ins', 'deduct_health_ins', 'deduct_tax',
  'overtime_pay_manual',
]);
const TEXT_FIELDS = new Set(['note', 'overtime_pay_note', 'settlement_note']);
const BOOL_FIELDS = new Set(['deduct_tax_manual_override']);

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { id, action } = req.query;
  if (!id) return res.status(400).json({ error: 'id required' });

  const force = req.query.force === 'true' || req.query.force === '1';

  if (action === 'confirm' && req.method === 'PUT') {
    const caller = await requireRole(req, res, BACKOFFICE_ROLES);
    if (!caller) return;
    const lockErr = await assertPeriodNotLocked(id, force);
    if (lockErr) return res.status(lockErr.status).json(lockErr.body);
    const { error } = await supabaseAdmin.from('salary_records')
      .update({ status: 'confirmed', updated_at: new Date().toISOString() }).eq('id', id);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ message: '已確認' });
  }

  if (action === 'pay' && req.method === 'PUT') {
    const caller = await requireRole(req, res, BACKOFFICE_ROLES);
    if (!caller) return;
    const lockErr = await assertPeriodNotLocked(id, force);
    if (lockErr) return res.status(lockErr.status).json(lockErr.body);
    const { error } = await supabaseAdmin.from('salary_records')
      .update({
        status: 'paid',
        pay_date: new Date().toISOString().split('T')[0],
        updated_at: new Date().toISOString(),
      }).eq('id', id);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ message: '已標記發放' });
  }

  if (req.method === 'PUT') {
    const caller = await requireRole(req, res, BACKOFFICE_ROLES);
    if (!caller) return;

    // P6.1: fetch existing for audit + lock check
    const { data: existing, error: gErr } = await supabaseAdmin
      .from('salary_records').select('*').eq('id', id).maybeSingle();
    if (gErr) return res.status(500).json({ error: gErr.message });
    if (!existing) return res.status(404).json({ error: 'salary_records not found' });

    // 白名單過濾
    const callerPatch = {};
    for (const k of Object.keys(req.body || {})) {
      if (!ALLOWED_PUT.has(k)) continue;
      callerPatch[k] = req.body[k];
    }
    if (Object.keys(callerPatch).length === 0) {
      return res.status(400).json({ error: 'no allowed fields to update' });
    }

    // P6.1: lock check + audit log
    const result = await checkLockAndAudit({ existing, callerPatch, caller, force });
    if (result.error) return res.status(result.error.status).json(result.error.body);

    const update = {
      ...callerPatch,
      admin_audit_note: result.auditNote,
      updated_at: new Date().toISOString(),
    };
    const { error } = await supabaseAdmin.from('salary_records').update(update).eq('id', id);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ message: '已更新', audit: result.auditLine });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

// ─────────────────────────────────────────────────────────────
// P6.1 helpers
// ─────────────────────────────────────────────────────────────

// 純 lock 檢查(action=confirm / action=pay 用、不涉 audit)
async function assertPeriodNotLocked(salaryId, force) {
  if (force) return null;
  const { data: existing } = await supabaseAdmin
    .from('salary_records').select('year, month').eq('id', salaryId).maybeSingle();
  if (!existing) return null; // 後續 update 自己會 404、這邊不擋
  const { data: period } = await supabaseAdmin
    .from('payroll_periods').select('status')
    .eq('year', existing.year).eq('month', existing.month).maybeSingle();
  if (period?.status === 'locked') {
    return {
      status: 403,
      body: {
        error: 'PERIOD_LOCKED',
        detail: `payroll_period ${existing.year}-${String(existing.month).padStart(2,'0')} 已 lock、用 ?force=true override`,
      },
    };
  }
  return null;
}

// PUT (no action) 用:同時做 lock 檢查 + audit log
async function checkLockAndAudit({ existing, callerPatch, caller, force }) {
  // 1. lock check
  const { data: period } = await supabaseAdmin
    .from('payroll_periods').select('status')
    .eq('year', existing.year).eq('month', existing.month).maybeSingle();
  if (period?.status === 'locked' && !force) {
    return {
      error: {
        status: 403,
        body: {
          error: 'PERIOD_LOCKED',
          detail: `payroll_period ${existing.year}-${String(existing.month).padStart(2,'0')} 已 lock、用 ?force=true override(會留 [FORCE] 標記)`,
        },
      },
    };
  }

  // 2. audit changes
  const changes = [];
  for (const k of Object.keys(callerPatch)) {
    const oldVal = existing[k];
    const newVal = callerPatch[k];
    if (String(oldVal ?? '') === String(newVal ?? '')) continue;
    if (NUMERIC_FIELDS.has(k) || BOOL_FIELDS.has(k)) {
      changes.push(`${k} ${oldVal ?? 'null'}→${newVal ?? 'null'}`);
    } else if (TEXT_FIELDS.has(k)) {
      changes.push(`${k} updated`); // text 欄位避免 audit 過長、只列 'updated'
    } else {
      changes.push(`${k} updated`); // fallback
    }
  }
  if (changes.length === 0) {
    return { error: { status: 400, body: { error: 'no actual changes' } } };
  }

  // 3. audit log line
  const nowDate = new Date().toISOString().slice(0, 10);
  const forceTag = force ? ' [FORCE]' : '';
  const auditLine = `[${nowDate}] admin_edit${forceTag} by ${caller.id}: ${changes.join(', ')}`;
  const auditNote = existing.admin_audit_note
    ? `${auditLine}\n${existing.admin_audit_note}`
    : auditLine;

  return { auditNote, auditLine, hasForce: force };
}
