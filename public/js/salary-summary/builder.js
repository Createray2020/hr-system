// public/js/salary-summary/builder.js
//
// 純函式:從 salary_records 撈來的 list 算出每位員工年度合計、再生 Excel/PDF AOA。
// 對齊 lib/insurance/excel-builder.js / lib/leave/overlay.js pattern (ESM、可被 vitest 直接 import)。
//
// 用途:
//   - public/salary-period.html 「📄 年度合計匯出」modal 點 Excel → 套 builder + SheetJS
//   - public/year-end-export.html PDF 匯出 → render HTML 用同一份 AOA、確保兩種輸出一致
//   - tests/salary-summary-builder.test.js 抓行為
//
// 資料 contract (caller 負責 filter status='paid'/'locked' + EMP_99999999 排除):
//   records: [{ employee_id, year, month, gross_salary, net_salary,
//               bonus_yearend, bonus_festival, bonus_performance, bonus_other,
//               deduct_labor_ins, deduct_health_ins, deduct_pension_voluntary,
//               deduct_supplementary_health, deduct_tax }]
//   employees: [{ id, name, dept_name }]
//
// 員工順序:依 employee_id 遞增排序。
// 全 0 員工(該年度沒領薪)不出現。

export const COLUMNS = Object.freeze([
  { key: 'employee_id',                   label: '員工 ID',            sumInTotal: false },
  { key: 'name',                          label: '姓名',                sumInTotal: false },
  { key: 'dept_name',                     label: '部門',                sumInTotal: false },
  { key: 'months_count',                  label: '領薪月份數',          sumInTotal: true },
  { key: 'gross_total',                   label: '應發合計',            sumInTotal: true },
  { key: 'bonus_yearend_total',           label: '年終獎金合計',        sumInTotal: true },
  { key: 'bonus_festival_total',          label: '三節獎金合計',        sumInTotal: true },
  { key: 'bonus_performance_total',       label: '績效獎金合計',        sumInTotal: true },
  { key: 'bonus_other_total',             label: '其他獎金合計',        sumInTotal: true },
  { key: 'deduct_labor_ins_total',        label: '員工負擔勞保合計',    sumInTotal: true },
  { key: 'deduct_health_ins_total',       label: '員工負擔健保合計',    sumInTotal: true },
  { key: 'deduct_pension_voluntary_total',label: '自願勞退提繳合計',    sumInTotal: true },
  { key: 'deduct_supplementary_health_total', label: '二代健保補充保費合計', sumInTotal: true },
  { key: 'deduct_tax_total',              label: '所得稅扣繳合計',      sumInTotal: true },
  { key: 'net_total',                     label: '實發合計',            sumInTotal: true },
]);

const SUM_FIELDS = [
  ['gross_total', 'gross_salary'],
  ['bonus_yearend_total', 'bonus_yearend'],
  ['bonus_festival_total', 'bonus_festival'],
  ['bonus_performance_total', 'bonus_performance'],
  ['bonus_other_total', 'bonus_other'],
  ['deduct_labor_ins_total', 'deduct_labor_ins'],
  ['deduct_health_ins_total', 'deduct_health_ins'],
  ['deduct_pension_voluntary_total', 'deduct_pension_voluntary'],
  ['deduct_supplementary_health_total', 'deduct_supplementary_health'],
  ['deduct_tax_total', 'deduct_tax'],
  ['net_total', 'net_salary'],
];

/**
 * 把單一員工的 records (該年度多月) 加總起來。
 * @param {string} employee_id
 * @param {Array} records - 該員工該年度的 salary_records
 * @returns {Object} 合計物件、含所有 *_total 欄位
 */
export function buildEmployeeSummary(employee_id, records) {
  const summary = { employee_id, months_count: (records || []).length };
  for (const [outKey] of SUM_FIELDS) summary[outKey] = 0;
  for (const r of (records || [])) {
    for (const [outKey, srcKey] of SUM_FIELDS) {
      summary[outKey] += Number(r?.[srcKey]) || 0;
    }
  }
  return summary;
}

/**
 * 從一堆 records (多員工 × 多月) 聚合成「每員工一筆」的合計 array。
 * 員工順序 by employee_id 遞增。全 0 員工(months_count=0)不出現。
 * @param {Array} records
 * @param {Object} empNameMap - { employee_id: { name, dept_name } }
 * @returns {Array}
 */
export function aggregateRecordsByEmployee(records, empNameMap = {}) {
  const byEmp = new Map();
  for (const r of (records || [])) {
    if (!r?.employee_id) continue;
    if (!byEmp.has(r.employee_id)) byEmp.set(r.employee_id, []);
    byEmp.get(r.employee_id).push(r);
  }
  const out = [];
  for (const [empId, recs] of byEmp) {
    if (!recs.length) continue;
    const summary = buildEmployeeSummary(empId, recs);
    const emp = empNameMap[empId] || {};
    out.push({
      ...summary,
      name:      emp.name      || '',
      dept_name: emp.dept_name || emp.dept || '',
    });
  }
  out.sort((a, b) => String(a.employee_id).localeCompare(String(b.employee_id)));
  return out;
}

/**
 * 主入口:生 Excel/PDF AOA + filename。
 * @param {Array} records - filter 後 (status='paid'/'locked'、EMP_99999999 排除) 的 salary_records
 * @param {Object} empNameMap - employee_id → { name, dept_name }
 * @param {number} year
 * @returns {{ aoa, filename, columnCount, rows }}
 */
export function buildAnnualSummaryAOA(records, empNameMap, year) {
  const rows = aggregateRecordsByEmployee(records, empNameMap);
  const headers = COLUMNS.map(c => c.label);
  const dataRows = rows.map(row => COLUMNS.map(c => {
    const v = row[c.key];
    if (v === undefined || v === null) return '';
    if (typeof v === 'number') return v;
    return v;
  }));
  // 合計列:第 1 欄 '合計 (X 人)'、sumInTotal=true 欄位加總、其他空字串
  const totalRow = COLUMNS.map((c, i) => {
    if (i === 0) return `合計 (${rows.length} 人)`;
    if (c.sumInTotal) return rows.reduce((s, r) => s + (Number(r[c.key]) || 0), 0);
    return '';
  });
  const aoa = [headers, ...dataRows, totalRow];
  const filename = `annual-salary-summary-${year ?? new Date().getFullYear()}.xlsx`;
  return { aoa, filename, columnCount: COLUMNS.length, rows };
}
