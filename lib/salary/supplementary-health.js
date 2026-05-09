// lib/salary/supplementary-health.js — 二代健保補充保費(高額獎金部分)
//
// 依據:
//   - 全民健康保險法 §31
//   - 全民健康保險法施行細則 §50
//   - 補充保險費扣取及繳納辦法
//
// 規則:
//   每年累計獎金、超過當月投保金額 4 倍部分課徵 2.11%(2026)
//   單次給付課徵金額上限 NTD 1,000,000

/**
 * 計算二代健保補充保費(高額獎金部分)
 *
 * @param {Object} params
 * @param {number} params.monthlyBonus - 當月給付獎金總額(年終/三節/績效/其他合計)
 * @param {number} [params.ytdAccumulatedBonusBefore=0] - 當月「之前」已累計年度獎金
 * @param {number} params.insuredSalary - 當月健保投保金額
 * @param {number} params.rate - 補充保費率(必傳、2026 = 0.0211)
 * @param {number} [params.thresholdMultiplier=4] - 投保金額倍數門檻、預設 4(健保法施行細則 §50)
 * @param {number} [params.capPerPayment=1000000] - 單次給付課徵金額上限
 * @returns {number} 應扣補充保費(整數、Math.round)
 * @throws 缺 rate
 */
export function calculateSupplementaryHealthInsurance({
  monthlyBonus,
  ytdAccumulatedBonusBefore = 0,
  insuredSalary,
  rate,
  thresholdMultiplier = 4,
  capPerPayment = 1_000_000,
}) {
  if (rate == null) {
    throw new Error('calculateSupplementaryHealthInsurance: missing required param "rate"');
  }
  if (monthlyBonus == null || monthlyBonus <= 0) return 0;
  if (insuredSalary == null || insuredSalary <= 0) return 0;

  const threshold = insuredSalary * thresholdMultiplier;
  const ytdAfter  = (ytdAccumulatedBonusBefore || 0) + monthlyBonus;

  // 累計仍未達門檻 → 不扣
  if (ytdAfter <= threshold) return 0;

  let chargeable;
  if (ytdAccumulatedBonusBefore < threshold) {
    // 跨越門檻、只扣超過部分
    chargeable = ytdAfter - threshold;
  } else {
    // 之前已超過、當月全扣
    chargeable = monthlyBonus;
  }

  // 單次給付上限
  chargeable = Math.min(chargeable, capPerPayment);

  return Math.round(chargeable * rate);
}

/**
 * 高階介面: 從 salary_record 4 種獎金欄位加總後計算
 */
export function calculateFromSalaryRecord({
  bonus_yearend     = 0,
  bonus_festival    = 0,
  bonus_performance = 0,
  bonus_other       = 0,
  ytdAccumulatedBonusBefore = 0,
  insuredSalary,
  rate,
  thresholdMultiplier,
  capPerPayment,
}) {
  const monthlyBonus =
    (bonus_yearend     || 0) +
    (bonus_festival    || 0) +
    (bonus_performance || 0) +
    (bonus_other       || 0);

  return calculateSupplementaryHealthInsurance({
    monthlyBonus,
    ytdAccumulatedBonusBefore,
    insuredSalary,
    rate,
    thresholdMultiplier,
    capPerPayment,
  });
}

// 2026 年補充保費率
// ⚠ 每年可能調整、prod 應從 DB / settings 讀
export const TW_2026_SUPPLEMENTARY_HEALTH_RATE = 0.0211;
