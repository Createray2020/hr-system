// public/js/salary-export/builder.js
//
// 純函式:把某月一張 salary_records 清單(salary.html 的 allRows、含 emp_name / dept_name
// enrich)出成「月薪資清冊」AOA(SheetJS aoa_to_sheet 直吃),給 HR/會計打帳用。
//
// 對齊既有兩支匯出 pattern:
//   - public/js/salary-summary/builder.js     年度合計版(buildAnnualSummaryAOA)
//   - public/salary-period.html exportAnnualExcel()  SheetJS aoa → writeFile
//
// 應發/扣除欄位「重用」public/js/salary-breakdown.js 的 GROSS_FIELDS / DEDUCT_FIELDS,
// 不在本檔重定義或重算 — 確保與每位員工的 payslip 顯示一致(SSOT)。
// __base__ 合成本薪:對齊 buildSalaryBreakdown 邏輯(prorata_base 非 null 用 prorata_base、
// 否則用 base_salary)。Excel 場景固定 label「本薪」、不附時薪/離職月描述(那些只影響
// 螢幕顯示、不影響金額)。
//
// vitest 抓行為:tests/salary-export-builder.test.js

// side-effect 載入 salary-breakdown.js(IIFE 會把 SalaryBreakdown 掛到 globalThis);
// salary.html 已用 <script src="/js/salary-breakdown.js"> 在前頭載過、瀏覽器端不會重跑。
import '../salary-breakdown.js';

const SB = globalThis.SalaryBreakdown;
if (!SB || !SB.GROSS_FIELDS || !SB.DEDUCT_FIELDS) {
  throw new Error('SalaryBreakdown not loaded — salary-export builder 需要先有 GROSS_FIELDS / DEDUCT_FIELDS');
}
const { GROSS_FIELDS, DEDUCT_FIELDS } = SB;

function n(v) { return v == null ? 0 : (Number(v) || 0); }
function r2(v) { return Math.round(Number(v) * 100) / 100; }

// 對齊 salary-breakdown.js 取值邏輯
function getGrossFieldValue(record, f) {
  if (f.key === '__base__') {
    return record?.prorata_base != null ? n(record.prorata_base) : n(record?.base_salary);
  }
  return n(record?.[f.key]);
}
function getDeductFieldValue(record, f) {
  return n(record?.[f.key]);
}

const IDENTITY_COLUMNS = [
  { key: 'employee_id', label: '員工編號', type: 'identity', get: (r) => r?.employee_id || '' },
  { key: 'emp_name',    label: '姓名',     type: 'identity', get: (r) => r?.emp_name || '' },
  { key: 'dept_name',   label: '部門',     type: 'identity', get: (r) => r?.dept_name || '' },
];

// 應發 17 項 → 用 salary-breakdown SSOT 的 label,key 加 'gross:' 前綴避免和扣除碰撞
const GROSS_COLUMNS = GROSS_FIELDS.map(f => ({
  key: `gross:${f.key}`,
  label: f.label,
  type: 'amount',
  sum: true,
  get: (r) => r2(getGrossFieldValue(r, f)),
}));

const GROSS_TOTAL_COLUMN = {
  key: 'gross_salary', label: '應發合計', type: 'amount', sum: true,
  get: (r) => r2(n(r?.gross_salary)),
};

const DEDUCT_COLUMNS = DEDUCT_FIELDS.map(f => ({
  key: `deduct:${f.key}`,
  label: f.label,
  type: 'amount',
  sum: true,
  get: (r) => r2(getDeductFieldValue(r, f)),
}));

const NET_COLUMN = {
  key: 'net_salary', label: '實發', type: 'amount', sum: true,
  get: (r) => r2(n(r?.net_salary)),
};

const EMPLOYER_COST_COLUMNS = [
  { key: 'employer_cost_labor',        label: '雇主負擔・勞保' },
  { key: 'employer_cost_health',       label: '雇主負擔・健保' },
  { key: 'employer_cost_pension',      label: '雇主負擔・勞退提繳' },
  { key: 'employer_cost_occupational', label: '雇主負擔・職災保險' },
  { key: 'employer_cost_employment',   label: '雇主負擔・就業保險' },
  { key: 'employer_cost_welfare',      label: '雇主負擔・職福金' },
].map(f => ({
  key: f.key, label: f.label, type: 'amount', sum: true,
  get: (r) => r2(n(r?.[f.key])),
}));

const STATUS_COLUMN = {
  key: 'status', label: '狀態', type: 'identity',
  get: (r) => r?.status || '',
};

export const MONTHLY_EXPORT_COLUMNS = Object.freeze([
  ...IDENTITY_COLUMNS,
  ...GROSS_COLUMNS,
  GROSS_TOTAL_COLUMN,
  ...DEDUCT_COLUMNS,
  NET_COLUMN,
  ...EMPLOYER_COST_COLUMNS,
  STATUS_COLUMN,
]);

/**
 * 月薪資清冊 AOA。
 * @param {Array} records  salary.html 的 allRows(已含 emp_name / dept_name enrich)
 * @param {{year:number,month:number}} ctx
 * @returns {{aoa:Array<Array>, filename:string, columnCount:number, rows:Array}}
 *
 * 規格:
 *   - 第 1 列:中文 label 表頭
 *   - 中間每員工一列(數值欄是 number、空值補 0,讓 Excel 可加總)
 *   - 最後一列:合計(身分欄空、第 1 欄寫「合計 (N 人)」、sum=true 欄加總)
 *   - 員工依 employee_id 升序排序(對齊 annual summary 慣例)
 *   - 空 records → 只回表頭一列(讓 caller 決定要不要 toast)
 */
export function buildMonthlyPayrollAOA(records, { year, month } = {}) {
  const recs = Array.isArray(records) ? records.filter(r => r && r.employee_id) : [];
  const headers = MONTHLY_EXPORT_COLUMNS.map(c => c.label);
  const mm = Number.isInteger(month) ? String(month).padStart(2, '0') : '';
  const filename = (year && mm)
    ? `薪資清冊_${year}-${mm}.xlsx`
    : 'monthly-payroll.xlsx';

  if (!recs.length) {
    return { aoa: [headers], filename, columnCount: MONTHLY_EXPORT_COLUMNS.length, rows: [] };
  }

  const sorted = [...recs].sort((a, b) =>
    String(a.employee_id).localeCompare(String(b.employee_id))
  );
  const dataRows = sorted.map(r => MONTHLY_EXPORT_COLUMNS.map(c => c.get(r)));
  const totalRow = MONTHLY_EXPORT_COLUMNS.map((c, i) => {
    if (i === 0) return `合計 (${sorted.length} 人)`;
    if (c.sum) return r2(sorted.reduce((s, r) => s + n(c.get(r)), 0));
    return '';
  });
  const aoa = [headers, ...dataRows, totalRow];
  return { aoa, filename, columnCount: MONTHLY_EXPORT_COLUMNS.length, rows: sorted };
}
