// lib/salary/attendance-bonus.js — 全勤獎金套用(純函式 + repo 注入式)
//
// 對應設計文件:docs/attendance-system-design-v1.md §10
// 對應實作計畫:docs/attendance-system-implementation-plan-v1.md §11.3
//
// 流程:
//   1. 從 employees.attendance_bonus 取 base(底薪設定)— 由呼叫端提供 employee row
//   2. 呼叫 lib/attendance/bonus.js 的 calculateAttendanceBonusDeduction 取 deduction_rate
//   3. 算 actual = base × (1 - deduction_rate)
//
// 不直接寫 salary_records,只回傳值給 calculator UPSERT。

import { calculateAttendanceBonusDeduction } from '../attendance/bonus.js';

/**
 * @param {Object} repo  必須具備 lib/attendance/bonus.js 需要的所有 method
 * @param {{ id, attendance_bonus, employment_type }} employee
 * @param {{ employee_id, year, month }} args
 * @returns {{ base, deduction_rate, actual, breakdown }}
 */
export async function applyAttendanceBonus(repo, employee, { employee_id, year, month }) {
  if (!employee) throw new Error('employee required');
  if (!Number.isInteger(year))  throw new Error('year required');
  if (!Number.isInteger(month) || month < 1 || month > 12) throw new Error('month invalid');

  // part_time / 主管職等規則保留 legacy(不領全勤)— 由呼叫端決定;此函式只算數值
  const base = Number(employee.attendance_bonus) || 0;
  if (base === 0) {
    return { base: 0, deduction_rate: 0, actual: 0, breakdown: { skipped: 'base=0' } };
  }

  const ded = await calculateAttendanceBonusDeduction(repo, { employee_id, year, month });
  const rate = Number(ded.deduction_rate) || 0;
  const actual = round2(base * (1 - rate));

  return {
    base: round2(base),
    deduction_rate: round3(rate),
    actual,
    breakdown: ded.breakdown,
  };
}

function round2(n) { return Math.round(Number(n) * 100) / 100; }
function round3(n) { return Math.round(Number(n) * 1000) / 1000; }
