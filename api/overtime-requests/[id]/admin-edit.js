// api/overtime-requests/[id]/admin-edit.js
// PUT  /api/overtime-requests/:id/admin-edit
// body: { hours?, compensation_type? }
//
// 用途:HR / admin / CEO / chairman 修正既有 overtime_request row(員工提錯 hours /
// 補審後發現要改 compensation_type)。不開放改 status / overtime_date / 員工 /
// pay_multiplier(這些動了會破壞 state machine / 凍結倍率語意,要走既有 review/cancel flow)。
//
// Cascade:caller 改 hours 且 row.compensation_type ≠ 'comp_leave' → 重算 estimated_pay
// (補休不算薪、estimated_pay 沒意義、留原值)。
// 凍結 pay_multiplier 不重算:dayType 由 overtime_date 推、HR 沒改 date 就不該動倍率。
// 但 calculateOvertimePay 內建 tier(前 2h / 後 2h)需要 dayType,所以重新推 dayType。
//
// Audit:寫進 admin_audit_note(新欄位、2026-05-19 migration)。
// Format: [YYYY-MM-DD] admin_edit by {caller.id}: field oldVal→newVal, ...
// 新 line 在頂 + '\n' 分隔保留歷史。

import { requireRole } from '../../../lib/auth.js';
import { BACKOFFICE_ROLES } from '../../../lib/roles.js';
import { calculateOvertimePay, getOvertimeHourlyBase } from '../../../lib/overtime/pay-calc.js';
import { makeOvertimeRepo } from '../_repo.js';

const ALLOWED_FIELDS = new Set(['hours', 'compensation_type']);
const COMP_TYPES     = new Set(['comp_leave', 'overtime_pay', 'undecided']);

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'PUT') return res.status(405).json({ error: 'Method not allowed' });

  const caller = await requireRole(req, res, BACKOFFICE_ROLES);
  if (!caller) return;

  const id = req.query.id;
  if (!id) return res.status(400).json({ error: 'request id required' });

  // 1. 白名單過濾
  const callerPatch = {};
  for (const k of Object.keys(req.body || {})) {
    if (!ALLOWED_FIELDS.has(k)) continue;
    callerPatch[k] = req.body[k];
  }
  if (Object.keys(callerPatch).length === 0) {
    return res.status(400).json({ error: 'no allowed fields to update' });
  }

  // 2. validate
  if (callerPatch.hours !== undefined) {
    const h = Number(callerPatch.hours);
    if (!Number.isFinite(h) || h <= 0) {
      return res.status(400).json({ error: 'invalid hours', detail: 'hours must be positive finite number' });
    }
    callerPatch.hours = h;
  }
  if (callerPatch.compensation_type !== undefined && !COMP_TYPES.has(callerPatch.compensation_type)) {
    return res.status(400).json({ error: 'invalid compensation_type', detail: 'must be comp_leave / overtime_pay / undecided' });
  }

  const repo = makeOvertimeRepo();
  const existing = await repo.findOvertimeRequestById(id);
  if (!existing) return res.status(404).json({ error: 'request not found' });

  // 3. cascade estimated_pay(只當 caller 改 hours 且 finalCompType ≠ 'comp_leave')
  const finalCompType = callerPatch.compensation_type ?? existing.compensation_type;
  let finalPatch = { ...callerPatch };

  if ('hours' in callerPatch && finalCompType !== 'comp_leave') {
    const settings = await repo.getSystemOvertimeSettings() || {};
    // 對齊 §2-4 經常性給付基數(同 index.js calcHourlyRate);part_time 走 hourly_rate
    const profile = await repo.findEmployeeWageProfile(existing.employee_id);
    const base = settings.monthly_work_hours_base != null ? Number(settings.monthly_work_hours_base) : 240;
    const hourly = getOvertimeHourlyBase(profile, base);

    // dayType 從 overtime_date 推(對齊 index.js POST create 邏輯)
    const holiday = await repo.findHolidayByDate(existing.overtime_date);
    let dayType, holidayMultiplier = null;
    if (holiday && holiday.holiday_type === 'national') {
      dayType = 'national_holiday';
      holidayMultiplier = Number(holiday.pay_multiplier) || 2.0;
    } else if (isWeekend(existing.overtime_date)) {
      dayType = 'rest_day';
    } else {
      dayType = 'weekday';
    }

    const payCalc = calculateOvertimePay(callerPatch.hours, hourly, settings, dayType, holidayMultiplier);
    finalPatch.estimated_pay = payCalc.amount;
  }

  // 4. audit log(只 audit caller-changed、不含 estimated_pay cascade)
  const auditChanges = [];
  for (const k of Object.keys(callerPatch)) {
    const oldVal = existing[k];
    const newVal = callerPatch[k];
    if (String(oldVal ?? '') === String(newVal ?? '')) continue;
    auditChanges.push(`${k} ${formatAuditVal(oldVal)}→${formatAuditVal(newVal)}`);
  }
  if (auditChanges.length === 0) {
    // 沒實質變更(可能 hours 一樣 + compensation_type 一樣)→ 400
    return res.status(400).json({ error: 'no actual changes', detail: 'all submitted fields equal existing values' });
  }
  const nowDate = new Date().toISOString().slice(0, 10);
  const auditLine = `[${nowDate}] admin_edit by ${caller.id}: ${auditChanges.join(', ')}`;
  finalPatch.admin_audit_note = existing.admin_audit_note
    ? `${auditLine}\n${existing.admin_audit_note}`
    : auditLine;

  // 5. update + return
  try {
    const updated = await repo.updateOvertimeRequest(id, finalPatch);
    return res.status(200).json({ ok: true, request: updated, audit: auditLine });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

function isWeekend(date) {
  const d = new Date(date + 'T00:00:00Z');
  const dow = d.getUTCDay();
  return dow === 0 || dow === 6;
}

function formatAuditVal(v) {
  if (v === null || v === undefined) return 'null';
  return String(v);
}
