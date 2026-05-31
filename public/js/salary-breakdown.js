// public/js/salary-breakdown.js — 共用薪資明細欄位定義 + 拆解 helper
//
// 服務:salary.html(HR 全員)、employee-salary.html(員工自己)、payslip.html
// 對齊:lib/salary/calculator.js computeGrossSalary +
//      migrations/2026_05_30_add_salary_grade_manager_allowance.sql 的 GENERATED 公式
// 測試:tests/salary-breakdown.test.js
//
// 載入後掛 globalThis.SalaryBreakdown(瀏覽器 = window.SalaryBreakdown):
//   - GROSS_FIELDS / DEDUCT_FIELDS:有序欄位定義(SSOT、不要在 caller 端增減)
//   - buildSalaryBreakdown(sal):回 { grossItems, grossSubtotal, deductItems, deductSubtotal, net }
//
// 規則:
//   - 應發 base 欄是合成的:prorata_base 非 null 用 prorata_base + label「本薪(離職月按出勤比例)」;
//     否則用 base_salary、label「本薪」
//   - 應發 14 + base 合成 = 15 項;扣除 12 項
//   - subtotal 不濾 0(全項加總),item list 濾掉 value === 0
//   - 絕不納入 admin_audit_note / status / snapshot / audit 欄位

(function (global) {
  'use strict';

  // 應發 15 項(__base__ 是合成欄、實際從 prorata_base / base_salary 動態取值)
  const GROSS_FIELDS = [
    { key: '__base__',                label: '本薪' },
    { key: 'attendance_bonus_actual', label: '全勤獎金' },
    { key: 'grade_allowance',         label: '職等加給' },
    { key: 'manager_allowance',       label: '主管加給' },
    { key: 'allowance',               label: '津貼（系統）' },
    { key: 'extra_allowance',         label: '額外津貼' },
    { key: 'overtime_pay_auto',       label: '加班費（系統計算）' },
    { key: 'overtime_pay_manual',     label: '加班費（手動調整）' },
    { key: 'holiday_work_pay',        label: '假日工資' },
    { key: 'comp_expiry_payout',      label: '補休失效轉現' },
    { key: 'settlement_amount',       label: '特休結算' },
    { key: 'bonus_yearend',           label: '年終獎金' },
    { key: 'bonus_festival',          label: '三節獎金' },
    { key: 'bonus_performance',       label: '績效獎金' },
    { key: 'bonus_other',             label: '其他獎金' },
  ];

  // 扣除 12 項(對齊 net_salary GENERATED 公式)
  const DEDUCT_FIELDS = [
    { key: 'deduct_absence',              label: '曠職扣薪' },
    { key: 'deduct_labor_ins',            label: '勞保自付' },
    { key: 'deduct_health_ins',           label: '健保自付' },
    { key: 'deduct_supplementary_health', label: '二代健保補充保費' },
    { key: 'deduct_pension_voluntary',    label: '勞退自願提繳' },
    { key: 'deduct_tax',                  label: '所得稅扣繳' },
    { key: 'attendance_penalty_total',    label: '出勤懲處罰款' },
    { key: 'deduct_welfare_fund',         label: '職工福利金' },
    { key: 'deduct_union_fee',            label: '工會會費' },
    { key: 'deduct_court_garnishment',    label: '法院扣押／行政執行' },
    { key: 'deduct_loan_repayment',       label: '借支／貸款還款' },
    { key: 'deduct_other',                label: '其他扣款' },
  ];

  function n(v) { return v == null ? 0 : (Number(v) || 0); }
  function r2(v) { return Math.round(Number(v) * 100) / 100; }

  function buildSalaryBreakdown(sal) {
    sal = sal || {};

    // 應發
    const hasProrata = sal.prorata_base != null;
    const baseValue = hasProrata ? n(sal.prorata_base) : n(sal.base_salary);
    const baseLabel = hasProrata ? '本薪（離職月按出勤比例）' : '本薪';

    const grossAll = GROSS_FIELDS.map(f => {
      if (f.key === '__base__') {
        return { key: '__base__', label: baseLabel, value: baseValue };
      }
      return { key: f.key, label: f.label, value: n(sal[f.key]) };
    });

    // 扣除
    const deductAll = DEDUCT_FIELDS.map(f => {
      const item = { key: f.key, label: f.label, value: n(sal[f.key]) };
      // deduct_other 有 note 時、label 附註(對齊 payslip.html L99 原語意)
      if (f.key === 'deduct_other' && sal.deduct_other_note) {
        item.note = String(sal.deduct_other_note);
        item.label = `${f.label}（${item.note}）`;
      }
      return item;
    });

    const grossSubtotal = grossAll.reduce((s, it) => s + it.value, 0);
    const deductSubtotal = deductAll.reduce((s, it) => s + it.value, 0);

    return {
      grossItems:     grossAll.filter(it => it.value !== 0),
      grossSubtotal:  r2(grossSubtotal),
      deductItems:    deductAll.filter(it => it.value !== 0),
      deductSubtotal: r2(deductSubtotal),
      net:            r2(grossSubtotal - deductSubtotal),
    };
  }

  const api = { GROSS_FIELDS, DEDUCT_FIELDS, buildSalaryBreakdown };

  // 掛到 globalThis(瀏覽器 = window;Node ESM = globalThis)
  if (global) global.SalaryBreakdown = api;

  // CJS 兼容(Node CommonJS 模式才會 set;ESM 下 module 為 undefined、被 guard 擋)
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis :
   typeof window !== 'undefined' ? window :
   typeof global !== 'undefined' ? global : this);
