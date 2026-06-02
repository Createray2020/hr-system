// lib/salary/night-allowance.js — 夜間津貼計算(純函式)
//
// 規則:被認定為夜間班別(night_eligible)的班、整段 scheduled_work_minutes × 50/h。
//   - night_eligible 由 repo 端解析:
//       schedule.night_eligible_override ?? shift_types.night_allowance_eligible
//     (晚班/夜班預設 eligible;日班/中班不 eligible;特殊個案用 schedule override 強制)
//   - 「整段」= scheduled_work_minutes(已含跨夜、已扣 break)
//   - is_off 班、status 過濾在 repo 端;不分 full_time / part_time
//
// 對應 schema:
//   - salary_records.night_allowance(2026_06_03_add_night_allowance.sql)
//   - shift_types.night_allowance_eligible(2026_06_03_b_shift_night_eligible.sql)
//   - schedules.night_eligible_override(同上 migration)

export const NIGHT_ALLOWANCE_PER_HOUR = 50;

/**
 * @param {Array<{ night_eligible: boolean, scheduled_work_minutes: number|null }>} schedules
 *   已由 repo 端解析過 override + shift_types fallback 的排班 row。
 * @param {number} [perHour]  預設 50/h、未來可由 settings 注入
 * @returns {number}  夜間津貼總額(round 到整數;NUMERIC(10,2) 欄存得下小數,但 spec 是整數倍)
 */
export function computeNightAllowance(schedules, perHour = NIGHT_ALLOWANCE_PER_HOUR) {
  let minutes = 0;
  for (const s of (schedules || [])) {
    if (!s || s.night_eligible !== true) continue;
    minutes += Number(s.scheduled_work_minutes) || 0;
  }
  return Math.round((minutes / 60) * perHour);
}
