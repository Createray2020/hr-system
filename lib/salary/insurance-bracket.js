// lib/salary/insurance-bracket.js
// 2026 法規勞健保純函式:級距 snap + 員工/雇主保費計算 + 費率載入。
//
// 設計重點:
//   - 「分項各自四捨五入再相加」(勞保=普通+就保 / 雇主=勞保+就保+職災):
//     合併乘率會與勞保局官方金額差 1 元、必須拆。
//   - 健保員工自付乘 (眷屬數+1)、上限 3 口(避免大家族單月扣到天文數字)。
//   - 健保雇主端用平均眷口數倍數一次乘、整體 round(法定算法)。
//   - rates 來源:salary_parameter_definitions 中央表;缺漏則用 documented fallback、console.warn。
//   - snapFullTimeLaborBracket / Health:給「設定員工級距 / 驗證」用、不在月薪計算流程呼叫;
//     全職下限 29,500(規範值、與 bracket 表的最低級無關)。

const FALLBACK_RATES = Object.freeze({
  laborOrdinaryEmp:  0.023,
  employmentInsEmp:  0.002,
  laborOrdinaryEr:   0.0805,
  employmentInsEr:   0.007,
  healthEmp:         0.01551,
  healthEr:          0.03102,
  healthAvgDep:      0.56,
  oaEr:              0,
});

const RATE_KEYS = [
  ['laborOrdinaryEmp', 'labor_insurance',       'employee_rate'],
  ['employmentInsEmp', 'employment_insurance',  'employee_rate'],
  ['laborOrdinaryEr',  'labor_insurance',       'employer_rate'],
  ['employmentInsEr',  'employment_insurance',  'employer_rate'],
  ['healthEmp',        'health_insurance',      'employee_rate'],
  ['healthEr',         'health_insurance',      'employer_rate'],
  ['healthAvgDep',     'health_insurance',      'avg_dependents'],
  ['oaEr',             'occupational_accident', 'employer_rate'],
];

const FULL_TIME_MIN_INSURED_SALARY = 29500;
const HEALTH_DEPENDENT_CAP = 3;

/**
 * 從 salary_parameter_definitions 載入 8 個費率。
 * 缺漏的 key 用 documented fallback 並 console.warn(列出 missing keys)。
 *
 * @param {Object} repo - 需提供 getEffectiveParameters(asOfDate) → Map<"category:name", Number>
 * @param {{ year:number, month:number, paramMap?:Map }} opts
 *   - 若已有 paramMap(calculator 主流程已撈過)可直接傳入避免重複 query
 * @returns {Promise<Object>} rates
 */
export async function loadInsuranceRates(repo, { year, month, paramMap } = {}) {
  let map = paramMap;
  if (!map && repo && typeof repo.getEffectiveParameters === 'function') {
    const asOfDate = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
    map = (await repo.getEffectiveParameters(asOfDate)) || new Map();
  }
  map = map || new Map();

  const rates = {};
  const missing = [];
  for (const [outKey, category, name] of RATE_KEYS) {
    const v = map.get(`${category}:${name}`);
    const n = Number(v);
    if (v == null || !Number.isFinite(n)) {
      rates[outKey] = FALLBACK_RATES[outKey];
      missing.push(`${category}:${name}`);
    } else {
      rates[outKey] = n;
    }
  }

  if (missing.length) {
    console.warn(
      `[insurance-bracket] missing rates from salary_parameter_definitions, using fallback for: ${missing.join(', ')}`
    );
  }
  return rates;
}

/**
 * 勞保(普通事故)+ 就保 員工自付額。
 * 分項各自四捨五入再相加(對齊勞保局官方金額)。
 */
export function computeLaborEmployee(insuredSalary, { employmentInsEligible } = {}, rates) {
  const wage = Number(insuredSalary) || 0;
  if (wage <= 0) return 0;
  const labor   = Math.round(wage * rates.laborOrdinaryEmp);
  const empIns  = employmentInsEligible ? Math.round(wage * rates.employmentInsEmp) : 0;
  return labor + empIns;
}

/**
 * 健保員工自付額,含眷屬乘數(0 ~ 3 口,5 口以上 clamp 3)。
 * perPerson = round(insured × rate);總額 = perPerson × (deps + 1)。
 */
export function computeHealthEmployee(insuredSalary, dependents, rates) {
  const wage = Number(insuredSalary) || 0;
  if (wage <= 0) return 0;
  let deps = Number(dependents);
  if (!Number.isFinite(deps) || deps < 0) deps = 0;
  if (deps > HEALTH_DEPENDENT_CAP) deps = HEALTH_DEPENDENT_CAP;
  const perPerson = Math.round(wage * rates.healthEmp);
  return perPerson * (deps + 1);
}

/**
 * 勞保(普通事故)+ 就保 + 職災 雇主負擔合計。
 * 分項各自四捨五入再相加。
 */
export function computeLaborEmployer(insuredSalary, { employmentInsEligible } = {}, rates) {
  const wage = Number(insuredSalary) || 0;
  if (wage <= 0) return 0;
  const labor  = Math.round(wage * rates.laborOrdinaryEr);
  const empIns = employmentInsEligible ? Math.round(wage * rates.employmentInsEr) : 0;
  const oa     = Math.round(wage * rates.oaEr);
  return labor + empIns + oa;
}

/**
 * 雇主健保負擔,含平均眷屬倍數(法定算法 = 整體單次 round)。
 */
export function computeHealthEmployer(insuredSalary, rates) {
  const wage = Number(insuredSalary) || 0;
  if (wage <= 0) return 0;
  return Math.round(wage * rates.healthEr * (1 + rates.healthAvgDep));
}

/**
 * 全職勞保級距 snap:wage<29,500 強制回最低投保 29,500。
 * 否則查 labor_insurance_brackets;找不到回 null。
 *
 * 不在月薪計算流程呼叫,只給「設定員工級距 / drift 驗證」用。
 *
 * @param {Object} repo - 需提供 findLaborInsuranceBracketForWage(wage)
 *   → { insured_salary } | null
 */
export async function snapFullTimeLaborBracket(repo, monthlyRegularWage) {
  const wage = Number(monthlyRegularWage) || 0;
  if (wage < FULL_TIME_MIN_INSURED_SALARY) return FULL_TIME_MIN_INSURED_SALARY;
  if (!repo || typeof repo.findLaborInsuranceBracketForWage !== 'function') return null;
  const row = await repo.findLaborInsuranceBracketForWage(wage);
  return row?.insured_salary ?? null;
}

/**
 * 全職健保級距 snap;同上邏輯、走 health bracket 表。
 */
export async function snapFullTimeHealthBracket(repo, monthlyRegularWage) {
  const wage = Number(monthlyRegularWage) || 0;
  if (wage < FULL_TIME_MIN_INSURED_SALARY) return FULL_TIME_MIN_INSURED_SALARY;
  if (!repo || typeof repo.findHealthInsuranceBracketForWage !== 'function') return null;
  const row = await repo.findHealthInsuranceBracketForWage(wage);
  return row?.insured_salary ?? null;
}

export const INSURANCE_RATE_FALLBACK = FALLBACK_RATES;
