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
//
// Phase 3A:pensionMandatoryRate default 改指向 pension-deduction.js 既有常數、保持單一 SoT;
// caller(calculator.js)會從中央表讀取覆寫,沒傳才走 default。

import { TW_PENSION_EMPLOYER_MANDATORY_RATE } from './pension-deduction.js';
import { computeHealthEmployer } from './insurance-bracket.js';

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
 * @param {number} [params.proRataRatio=1]            - B26 批次 4:離職月按曆日比例(worked/total)
 *                                                      非離職月預設 1、行為不變(零回歸)
 *
 * @returns {Object} 6 個 employer_cost_* + total
 */
export function calculateEmployerCost({
  insuredSalaryLabor   = 0,
  insuredSalaryHealth  = 0,
  pensionWage          = 0,

  // ── 2026 法規路徑(優先)──
  rates                  = null,
  employmentInsEligible  = true,
  hasInsurance           = true,

  // ── 舊路徑 fallback 參數(rates 沒傳時走)──
  laborCompanyPremium  = null,
  healthCompanyPremium = null,
  laborRate            = 0,
  healthRate           = 0,
  occupationalRate     = 0,
  employmentRate       = 0,

  pensionMandatoryRate = TW_PENSION_EMPLOYER_MANDATORY_RATE,
  welfareRate          = 0,

  proRataRatio         = 1,
} = {}) {
  // B26 批次 4:對齊 §勞健保按投保日數 pro-rata、雇主負擔同步
  // 既有 caller 不傳 proRataRatio → 預設 1 → 行為不變
  const ratio = Number(proRataRatio) || 1;

  // hasInsurance=false:六欄全 0(只有走新路徑時生效;舊路徑由 caller 自行 gate)
  if (rates && hasInsurance === false) {
    return {
      employer_cost_labor: 0,
      employer_cost_health: 0,
      employer_cost_pension: 0,
      employer_cost_occupational: 0,
      employer_cost_employment: 0,
      employer_cost_welfare: 0,
      total: 0,
    };
  }

  let rawLabor, rawHealth, rawOccupational, rawEmployment;
  if (rates) {
    // 新路徑:從投保級距 × 中央費率表算,拆 3 欄(勞保普通 / 就保 / 職災)+ 健保含眷屬乘數
    rawLabor        = (insuredSalaryLabor  || 0) * (rates.laborOrdinaryEr  || 0);
    rawHealth       = computeHealthEmployer(insuredSalaryHealth || 0, rates);
    rawOccupational = (insuredSalaryLabor  || 0) * (rates.oaEr             || 0);
    rawEmployment   = employmentInsEligible
      ? (insuredSalaryLabor || 0) * (rates.employmentInsEr || 0)
      : 0;
  } else {
    // 舊路徑(向後相容):direct premium > insured × rate
    rawLabor  = laborCompanyPremium  != null ? laborCompanyPremium  : ((insuredSalaryLabor  || 0) * (laborRate  || 0));
    rawHealth = healthCompanyPremium != null ? healthCompanyPremium : ((insuredSalaryHealth || 0) * (healthRate || 0));
    rawOccupational = (insuredSalaryLabor || 0) * (occupationalRate || 0);
    rawEmployment   = (insuredSalaryLabor || 0) * (employmentRate   || 0);
  }

  const employer_cost_labor  = Math.round(rawLabor  * ratio);
  // health 走 computeHealthEmployer 時已 round 過、再 × ratio 後仍要 round 一次(對齊舊路徑)
  const employer_cost_health = Math.round(rawHealth * ratio);

  const employer_cost_pension = Math.round(
    (pensionWage || 0) * (pensionMandatoryRate || 0) * ratio,
  );

  const employer_cost_occupational = Math.round(rawOccupational * ratio);
  const employer_cost_employment   = Math.round(rawEmployment   * ratio);
  const employer_cost_welfare      = Math.round((insuredSalaryLabor || 0) * (welfareRate || 0) * ratio);

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
