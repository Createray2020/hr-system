// lib/salary/tax-withholding.js — 台灣薪資所得扣繳計算
//
// 依據:
//   - 所得稅法 §88
//   - 各類所得扣繳率標準 §8(2026 年起 = 中華民國 115 年)
//   - 薪資所得扣繳稅額表(財政部公告、每年可能調整)
//
// 純函式、無 side effect、法規數字由 caller 注入(從 DB / settings 讀)

/**
 * 公式法計算所得稅
 * 公式: (月給付 - 本人免稅額 - 扶養人數 × 每位免稅額) × 稅率
 * 結果 < 0 時視為 0
 */
export function calculateTaxByFormula({
  monthlyPayment,
  dependentCount = 0,
  taxFreeAllowanceBase,
  taxFreeAllowancePerDep,
  rate,
}) {
  if (monthlyPayment == null || monthlyPayment <= 0) return 0;
  if (taxFreeAllowanceBase == null || taxFreeAllowancePerDep == null || rate == null) {
    throw new Error(
      'calculateTaxByFormula: missing required params ' +
      '(taxFreeAllowanceBase / taxFreeAllowancePerDep / rate)'
    );
  }
  const totalAllowance = taxFreeAllowanceBase + dependentCount * taxFreeAllowancePerDep;
  if (monthlyPayment <= totalAllowance) return 0;
  const taxable = monthlyPayment - totalAllowance;
  return Math.round(taxable * rate);
}

/**
 * 表列法計算所得稅(查薪資所得扣繳稅額表)
 *
 * brackets 結構:
 *   [{ min, max, dependent_0, dependent_1, dependent_2, dependent_3, dependent_4, dependent_5 }, ...]
 *
 * 查不到回 -1(讓上層 fallback 到公式法)
 */
export function calculateTaxByTable({
  monthlyPayment,
  dependentCount = 0,
  brackets,
}) {
  if (monthlyPayment == null || monthlyPayment <= 0) return 0;
  if (!Array.isArray(brackets) || brackets.length === 0) return -1;

  const bracket = brackets.find(b =>
    monthlyPayment >= b.min &&
    (b.max == null || monthlyPayment <= b.max)
  );
  if (!bracket) return -1;

  // 表通常列到扶養 5 人(超過 5 人實務上極少、回 -1 fallback 公式法處理)
  const cappedDeps = Math.min(dependentCount, 5);
  const key = `dependent_${cappedDeps}`;
  const amount = bracket[key];
  return typeof amount === 'number' ? amount : -1;
}

/**
 * 高階介面:依員工選擇的方式計算
 * - method='table' + brackets 有效 + 級距找得到 → 表法
 * - 否則 → 公式法
 */
export function calculateWithholding({
  monthlyPayment,
  dependentCount = 0,
  method = 'formula',
  brackets,
  formulaParams,
}) {
  if (method === 'table' && Array.isArray(brackets)) {
    const tableResult = calculateTaxByTable({ monthlyPayment, dependentCount, brackets });
    if (tableResult >= 0) return tableResult;
    // brackets 查不到、fallback 公式法
  }
  return calculateTaxByFormula({
    monthlyPayment,
    dependentCount,
    ...(formulaParams || {}),
  });
}

/**
 * 2024 年公式法預設(財政部公告、薪資所得扣繳辦法 §8)
 * ⚠ 每年可能調整、prod 應從 DB / settings 讀、本常數僅供 reference
 */
export const TW_2024_WITHHOLDING_DEFAULTS = Object.freeze({
  taxFreeAllowanceBase:    88500,
  taxFreeAllowancePerDep:  88500,
  rate:                    0.06,
});

/**
 * 2025 年(預設沿用 2024 年數字、實際以財政部公告為準)
 */
export const TW_2025_WITHHOLDING_DEFAULTS = Object.freeze({
  taxFreeAllowanceBase:    88500,
  taxFreeAllowancePerDep:  88500,
  rate:                    0.06,
});
