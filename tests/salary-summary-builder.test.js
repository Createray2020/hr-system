// tests/salary-summary-builder.test.js
//
// 抓 public/js/salary-summary/builder.js 純函式行為:
//   - buildEmployeeSummary 單員工合計
//   - aggregateRecordsByEmployee 多員工 group + 排序 + 全 0 員工排除
//   - buildAnnualSummaryAOA AOA 結構 + 合計列
//   - null / 0 寬容
//
// status filter (paid/locked only) 屬於 caller 責任 (backend endpoint)、本檔不測。

import { describe, it, expect } from 'vitest';
import {
  COLUMNS,
  buildEmployeeSummary,
  aggregateRecordsByEmployee,
  buildAnnualSummaryAOA,
} from '../public/js/salary-summary/builder.js';

const empNameMap = {
  EMP_01: { name: '張三', dept_name: 'IT' },
  EMP_02: { name: '李四', dept_name: 'HR' },
  EMP_03: { name: '王五', dept_name: 'IT' },
};

const recordsE01 = [
  // 12 個月、每月一樣
  ...Array.from({ length: 12 }, (_, i) => ({
    employee_id: 'EMP_01', year: 2025, month: i + 1,
    gross_salary: 50000, net_salary: 45000,
    bonus_yearend: 0, bonus_festival: 0, bonus_performance: 0, bonus_other: 0,
    deduct_labor_ins: 1000, deduct_health_ins: 500, deduct_pension_voluntary: 3000,
    deduct_supplementary_health: 0, deduct_tax: 0,
  })),
];
recordsE01[11] = { ...recordsE01[11], bonus_yearend: 100000 };  // 12 月加年終 10 萬

const recordsE02 = [
  // 6 個月 (8月才入職)
  ...Array.from({ length: 5 }, (_, i) => ({
    employee_id: 'EMP_02', year: 2025, month: i + 8,
    gross_salary: 30000, net_salary: 28000,
    bonus_yearend: null, bonus_festival: 2000, bonus_performance: null, bonus_other: 0,
    deduct_labor_ins: 600, deduct_health_ins: null, deduct_pension_voluntary: 0,
    deduct_supplementary_health: 0, deduct_tax: 0,
  })),
];

describe('COLUMNS', () => {
  it('15 欄、frozen', () => {
    expect(COLUMNS).toHaveLength(15);
    expect(Object.isFrozen(COLUMNS)).toBe(true);
  });
  it('合計欄位 (sumInTotal=true) 共 12 個 (months_count + 11 個金額)', () => {
    expect(COLUMNS.filter(c => c.sumInTotal)).toHaveLength(12);
  });
  it('前 3 欄是 ID / 姓名 / 部門 (text、不 sum)', () => {
    expect(COLUMNS.slice(0, 3).every(c => !c.sumInTotal)).toBe(true);
    expect(COLUMNS[0].key).toBe('employee_id');
    expect(COLUMNS[1].key).toBe('name');
    expect(COLUMNS[2].key).toBe('dept_name');
  });
  it('最後一欄是 net_total (實發合計)', () => {
    expect(COLUMNS[14].key).toBe('net_total');
  });
});

describe('buildEmployeeSummary', () => {
  it('12 個月 record (含 12 月年終 10 萬) → 合計正確', () => {
    const s = buildEmployeeSummary('EMP_01', recordsE01);
    expect(s.employee_id).toBe('EMP_01');
    expect(s.months_count).toBe(12);
    expect(s.gross_total).toBe(50000 * 12);                    // 600000
    expect(s.net_total).toBe(45000 * 12);                       // 540000
    expect(s.bonus_yearend_total).toBe(100000);                 // 12 月那 1 筆
    expect(s.bonus_festival_total).toBe(0);
    expect(s.deduct_labor_ins_total).toBe(1000 * 12);           // 12000
    expect(s.deduct_health_ins_total).toBe(500 * 12);           // 6000
    expect(s.deduct_pension_voluntary_total).toBe(3000 * 12);   // 36000
  });

  it('null / undefined 欄位視為 0', () => {
    const s = buildEmployeeSummary('EMP_02', recordsE02);
    expect(s.months_count).toBe(5);
    expect(s.bonus_yearend_total).toBe(0);              // 5 個月 null
    expect(s.bonus_festival_total).toBe(2000 * 5);      // 10000
    expect(s.bonus_performance_total).toBe(0);          // null
    expect(s.deduct_health_ins_total).toBe(600 * 0);    // null * 5 = 0
  });

  it('空 records → months_count=0、所有 *_total=0', () => {
    const s = buildEmployeeSummary('EMP_X', []);
    expect(s.employee_id).toBe('EMP_X');
    expect(s.months_count).toBe(0);
    expect(s.gross_total).toBe(0);
    expect(s.net_total).toBe(0);
  });

  it('null records 不 throw', () => {
    expect(() => buildEmployeeSummary('EMP_X', null)).not.toThrow();
    const s = buildEmployeeSummary('EMP_X', null);
    expect(s.months_count).toBe(0);
  });
});

describe('aggregateRecordsByEmployee', () => {
  it('多員工 records → 每員工一筆 + 依 employee_id 排序', () => {
    const records = [...recordsE02, ...recordsE01];  // 故意先放 E02 後 E01
    const rows = aggregateRecordsByEmployee(records, empNameMap);
    expect(rows).toHaveLength(2);
    expect(rows[0].employee_id).toBe('EMP_01');   // 排序後 EMP_01 在前
    expect(rows[1].employee_id).toBe('EMP_02');
    expect(rows[0].name).toBe('張三');
    expect(rows[0].dept_name).toBe('IT');
    expect(rows[0].months_count).toBe(12);
    expect(rows[1].months_count).toBe(5);
  });

  it('records 沒 employee_id 的 row 跳過、不 throw', () => {
    const records = [{ year: 2025, month: 1, gross_salary: 100 }, ...recordsE01];
    const rows = aggregateRecordsByEmployee(records, empNameMap);
    expect(rows).toHaveLength(1);
    expect(rows[0].employee_id).toBe('EMP_01');
  });

  it('員工不在 empNameMap → name / dept_name 為空字串', () => {
    const records = [{ employee_id: 'EMP_X', gross_salary: 1000, net_salary: 900 }];
    const rows = aggregateRecordsByEmployee(records, {});
    expect(rows[0].name).toBe('');
    expect(rows[0].dept_name).toBe('');
  });

  it('null records → []', () => {
    expect(aggregateRecordsByEmployee(null, {})).toEqual([]);
    expect(aggregateRecordsByEmployee([], {})).toEqual([]);
  });
});

describe('buildAnnualSummaryAOA', () => {
  it('多員工 → header + N 員工列 + 合計列', () => {
    const records = [...recordsE01, ...recordsE02];
    const { aoa, columnCount, rows } = buildAnnualSummaryAOA(records, empNameMap, 2025);
    expect(columnCount).toBe(15);
    expect(rows).toHaveLength(2);
    expect(aoa).toHaveLength(4);  // header + 2 員工 + 合計
    expect(aoa[0]).toEqual(COLUMNS.map(c => c.label));
  });

  it('員工列數值對齊 (EMP_01 12 個月 + 12 月年終 10 萬)', () => {
    const { aoa } = buildAnnualSummaryAOA(recordsE01, empNameMap, 2025);
    const row = aoa[1];
    expect(row[0]).toBe('EMP_01');
    expect(row[1]).toBe('張三');
    expect(row[2]).toBe('IT');
    expect(row[3]).toBe(12);                     // months_count
    expect(row[4]).toBe(50000 * 12);              // gross_total
    expect(row[5]).toBe(100000);                 // bonus_yearend_total
    expect(row[14]).toBe(45000 * 12);             // net_total
  });

  it('合計列:第 1 欄「合計 (X 人)」、sumInTotal 欄加總、其他空字串', () => {
    const records = [...recordsE01, ...recordsE02];
    const { aoa } = buildAnnualSummaryAOA(records, empNameMap, 2025);
    const total = aoa[aoa.length - 1];
    expect(total[0]).toBe('合計 (2 人)');
    expect(total[1]).toBe('');                                       // 姓名
    expect(total[2]).toBe('');                                       // 部門
    expect(total[3]).toBe(12 + 5);                                   // months_count
    expect(total[4]).toBe(50000 * 12 + 30000 * 5);                   // gross_total
    expect(total[5]).toBe(100000);                                   // bonus_yearend
    expect(total[14]).toBe(45000 * 12 + 28000 * 5);                  // net_total
  });

  it('空 records → header + 合計 (0 人) + 全 0', () => {
    const { aoa, rows } = buildAnnualSummaryAOA([], {}, 2025);
    expect(rows).toHaveLength(0);
    expect(aoa).toHaveLength(2);
    expect(aoa[1][0]).toBe('合計 (0 人)');
    expect(aoa[1][3]).toBe(0);
    expect(aoa[1][14]).toBe(0);
  });

  it('filename 含年度', () => {
    const { filename } = buildAnnualSummaryAOA([], {}, 2025);
    expect(filename).toBe('annual-salary-summary-2025.xlsx');
  });

  it('沒給 year → 用今年', () => {
    const { filename } = buildAnnualSummaryAOA([], {});
    expect(filename).toMatch(/^annual-salary-summary-\d{4}\.xlsx$/);
  });
});
