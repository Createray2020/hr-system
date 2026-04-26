// lib/overtime/limits.js — 加班上限查詢與檢查(純函式 + repo 注入式)
//
// 對應設計文件:docs/attendance-system-design-v1.md §4.4
// 對應實作計畫:docs/attendance-system-implementation-plan-v1.md §9.2
//
// 上限維度:daily / weekly / monthly / yearly + monthly_hard_cap
// 個人優先 → 全公司 fallback
// 歷史時數**只算 status='approved'**(不含 pending,規範明寫)

/**
 * Repo 介面契約:
 *   findActiveOvertimeLimits(employee_id, today): { employee?, company?: row, ... }
 *     回 { employee: row|null, company: row|null }
 *     兩者都要 active(effective_from <= today AND (effective_to IS NULL OR effective_to >= today))
 *   findOvertimeApprovedHours(employee_id, dateRanges): { daily, weekly, monthly, yearly }
 *     dateRanges:{ day, weekStart, weekEnd, monthStart, monthEnd, yearStart, yearEnd }
 *     回該員工各區間 status='approved' 的 hours 加總
 */

/**
 * 取個人優先 fallback 公司的有效上限。
 *
 * @returns {{ daily, weekly, monthly, yearly, monthly_hard_cap }} 各欄位 number 或 null(該維度不限制)
 */
export async function getEffectiveLimits(repo, employee_id, today) {
  if (!repo || typeof repo.findActiveOvertimeLimits !== 'function') {
    throw new Error('repo.findActiveOvertimeLimits is required');
  }
  if (!employee_id) throw new Error('employee_id required');
  if (!today)        throw new Error('today required');

  const { employee, company } = await repo.findActiveOvertimeLimits(employee_id, today);
  const pickField = (field) => {
    if (employee && employee[field] != null) return Number(employee[field]);
    if (company  && company[field]  != null) return Number(company[field]);
    return null;
  };
  return {
    daily:   pickField('daily_limit_hours'),
    weekly:  pickField('weekly_limit_hours'),
    monthly: pickField('monthly_limit_hours'),
    yearly:  pickField('yearly_limit_hours'),
    monthly_hard_cap: pickField('monthly_hard_cap_hours'),
  };
}

/**
 * 檢查本次申請是否超限。
 *
 * 規則:
 *   - 加總「歷史 approved + 本次 hours」對每個維度檢查
 *   - 任一維度超 limit → is_over_limit=true,記在 over_limit_dimensions
 *   - monthly 超 monthly_hard_cap → exceeds_hard_cap=true(優先級最高;直接擋,不能申請)
 *   - 上限欄位為 null → 該維度不檢查
 *
 * @returns {{ is_over_limit, over_limit_dimensions, exceeds_hard_cap, projected: { daily, weekly, monthly, yearly }, limits }}
 */
export async function checkOverLimit(repo, { employee_id, overtime_date, hours }) {
  if (!repo || typeof repo.findOvertimeApprovedHours !== 'function') {
    throw new Error('repo.findOvertimeApprovedHours is required');
  }
  if (!employee_id)    throw new Error('employee_id required');
  if (!overtime_date)  throw new Error('overtime_date required');
  if (!Number.isFinite(+hours) || +hours <= 0) {
    throw new Error('hours must be positive number');
  }

  const limits = await getEffectiveLimits(repo, employee_id, overtime_date);
  const ranges = computeDateRanges(overtime_date);
  const approved = await repo.findOvertimeApprovedHours(employee_id, ranges);

  const projected = {
    daily:   Number(approved?.daily   || 0) + Number(hours),
    weekly:  Number(approved?.weekly  || 0) + Number(hours),
    monthly: Number(approved?.monthly || 0) + Number(hours),
    yearly:  Number(approved?.yearly  || 0) + Number(hours),
  };

  const over_limit_dimensions = [];
  for (const dim of ['daily', 'weekly', 'monthly', 'yearly']) {
    const lim = limits[dim];
    if (lim != null && projected[dim] > lim + 1e-6) {
      over_limit_dimensions.push(dim);
    }
  }
  const is_over_limit = over_limit_dimensions.length > 0;

  const exceeds_hard_cap =
    limits.monthly_hard_cap != null &&
    projected.monthly > Number(limits.monthly_hard_cap) + 1e-6;

  return {
    is_over_limit,
    over_limit_dimensions,
    exceeds_hard_cap,
    projected,
    limits,
  };
}

// ─── helpers ─────────────────────────────────────────────────

/**
 * 根據 overtime_date('YYYY-MM-DD')算出各維度區間(用 UTC 處理避開時區)。
 * 週的定義:週一 ~ 週日。
 */
export function computeDateRanges(overtime_date) {
  const d = new Date(overtime_date + 'T00:00:00Z');
  if (isNaN(d.getTime())) throw new Error(`invalid overtime_date: ${overtime_date}`);

  const day = overtime_date;

  // 週一為首日:週日 (getUTCDay=0) → 週一相隔 6 天前
  const dow = d.getUTCDay(); // 0=Sun..6=Sat
  const offsetToMonday = (dow + 6) % 7;
  const weekStart = addDays(d, -offsetToMonday);
  const weekEnd   = addDays(weekStart, 6);

  const monthStart = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  const monthEnd   = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));

  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const yearEnd   = new Date(Date.UTC(d.getUTCFullYear(), 11, 31));

  return {
    day,
    weekStart:  fmt(weekStart),
    weekEnd:    fmt(weekEnd),
    monthStart: fmt(monthStart),
    monthEnd:   fmt(monthEnd),
    yearStart:  fmt(yearStart),
    yearEnd:    fmt(yearEnd),
  };
}

function addDays(d, n) {
  const r = new Date(d);
  r.setUTCDate(r.getUTCDate() + n);
  return r;
}

function fmt(d) {
  return d.toISOString().slice(0, 10);
}

/**
 * 判斷申請日期是否跨月(規範 §9.6:不能跨月申請)。
 * 純函式,呼叫端決定 today(API 用 server time、UI 用 client time)。
 * 缺資料一律視為跨月(保守拒絕)。
 *
 * @param {string} overtimeDate  'YYYY-MM-DD'
 * @param {string} today         'YYYY-MM-DD'
 * @returns {boolean} true = 跨月(應拒絕)
 */
export function isCrossMonth(overtimeDate, today) {
  if (!overtimeDate || !today) return true;
  return String(overtimeDate).slice(0, 7) !== String(today).slice(0, 7);
}
