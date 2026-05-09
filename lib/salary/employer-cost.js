// lib/salary/employer-cost.js — 雇主成本 6 項計算
//
// 對應 salary_records.employer_cost_* 6 欄(影子計算、不影響員工 net):
//   labor / health / pension / occupational / employment / welfare
//
// 依據:
//   - 勞工保險條例(雇主 70%)
//   - 全民健康保險法(雇主 60%、含平均眷屬)
//   - 勞工退休金條例 §14(雇主強制 6%)
//   - 職業災害保險及保護法(依行業 0.06%~0.5%)
//   - 就業保險法(雇主 70% / 法定費率 1% × 70% = 0.7%)
//   - 職工福利金條例(50 人以上事業適用、預設薪資 0.05~0.15%)
//
// 計算優先級:
//   - 給 *CompanyPremium 數字 → 直接用(prod path、從 brackets 取最準)
//   - 沒給 → 用 insured × rate 估算(fallback)

/**
 * 計算雇主成本 6 項
 *
 * @param {Object} params
 *
 * @param {number} [params.insuredSalaryLabor=0]  - 勞保投保金額
 * @param {number} [params.insuredSalaryHealth=0] - 健保投保金額(可不同於勞保、含眷屬調整)
 * @param {number} [params.pensionWage=0]         - 月提繳工資
 *
 * @param {number} [params.laborCompanyPremium=null]  - 直接金額(優先)
 * @param {number} [params.healthCompanyPremium=null] - 直接金額(優先)
 *
 * @param {number} [params.laborRate=0]               - fallback 率
 * @param {number} [params.healthRate=0]              - fallback 率
 *
 * @param {number} [params.pensionMandatoryRate=0.06] - 法定 6%、可被 override(離職員工=0)
 * @param {number} [params.occupationalRate=0]        - 行業職災率
 * @param {number} [params.employmentRate=0]          - 就保雇主率(法定 0.007)
 * @param {number} [params.welfareRate=0]             - 職福金率(50 人以上適用)
 *
 * @returns {Object} 6 個 employer_cost_* + total
 */
export function calculateEmployerCost({
  insuredSalaryLabor   = 0,
  insuredSalaryHealth  = 0,
  pensionWage          = 0,

  laborCompanyPremium  = null,
  healthCompanyPremium = null,

  laborRate            = 0,
  healthRate           = 0,

  pensionMandatoryRate = 0.06,
  occupationalRate     = 0,
  employmentRate       = 0,
  welfareRate          = 0,
} = {}) {
  // labor: direct premium 優先、否則 insured × rate
  const employer_cost_labor = laborCompanyPremium != null
    ? Math.round(laborCompanyPremium)
    : Math.round((insuredSalaryLabor || 0) * (laborRate || 0));

  // health: 同上
  const employer_cost_health = healthCompanyPremium != null
    ? Math.round(healthCompanyPremium)
    : Math.round((insuredSalaryHealth || 0) * (healthRate || 0));

  // pension: 強制 6%、可被 override
  const employer_cost_pension = Math.round(
    (pensionWage || 0) * (pensionMandatoryRate || 0)
  );

  // 三項以勞保投保為基準
  const employer_cost_occupational = Math.round((insuredSalaryLabor || 0) * (occupationalRate || 0));
  const employer_cost_employment   = Math.round((insuredSalaryLabor || 0) * (employmentRate   || 0));
  const employer_cost_welfare      = Math.round((insuredSalaryLabor || 0) * (welfareRate      || 0));

  const total =
    employer_cost_labor +
    employer_cost_health +
    employer_cost_pension +
    employer_cost_occupational +
    employer_cost_employment +
    employer_cost_welfare;

  return {
    employer_cost_labor,
    employer_cost_health,
    employer_cost_pension,
    employer_cost_occupational,
    employer_cost_employment,
    employer_cost_welfare,
    total,
  };
}
