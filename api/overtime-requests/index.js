// api/overtime-requests/index.js
// GET  /api/overtime-requests?employee_id&year&month&status   清單
// POST /api/overtime-requests                                 員工申請加班
//
// POST 流程(規範 §9.6):
//   1. 不能跨月:applies_to_year/month 必須等於 today 的年月
//   2. 系統算 hours(從 start_at / end_at)、推斷 dayType、查 holidays.pay_multiplier 凍結
//   3. checkOverLimit:
//      - exceeds_hard_cap=true → 直接 reject 回 400
//      - is_over_limit=true     → 寫入 is_over_limit + over_limit_dimensions
//   4. 算 estimated_pay(供參考,即使選 comp_leave 也算)
//   5. INSERT overtime_requests with status='pending'

import { requireAuth } from '../../lib/auth.js';
import { checkOverLimit, isCrossMonth } from '../../lib/overtime/limits.js';
import {
  calculateOvertimePay, getHourlyRate, pickFrozenPayMultiplier,
} from '../../lib/overtime/pay-calc.js';
import { makeOvertimeRepo } from './_repo.js';

const COMP_TYPES = new Set(['comp_leave', 'overtime_pay', 'undecided']);
const REQUEST_KINDS = new Set(['pre_approval', 'post_approval']);

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  const caller = await requireAuth(req, res);
  if (!caller) return;

  if (req.method === 'GET')  return handleGet(req, res, caller);
  if (req.method === 'POST') return handlePost(req, res, caller);
  return res.status(405).json({ error: 'Method not allowed' });
}

async function handleGet(req, res, caller) {
  const { employee_id, status, year, month, scope } = req.query;
  const repo = makeOvertimeRepo();

  const isHR = ['hr', 'admin', 'ceo'].includes(caller.role || '');
  const isManager = caller.is_manager === true;

  try {
    let rows;
    if (scope === 'subordinates' && isManager) {
      rows = await repo.listOvertimeRequests({ status, year, month, manager_id: caller.id });
    } else if (employee_id && (employee_id === caller.id || isHR || isManager)) {
      rows = await repo.listOvertimeRequests({ employee_id, status, year, month });
    } else if (isHR) {
      rows = await repo.listOvertimeRequests({ status, year, month });
    } else {
      // 員工沒指定 employee_id → 預設只看自己
      if (!caller.id) return res.status(400).json({ error: 'employee_id required' });
      rows = await repo.listOvertimeRequests({ employee_id: caller.id, status, year, month });
    }
    return res.status(200).json({ requests: rows });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

async function handlePost(req, res, caller) {
  const {
    overtime_date, start_at, end_at, hours, request_kind,
    compensation_type, reason, schedule_id, attendance_id,
  } = req.body || {};

  // 必填驗證
  if (!overtime_date || !start_at || !end_at) {
    return res.status(400).json({ error: 'overtime_date / start_at / end_at required' });
  }
  if (!Number.isFinite(+hours) || +hours <= 0) {
    return res.status(400).json({ error: 'hours must be positive' });
  }
  if (!REQUEST_KINDS.has(request_kind)) {
    return res.status(400).json({ error: 'request_kind must be pre_approval / post_approval' });
  }
  if (!COMP_TYPES.has(compensation_type)) {
    return res.status(400).json({ error: 'compensation_type must be comp_leave / overtime_pay / undecided' });
  }
  if (!reason || !String(reason).trim()) {
    return res.status(400).json({ error: 'reason required' });
  }

  const employee_id = caller.id;
  if (!employee_id) return res.status(401).json({ error: 'caller has no employee id' });

  // 不能跨月(規範 §9.6):applies_to_year/month 必須等於 today 的年月
  const today = new Date().toISOString().slice(0, 10);
  if (isCrossMonth(overtime_date, today)) {
    return res.status(400).json({
      error: 'CROSS_MONTH_NOT_ALLOWED',
      detail: `overtime_date(${overtime_date}) must be in current month (${today.slice(0,7)})`,
    });
  }
  const otY = parseInt(overtime_date.slice(0, 4));
  const otM = parseInt(overtime_date.slice(5, 7));

  const repo = makeOvertimeRepo();

  try {
    // 上限檢查
    const limitResult = await checkOverLimit(repo, { employee_id, overtime_date, hours });
    if (limitResult.exceeds_hard_cap) {
      return res.status(400).json({
        error: 'EXCEEDS_HARD_CAP',
        detail: `monthly hard cap reached (limit=${limitResult.limits.monthly_hard_cap}, projected=${limitResult.projected.monthly})`,
        limitResult,
      });
    }

    // 推斷 dayType + 查 holiday(凍結 pay_multiplier)
    const holiday = await repo.findHolidayByDate(overtime_date);
    let dayType;
    let holidayMultiplier = null;
    if (holiday && holiday.holiday_type === 'national') {
      dayType = 'national_holiday';
      holidayMultiplier = Number(holiday.pay_multiplier) || 2.0;
    } else if (isWeekend(overtime_date)) {
      dayType = 'rest_day';
    } else {
      dayType = 'weekday';
    }

    const settings = await repo.getSystemOvertimeSettings() || {};
    const hourly = await calcHourlyRate(repo, employee_id, settings);

    const payCalc = calculateOvertimePay(+hours, hourly, settings, dayType, holidayMultiplier);
    const frozenMultiplier = pickFrozenPayMultiplier(dayType, settings, holidayMultiplier);

    const row = {
      employee_id,
      overtime_date,
      start_at, end_at,
      hours: +hours,
      schedule_id: schedule_id || null,
      attendance_id: attendance_id || null,
      request_kind,
      is_over_limit: limitResult.is_over_limit,
      over_limit_dimensions: limitResult.is_over_limit ? limitResult.over_limit_dimensions : null,
      compensation_type,
      estimated_pay: payCalc.amount,
      pay_multiplier: frozenMultiplier,
      reason: String(reason).trim(),
      status: 'pending',
      applies_to_year:  otY,
      applies_to_month: otM,
      submitted_at: new Date().toISOString(),
    };

    const created = await repo.insertOvertimeRequest(row);
    return res.status(201).json({ request: created, limitResult });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

// ─── helpers ─────────────────────────────────────────────────

function isWeekend(date) {
  // 'YYYY-MM-DD',用 UTC 避時區誤差
  const d = new Date(date + 'T00:00:00Z');
  const dow = d.getUTCDay(); // 0=Sun, 6=Sat
  return dow === 0 || dow === 6;
}

async function calcHourlyRate(repo, employee_id, settings) {
  const monthly = await repo.findEmployeeMonthlySalary(employee_id);
  const base = settings?.monthly_work_hours_base != null
    ? Number(settings.monthly_work_hours_base)
    : 240;
  return getHourlyRate(monthly, base);
}
