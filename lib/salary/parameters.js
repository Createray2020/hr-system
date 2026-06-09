// lib/salary/parameters.js
// Phase 3A:費率中央表(salary_parameter_definitions)→ calculator 的純函式 helper。
//
// 設計:
//   - calculator 入口算 asOfDate(該月最後一天)→ call repo.getEffectiveParameters(asOfDate)
//     回 Map<"category:parameter_name", Number>
//   - 各 step 用 getParam(map, category, name, fallback) 取值,失敗(map 不存在 / key miss /
//     值非有限數)→ 回 fallback(原 hardcoded const、保持向後相容)
//
// 不對接 schema、不做 SQL,純函式可被 vitest 直接 import 測。

const KEY_SEP = ':';

/**
 * @param {Map|null|undefined} paramMap
 * @param {string} category
 * @param {string} name
 * @param {number} fallback
 * @returns {number}
 */
export function getParam(paramMap, category, name, fallback) {
  if (!paramMap || typeof paramMap.get !== 'function') return fallback;
  const v = paramMap.get(`${category}${KEY_SEP}${name}`);
  if (v == null) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return n;
}

export const PARAM_KEY_SEP = KEY_SEP;
