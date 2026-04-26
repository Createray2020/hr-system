// lib/attendance/penalty.js — 出勤獎懲規則套用(純函式 + repo 注入式)
//
// 對應設計文件:docs/attendance-system-design-v1.md §4.5
// 對應實作計畫:docs/attendance-system-implementation-plan-v1.md §10.2
//
// 核心:把 attendance 的事件對應到 attendance_penalties 規則,產生 attendance_penalty_records。
//
// 規則匹配:
//   1. trigger_type 對應 attendance.status:late / early_leave / absent
//   2. effective_from <= attendance.date <= effective_to (or null)
//   3. is_active=true
//   4. 對 late/early_leave:用 late_minutes/early_leave_minutes 對 threshold_minutes_min/max
//   5. monthly_count_threshold:該員工本月該類事件累計次數要 >= threshold(或 null = 不檢查)
//   6. penalty_cap:單筆上限
//
// 規則本身不寫死(例如不寫死「曠職一天扣 30%」),全部從 attendance_penalties 表讀。

const TRIGGER_BY_STATUS = {
  late: 'late',
  early_leave: 'early_leave',
  absent: 'absent',
};

/**
 * Repo 介面契約:
 *   findActivePenaltyRules({ trigger_type, on_date }): Array<rule>
 *     active=true 且 effective_from <= on_date <= effective_to (or null)
 *   countMonthlyTriggerEvents({ employee_id, year, month, trigger_type }): number
 *     本月該員工該 trigger_type 已發生次數(含本筆之前的,看實作 — 規範說「第幾次」,本實作算到本筆為止 inclusive)
 *   insertPenaltyRecord(row): inserted row
 *
 * 注意:countMonthlyTriggerEvents 應該 count 已寫入的 attendance(status=late 等)+ 包含本筆
 * 的累計次數(因為呼叫此函式時本筆 attendance 通常已寫入,且本筆也算一次)。
 */

/**
 * @param {Object} repo
 * @param {{
 *   id, employee_id, work_date, status, late_minutes, early_leave_minutes
 * }} attendance
 * @returns {Promise<Array<row>>}  產生的 attendance_penalty_records
 */
export async function applyPenaltyRules(repo, attendance) {
  requireRepo(repo, ['findActivePenaltyRules', 'countMonthlyTriggerEvents', 'insertPenaltyRecord']);
  if (!attendance || !attendance.employee_id || !attendance.work_date) {
    throw new Error('attendance.employee_id and work_date required');
  }

  const trigger_type = TRIGGER_BY_STATUS[attendance.status];
  if (!trigger_type) return []; // status 'normal' / 'leave' / 'holiday' 不觸發

  const triggerMinutes = trigger_type === 'late'
    ? Number(attendance.late_minutes) || 0
    : trigger_type === 'early_leave'
      ? Number(attendance.early_leave_minutes) || 0
      : 0; // absent 不用分鐘

  const rules = await repo.findActivePenaltyRules({
    trigger_type, on_date: attendance.work_date,
  });
  if (!rules || rules.length === 0) return [];

  const [year, month] = parseYM(attendance.work_date);
  const matched = [];

  for (const rule of rules) {
    if (!matchesThreshold(rule, triggerMinutes)) continue;
    if (rule.monthly_count_threshold != null) {
      const count = await repo.countMonthlyTriggerEvents({
        employee_id: attendance.employee_id, year, month, trigger_type,
      });
      if (count < Number(rule.monthly_count_threshold)) continue;
    }
    matched.push(rule);
  }

  if (matched.length === 0) return [];

  const out = [];
  for (const rule of matched) {
    const amount = calculatePenaltyAmount(rule, triggerMinutes);
    const row = {
      employee_id:    attendance.employee_id,
      attendance_id:  attendance.id || null,
      penalty_rule_id: rule.id,
      trigger_type,
      trigger_minutes: triggerMinutes || null,
      penalty_type:   rule.penalty_type,    // 規則 snapshot(規範 §10.2)
      penalty_amount: amount,
      applies_to_year:  year,
      applies_to_month: month,
      status: 'pending',
    };
    const inserted = await repo.insertPenaltyRecord(row);
    out.push(inserted || row);
  }
  return out;
}

/**
 * 判斷 triggerMinutes 是否落在 rule 的 [threshold_minutes_min, threshold_minutes_max] 內。
 * absent 類型 threshold 不適用,固定回 true。
 *
 * 邊界:min=1, max=NULL → minutes >= 1 (一律觸發)
 *       min=1, max=5 → 1 <= minutes <= 5
 *       min=6, max=30 → 6 <= minutes <= 30
 */
export function matchesThreshold(rule, triggerMinutes) {
  if (rule.trigger_type === 'absent') return true;
  const min = Number(rule.threshold_minutes_min);
  const max = rule.threshold_minutes_max == null ? null : Number(rule.threshold_minutes_max);
  const t = Number(triggerMinutes) || 0;
  if (Number.isFinite(min) && t < min) return false;
  if (max != null && t > max) return false;
  return true;
}

/**
 * 計算單筆 penalty_amount。
 *   deduct_money:固定金額(取 penalty_amount)
 *   deduct_money_per_min:penalty_amount(每分鐘金額) × triggerMinutes
 *   deduct_attendance_bonus / deduct_attendance_bonus_pct:用 penalty_amount(整筆 / 比例),
 *     bonus 系統再依 penalty_type 解讀
 *   warning:0
 *   custom:取 penalty_amount(可能 0)
 *
 * 套用 penalty_cap:max(amount, cap) 不對 — 應該 min(amount, cap)。
 */
export function calculatePenaltyAmount(rule, triggerMinutes) {
  const base = Number(rule.penalty_amount) || 0;
  const cap  = rule.penalty_cap == null ? null : Number(rule.penalty_cap);
  let amount;
  switch (rule.penalty_type) {
    case 'deduct_money_per_min':
      amount = base * (Number(triggerMinutes) || 0);
      break;
    case 'warning':
      amount = 0;
      break;
    case 'deduct_money':
    case 'deduct_attendance_bonus':
    case 'deduct_attendance_bonus_pct':
    case 'custom':
    default:
      amount = base;
  }
  if (cap != null && amount > cap) amount = cap;
  return round2(amount);
}

// ─── helpers ─────────────────────────────────────────────────

function requireRepo(repo, methods) {
  if (!repo) throw new Error('repo required');
  for (const m of methods) {
    if (typeof repo[m] !== 'function') throw new Error(`repo.${m} is required`);
  }
}

function parseYM(date) {
  const m = String(date).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) throw new Error(`invalid date: ${date}`);
  return [parseInt(m[1]), parseInt(m[2])];
}

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}
