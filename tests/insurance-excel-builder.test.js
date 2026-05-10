// tests/insurance-excel-builder.test.js
//
// 抓 public/js/insurance/excel-builder.js 的 AOA 結構行為。
// 純函式、不真的寫 xlsx 檔(SheetJS 在 browser 端跑、本檔只驗 AOA 對不對)。

import { describe, it, expect } from 'vitest';
import {
  buildInsuranceExportAOA,
  buildEmployeeRow,
  COLUMNS,
} from '../public/js/insurance/excel-builder.js';

const empA = { id: 'EMP_01', name: '張三', dept_name: 'IT', status: 'active' };
const empB = { id: 'EMP_02', name: '李四', dept_name: 'HR', status: 'active' };
const empResigned = { id: 'EMP_99', name: '離職', dept_name: 'IT', status: 'resigned' };

const insMap = {
  EMP_01: {
    has_insurance: true,
    labor_ins_bracket: 30000, health_ins_bracket: 30000, pension_wage: 30000,
    pension_voluntary_rate: 6, health_ins_dependents: 0,
    labor_ins_employee: 600,  labor_ins_company: 2100,
    health_ins_employee: 472, health_ins_company: 1416,
  },
  EMP_02: {
    has_insurance: true,
    labor_ins_bracket: 38200, health_ins_bracket: 38200, pension_wage: 38200,
    pension_voluntary_rate: 0, health_ins_dependents: 1,
    labor_ins_employee: 766,  labor_ins_company: 2674,
    health_ins_employee: 600, health_ins_company: 1800,
  },
};

describe('COLUMNS', () => {
  it('總共 13 欄', () => {
    expect(COLUMNS).toHaveLength(13);
  });
  it('frozen 防誤修改', () => {
    expect(Object.isFrozen(COLUMNS)).toBe(true);
  });
  it('合計欄位只有 4 個(勞保員工/雇主、健保員工/雇主)', () => {
    const sumKeys = COLUMNS.filter(c => c.sumInTotal).map(c => c.key);
    expect(sumKeys).toEqual([
      'labor_ins_employee', 'labor_ins_company',
      'health_ins_employee', 'health_ins_company',
    ]);
  });
});

describe('buildEmployeeRow', () => {
  it('正常員工 + 完整 insurance → 13 欄全填', () => {
    const r = buildEmployeeRow(empA, insMap.EMP_01);
    expect(r).toEqual([
      'EMP_01', '張三', 'IT', '是',
      30000, 30000, 30000, '6%', 0,
      600, 2100, 472, 1416,
    ]);
  });
  it('has_insurance=false → 「否」', () => {
    const r = buildEmployeeRow(empA, { has_insurance: false });
    expect(r[3]).toBe('否');
  });
  it('emp.has_insurance=false → 「否」(覆蓋 ins.has_insurance=true)', () => {
    const r = buildEmployeeRow({ ...empA, has_insurance: false }, { has_insurance: true });
    expect(r[3]).toBe('否');
  });
  it('pension_voluntary_rate=0 → 「0%」', () => {
    const r = buildEmployeeRow(empA, { ...insMap.EMP_01, pension_voluntary_rate: 0 });
    expect(r[7]).toBe('0%');
  });
  it('null/undefined ins → 全 0/否、不 throw', () => {
    expect(() => buildEmployeeRow(empA, null)).not.toThrow();
    const r = buildEmployeeRow(empA, null);
    expect(r[3]).toBe('是');           // 預設未明確 false → 是
    expect(r[4]).toBe(0);              // labor_ins_bracket
    expect(r[12]).toBe(0);             // health_ins_company
  });
  it('dept_name fallback 到 emp.dept', () => {
    const r = buildEmployeeRow({ id: 'X', name: 'X', dept: 'Sales' }, {});
    expect(r[2]).toBe('Sales');
  });
});

describe('buildInsuranceExportAOA', () => {
  it('header 第 1 列、欄位順序對齊 COLUMNS', () => {
    const { aoa } = buildInsuranceExportAOA([empA], insMap);
    expect(aoa[0]).toEqual(COLUMNS.map(c => c.label));
    expect(aoa[0]).toHaveLength(13);
  });

  it('過濾 status != active 員工(resigned 不出現)', () => {
    const { aoa } = buildInsuranceExportAOA([empA, empResigned, empB], insMap);
    // header + 2 active + total = 4 rows
    expect(aoa).toHaveLength(4);
    expect(aoa[1][0]).toBe('EMP_01');
    expect(aoa[2][0]).toBe('EMP_02');
    // EMP_99 resigned 不出現
    expect(aoa.map(r => r[0])).not.toContain('EMP_99');
  });

  it('資料列數值對齊欄位 mapping', () => {
    const { aoa } = buildInsuranceExportAOA([empA, empB], insMap);
    expect(aoa[1]).toEqual([
      'EMP_01', '張三', 'IT', '是',
      30000, 30000, 30000, '6%', 0,
      600, 2100, 472, 1416,
    ]);
    expect(aoa[2]).toEqual([
      'EMP_02', '李四', 'HR', '是',
      38200, 38200, 38200, '0%', 1,
      766, 2674, 600, 1800,
    ]);
  });

  it('合計列 sum 4 個欄位、其他欄位空字串', () => {
    const { aoa } = buildInsuranceExportAOA([empA, empB], insMap);
    const total = aoa[aoa.length - 1];
    expect(total[0]).toBe('合計');
    expect(total[9]).toBe(600 + 766);    // 員工負擔勞保
    expect(total[10]).toBe(2100 + 2674); // 雇主負擔勞保
    expect(total[11]).toBe(472 + 600);   // 員工負擔健保
    expect(total[12]).toBe(1416 + 1800); // 雇主負擔健保
    // 不在 sum 範圍的欄位 = ''
    expect(total[4]).toBe('');           // 勞保投保金額
    expect(total[7]).toBe('');           // 自願提繳率
    expect(total[8]).toBe('');           // 健保眷屬數
  });

  it('空員工列表 → header + 合計列、合計全 0', () => {
    const { aoa } = buildInsuranceExportAOA([], {});
    expect(aoa).toHaveLength(2);
    expect(aoa[1][0]).toBe('合計');
    expect(aoa[1][9]).toBe(0);
    expect(aoa[1][10]).toBe(0);
  });

  it('filename 格式 insurance-YYYY-MM-DD.xlsx', () => {
    const { filename } = buildInsuranceExportAOA([], {});
    expect(filename).toMatch(/^insurance-\d{4}-\d{2}-\d{2}\.xlsx$/);
  });

  it('回傳 columnCount = 13', () => {
    const { columnCount } = buildInsuranceExportAOA([], {});
    expect(columnCount).toBe(13);
  });

  it('null employees / null insMap → 不 throw', () => {
    expect(() => buildInsuranceExportAOA(null, null)).not.toThrow();
    const { aoa } = buildInsuranceExportAOA(null, null);
    expect(aoa).toHaveLength(2);  // header + total
  });
});
