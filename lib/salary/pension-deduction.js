// lib/salary/pension-deduction.js — 勞工退休金提繳計算
//
// 依據:
//   - 勞工退休金條例 §14:
//     雇主強制提繳率 6%(法定最低)
//     員工自願提繳率 0~6%(員工自選、從薪資扣、免稅)
//
// 員工自願部分性質:
//   - 屬於「免稅項目」、計入課稅薪資的減項(由 calculator 處理)
//   - 寫入 salary_records.deduct_pension_voluntary
//   - 從員工 net pay 扣除
//
// 雇主強制部分性質:
//   - 雇主成本、不從員工薪資扣
//   - 寫入 salary_records.employer_cost_pension

/**
 * 計算勞退提繳金額(員工自願 + 雇主強制)
 *
 * @param {Object} params
 * @param {number} params.pensionWage - 月提繳工資(依勞退月提繳工資分級表查 employee.pension_wage)
 * @param {number} [params.employeeRate=0] - 員工自願率(0~0.06)、超出 cap 到 0.06、負數 cap 到 0
 * @param {number} [params.employerRate=0.06] - 雇主強制率、預設 0.06(法定)、可 override(離職員工 = 0)
 * @returns {{ employeeContribution: number, employerContribution: number }}
 */
export function calculatePension({
  pensionWage,
  employeeRate = 0,
  employerRate = 0.06,
}) {
  if (pensionWage == null || pensionWage <= 0) {
    return { employeeContribution: 0, employerContribution: 0 };
  }
  // 員工自願率 cap 0~6%
  const empRate = Math.max(0, Math.min(0.06, employeeRate || 0));
  // 雇主率 cap 0+(允許 0、不限上限以支援超額提繳業界少數情境)
  const erRate  = Math.max(0, employerRate || 0);

  return {
    employeeContribution: Math.round(pensionWage * empRate),
    employerContribution: Math.round(pensionWage * erRate),
  };
}

/**
 * 高階介面: 只取員工自願金額(給 calculator 算課稅薪資用)
 */
export function calculateEmployeeVoluntary({
  pensionWage,
  voluntaryRate = 0,
}) {
  return calculatePension({
    pensionWage,
    employeeRate: voluntaryRate,
    employerRate: 0,
  }).employeeContribution;
}

/**
 * 高階介面: 只取雇主強制金額(給 employer-cost 模組用)
 */
export function calculateEmployerMandatory({
  pensionWage,
  mandatoryRate = 0.06,
}) {
  return calculatePension({
    pensionWage,
    employeeRate: 0,
    employerRate: mandatoryRate,
  }).employerContribution;
}

// 法定常數
export const TW_PENSION_EMPLOYER_MANDATORY_RATE = 0.06;
export const TW_PENSION_EMPLOYEE_VOLUNTARY_MAX  = 0.06;
