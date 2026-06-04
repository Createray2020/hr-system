// api/overtime-requests/proxy-create.js
// POST /api/overtime-requests/proxy-create
// body: { employee_id, overtime_date, start_at, end_at, hours, compensation_type,
//         reason, day_type? }
//   day_type:僅 overtime_pay 需傳('weekday'|'rest_day'|'holiday';comp_leave 不算薪、忽略)
//
// 用途:HR / CEO / chairman / admin 後台代同仁補登「已核准」加班,立即生效。
//   - compensation_type='comp_leave' → 走 convertOvertimeToCompTimeSafe 自動建補休餘額
//     (grantCompTime 寫 comp_time_balance + leave_balance_logs change_type='grant' +
//      updateOvertimeCompBalanceId 回填 comp_balance_id)
//   - compensation_type='overtime_pay' → 算 estimated_pay / pay_multiplier 寫入,
//     月結 lib/salary/overtime-aggregator.js 自動聚合進 salary_records.overtime_pay
//
// over-limit 不擋,僅記錄 is_over_limit / over_limit_dimensions
// (代建場景 HR 已知情;hard cap 也只是 audit 不阻擋,保留紀錄)。
//
// 與員工正常 POST /api/overtime-requests 的差別:
//   - 員工 POST:status='pending',要走主管 / CEO 兩階審,夸月會擋,事後申請限當日
//   - proxy-create:status='approved' 直入,manager / ceo_id = caller,
//     admin_audit_note 標 '後台代建';不檢查日期視窗(HR 自負審計責任)。

import { requireRole } from '../../lib/auth.js';
import { BACKOFFICE_ROLES } from '../../lib/roles.js';
import { checkOverLimit } from '../../lib/overtime/limits.js';
import {
  calculateOvertimePay, getOvertimeHourlyBase, pickFrozenPayMultiplier,
} from '../../lib/overtime/pay-calc.js';
import { convertOvertimeToCompTimeSafe } from '../../lib/overtime/comp-conversion.js';
import { makeOvertimeRepo } from './_repo.js';

const COMP_TYPES = new Set(['comp_leave', 'overtime_pay']);
const BODY_DAY_TYPES = new Set(['weekday', 'rest_day', 'holiday']);

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const caller = await requireRole(req, res, BACKOFFICE_ROLES);
  if (!caller) return;

  const {
    employee_id, overtime_date, start_at, end_at, hours,
    compensation_type, reason, day_type,
  } = req.body || {};

  // ── 驗證 ─────────────────────────────────────────────────────
  if (!employee_id) return res.status(400).json({ error: 'employee_id required' });
  if (!overtime_date || !start_at || !end_at) {
    return res.status(400).json({ error: 'overtime_date / start_at / end_at required' });
  }
  if (!Number.isFinite(+hours) || +hours <= 0) {
    return res.status(400).json({ error: 'hours must be positive' });
  }
  if (!COMP_TYPES.has(compensation_type)) {
    return res.status(400).json({
      error: 'compensation_type must be comp_leave / overtime_pay',
    });
  }
  if (compensation_type === 'overtime_pay' && !BODY_DAY_TYPES.has(day_type)) {
    return res.status(400).json({
      error: 'day_type required for overtime_pay',
      detail: 'must be weekday / rest_day / holiday',
    });
  }
  if (!reason || !String(reason).trim()) {
    return res.status(400).json({ error: 'reason required' });
  }

  const repo = makeOvertimeRepo();

  // 員工存在性檢查(findEmployeeManager 撈 employees row,null = 不存在)
  const emp = await repo.findEmployeeManager(employee_id);
  if (!emp) return res.status(400).json({ error: 'employee not found', detail: employee_id });

  try {
    // ── over-limit 計算 — 僅記錄、不擋 ─────────────────────────
    const limitResult = await checkOverLimit(repo, {
      employee_id, overtime_date, hours: +hours,
    });

    const otY = parseInt(overtime_date.slice(0, 4));
    const otM = parseInt(overtime_date.slice(5, 7));
    const nowIso = new Date().toISOString();
    const today  = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });

    // ── overtime_pay 分流:算 estimated_pay / pay_multiplier ──
    // 複用「員工正常 POST」的同一條 code path:
    //   getOvertimeHourlyBase(profile, base) + calculateOvertimePay(...) + pickFrozenPayMultiplier(...)
    // 差別:dayType 由 body day_type 推導(不查 holidays 表;HR 自選)
    //   - 'holiday'  → 內部 'national_holiday'、holidayMultiplier 預設 2.0
    //   - 'rest_day' → 內部 'rest_day'
    //   - 'weekday'  → 內部 'weekday'
    let estimated_pay = null;
    let pay_multiplier = null;
    if (compensation_type === 'overtime_pay') {
      const settings = (await repo.getSystemOvertimeSettings()) || {};
      const profile  = await repo.findEmployeeWageProfile(employee_id);
      const base = settings.monthly_work_hours_base != null
        ? Number(settings.monthly_work_hours_base) : 240;
      const hourly = getOvertimeHourlyBase(profile, base);

      const internalDayType = day_type === 'holiday' ? 'national_holiday' : day_type;
      const holidayMultiplier = internalDayType === 'national_holiday' ? 2.0 : null;

      const payCalc = calculateOvertimePay(+hours, hourly, settings, internalDayType, holidayMultiplier);
      estimated_pay  = payCalc.amount;
      pay_multiplier = pickFrozenPayMultiplier(internalDayType, settings, holidayMultiplier);
    }

    // ── INSERT overtime_requests status='approved' ───────────
    const row = {
      employee_id,
      overtime_date,
      start_at, end_at,
      hours: +hours,
      request_kind: 'post_approval',
      is_over_limit: limitResult.is_over_limit,
      over_limit_dimensions: limitResult.is_over_limit ? limitResult.over_limit_dimensions : null,
      compensation_type,
      estimated_pay,
      pay_multiplier,
      reason: String(reason).trim(),
      status: 'approved',
      manager_id: caller.id,
      manager_reviewed_at: nowIso,
      manager_decision: 'approved',
      ceo_id: caller.id,
      ceo_reviewed_at: nowIso,
      ceo_decision: 'approved',
      submitted_at: nowIso,
      applies_to_year:  otY,
      applies_to_month: otM,
      admin_audit_note: `[${today}] 後台代建 by ${caller.id}`,
    };

    const created = await repo.insertOvertimeRequest(row);

    // ── comp_leave 分流:轉補休餘額(safe wrapper)──────────────
    let comp_balance = null;
    const warnings = [];
    if (compensation_type === 'comp_leave') {
      const conv = await convertOvertimeToCompTimeSafe(repo, created);
      comp_balance = conv.comp_balance;
      if (!conv.ok && conv.warning) warnings.push(conv.warning);
    }

    return res.status(201).json({
      request: created,
      comp_balance,
      limitResult,
      warnings,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
