// public/js/insurance/excel-builder.js
//
// 純 function:從 employees + insurance_settings 撈合的資料、生 13 欄 AOA + 合計列。
// 不依賴 XLSX 庫;caller 用 XLSX.utils.aoa_to_sheet(result.aoa) 轉為 sheet。
//
// 對齊 public/js/schedule/excel-builder.js 模式(ESM、純函式、可被 vitest 直接 import)。
//
// 用途:
//   - public/insurance.html「📊 匯出 Excel」按鈕、買 SheetJS 後直接寫檔
//   - public/insurance-export.html PDF 匯出頁、render HTML 表格也用同一份資料源
//   - tests/insurance-excel-builder.test.js 抓 AOA 結構

export const COLUMNS = Object.freeze([
  { key: 'id',                     label: '員工 ID',       sumInTotal: false },
  { key: 'name',                   label: '姓名',           sumInTotal: false },
  { key: 'dept_name',              label: '部門',           sumInTotal: false },
  { key: 'has_insurance',          label: '是否投保',       sumInTotal: false },
  { key: 'labor_ins_bracket',      label: '勞保投保金額',   sumInTotal: false },
  { key: 'health_ins_bracket',     label: '健保投保金額',   sumInTotal: false },
  { key: 'pension_wage',           label: '月提繳工資',     sumInTotal: false },
  { key: 'pension_voluntary_rate', label: '自願提繳率',     sumInTotal: false },
  { key: 'health_ins_dependents',  label: '健保眷屬數',     sumInTotal: false },
  { key: 'labor_ins_employee',     label: '員工負擔勞保',   sumInTotal: true },
  { key: 'labor_ins_company',      label: '雇主負擔勞保',   sumInTotal: true },
  { key: 'health_ins_employee',    label: '員工負擔健保',   sumInTotal: true },
  { key: 'health_ins_company',     label: '雇主負擔健保',   sumInTotal: true },
]);

/**
 * 把單一員工 + insurance_settings 攤平成 13 欄 row(對齊 COLUMNS 順序)。
 * has_insurance → 「是 / 否」、pension_voluntary_rate → 「N%」、其他數字保留 number type。
 */
export function buildEmployeeRow(emp, ins) {
  const has = (ins?.has_insurance !== false) && (emp?.has_insurance !== false);
  const rate = Number(ins?.pension_voluntary_rate ?? 0);
  return [
    emp?.id || '',
    emp?.name || '',
    emp?.dept_name || emp?.dept || '',
    has ? '是' : '否',
    Number(ins?.labor_ins_bracket || 0),
    Number(ins?.health_ins_bracket || 0),
    Number(ins?.pension_wage || 0),
    `${rate}%`,
    Number(ins?.health_ins_dependents || 0),
    Number(ins?.labor_ins_employee || 0),
    Number(ins?.labor_ins_company || 0),
    Number(ins?.health_ins_employee || 0),
    Number(ins?.health_ins_company || 0),
  ];
}

/**
 * 主入口:從 employees array + insMap 生 AOA + filename。
 * - 過濾 status != 'active' 員工
 * - 第一列 = headers
 * - 中間 = 員工資料
 * - 最後 = 合計列(只 sum 4 個欄位:勞保員工/雇主、健保員工/雇主)
 */
export function buildInsuranceExportAOA(employees, insMap) {
  const headers = COLUMNS.map(c => c.label);
  const rows = (employees || [])
    .filter(e => e?.status === 'active')
    .map(e => buildEmployeeRow(e, insMap?.[e.id] || {}));

  // 合計列:第一欄 '合計'、中間空、sumInTotal=true 的欄位加總
  const totalRow = COLUMNS.map((c, i) => {
    if (i === 0) return '合計';
    if (c.sumInTotal) {
      return rows.reduce((s, r) => s + (Number(r[i]) || 0), 0);
    }
    return '';
  });

  const aoa = [headers, ...rows, totalRow];
  const filename = `insurance-${new Date().toISOString().slice(0, 10)}.xlsx`;
  return { aoa, filename, columnCount: COLUMNS.length };
}
