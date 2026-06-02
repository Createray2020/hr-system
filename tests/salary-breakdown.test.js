// tests/salary-breakdown.test.js — 共用薪資明細 helper(public/js/salary-breakdown.js)單元測試
//
// 不連 DB、用自造 fixture 確認:
//   1. grossSubtotal === fixture.gross_salary(誤差 ≤ 0.01)
//   2. grossSubtotal − deductSubtotal === fixture.net_salary
//   3. 0 值欄位被濾出 items list、subtotal 仍是「全項加總」
//   4. prorata_base 切換邏輯
//   5. deduct_other_note 串接 label
//
// 載入方式:public/js/salary-breakdown.js 是 plain JS IIFE、無 ESM export,
// 用 side-effect import 後讀 globalThis.SalaryBreakdown(對齊 public/js/roles.js 慣例)。

import { describe, it, expect, beforeAll } from 'vitest';

let SB;
beforeAll(async () => {
  await import('../public/js/salary-breakdown.js');
  SB = globalThis.SalaryBreakdown;
});

// ─── Fixture: 一般月、底薪 + 全勤 + 職等加給(無變動)──────
function makeNormal() {
  return {
    base_salary: 30000, prorata_base: null,
    attendance_bonus_actual: 2000,
    grade_allowance: 3000, manager_allowance: 0,
    allowance: 0, extra_allowance: 0,
    overtime_pay_auto: 0, overtime_pay_manual: 0,
    holiday_work_pay: 0, comp_expiry_payout: 0, settlement_amount: 0,
    bonus_yearend: 0, bonus_festival: 0, bonus_performance: 0, bonus_other: 0,
    deduct_absence: 0, deduct_labor_ins: 599, deduct_health_ins: 500,
    deduct_supplementary_health: 0, deduct_pension_voluntary: 0,
    deduct_tax: 0, attendance_penalty_total: 0,
    deduct_welfare_fund: 0, deduct_union_fee: 0,
    deduct_court_garnishment: 0, deduct_loan_repayment: 0,
    deduct_other: 0,
    // 模擬 DB GENERATED 預期值
    gross_salary: 35000,         // 30000 + 2000 + 3000
    net_salary:   33901,         // 35000 − 599 − 500
  };
}

// ─── Fixture: 含補休失效轉現 ─────────────────────────
function makeWithVariable() {
  const r = makeNormal();
  r.comp_expiry_payout = 9798.75;
  r.gross_salary = 35000 + 9798.75;
  r.net_salary = r.gross_salary - 599 - 500;
  return r;
}

// ─── Fixture: 離職月 pro-rata(柯郁含真實案例)──────────
function makeFinalMonth() {
  const baseBlend = 12580.65 + 838.71 + 419.35;
  return {
    base_salary: 30000, prorata_base: 12580.65,
    attendance_bonus_actual: 838.71,
    grade_allowance: 419.35, manager_allowance: 0,
    allowance: 0, extra_allowance: 0,
    overtime_pay_auto: 0, overtime_pay_manual: 0,
    holiday_work_pay: 0,
    comp_expiry_payout: 1340, settlement_amount: 0,
    bonus_yearend: 0, bonus_festival: 0, bonus_performance: 0, bonus_other: 0,
    deduct_absence: 0, deduct_labor_ins: 250, deduct_health_ins: 211,
    deduct_supplementary_health: 0, deduct_pension_voluntary: 0,
    deduct_tax: 0, attendance_penalty_total: 0,
    deduct_welfare_fund: 0, deduct_union_fee: 0,
    deduct_court_garnishment: 0, deduct_loan_repayment: 0,
    deduct_other: 0,
    gross_salary: baseBlend + 1340,                // 15178.71
    net_salary:   baseBlend + 1340 - 250 - 211,    // 14717.71
  };
}

describe('SalaryBreakdown.buildSalaryBreakdown', () => {
  it('一般月:grossSubtotal === fixture.gross_salary', () => {
    const f = makeNormal();
    const r = SB.buildSalaryBreakdown(f);
    expect(Math.abs(r.grossSubtotal - f.gross_salary)).toBeLessThan(0.01);
  });

  it('一般月:grossSubtotal − deductSubtotal === fixture.net_salary', () => {
    const f = makeNormal();
    const r = SB.buildSalaryBreakdown(f);
    expect(Math.abs(r.net - f.net_salary)).toBeLessThan(0.01);
  });

  it('含變動給付(comp_expiry_payout):gross / net 都對得上', () => {
    const f = makeWithVariable();
    const r = SB.buildSalaryBreakdown(f);
    expect(Math.abs(r.grossSubtotal - f.gross_salary)).toBeLessThan(0.01);
    expect(Math.abs(r.net - f.net_salary)).toBeLessThan(0.01);
    expect(r.grossItems.some(it => it.key === 'comp_expiry_payout')).toBe(true);
  });

  it('離職月 pro-rata:用 prorata_base、label 含「離職月」', () => {
    const f = makeFinalMonth();
    const r = SB.buildSalaryBreakdown(f);
    expect(Math.abs(r.grossSubtotal - f.gross_salary)).toBeLessThan(0.01);
    expect(Math.abs(r.net - f.net_salary)).toBeLessThan(0.01);
    const baseItem = r.grossItems.find(it => it.key === '__base__');
    expect(baseItem).toBeTruthy();
    expect(baseItem.value).toBe(12580.65);
    expect(baseItem.label).toContain('離職月');
  });

  it('value=0 的欄位被濾出 items list、但 subtotal 仍是全項加總', () => {
    const f = makeNormal();
    const r = SB.buildSalaryBreakdown(f);
    // 一般月應發只有 base+全勤+職等 3 項非 0(其餘 12 項都 0)
    expect(r.grossItems.length).toBe(3);
    // subtotal 仍包含全 15 項(雖然 12 項是 0、加起來不變,證明邏輯一致)
    expect(r.grossSubtotal).toBe(35000);
    // 一般月扣除 2 項非 0(labor + health)
    expect(r.deductItems.length).toBe(2);
    expect(r.deductSubtotal).toBe(1099);
  });

  it('deduct_other 有 note 時、label 附 note', () => {
    const f = makeNormal();
    f.deduct_other = 500;
    f.deduct_other_note = '5月借支';
    const r = SB.buildSalaryBreakdown(f);
    const item = r.deductItems.find(it => it.key === 'deduct_other');
    expect(item).toBeTruthy();
    expect(item.label).toContain('5月借支');
    expect(item.value).toBe(500);
    expect(item.note).toBe('5月借支');
  });

  it('勞健保 label 附投保薪資 snapshot(洪千雅實際:42,000)', () => {
    const f = makeNormal();
    f.insured_salary_labor_snapshot  = 42000;
    f.insured_salary_health_snapshot = 42000;
    f.deduct_labor_ins  = 756;
    f.deduct_health_ins = 590;
    const r = SB.buildSalaryBreakdown(f);
    const labor  = r.deductItems.find(it => it.key === 'deduct_labor_ins');
    const health = r.deductItems.find(it => it.key === 'deduct_health_ins');
    expect(labor).toBeTruthy();
    expect(labor.label).toContain('投保');
    expect(labor.label).toContain('42,000');
    expect(labor.value).toBe(756);
    expect(health).toBeTruthy();
    expect(health.label).toContain('投保');
    expect(health.label).toContain('42,000');
    expect(health.value).toBe(590);
  });

  it('未投保(snapshot=0 / 扣項=0):勞健保整行被 filter,不出現「投保 0」', () => {
    const f = makeNormal();
    f.insured_salary_labor_snapshot  = 0;
    f.insured_salary_health_snapshot = 0;
    f.deduct_labor_ins  = 0;
    f.deduct_health_ins = 0;
    const r = SB.buildSalaryBreakdown(f);
    expect(r.deductItems.find(it => it.key === 'deduct_labor_ins')).toBeUndefined();
    expect(r.deductItems.find(it => it.key === 'deduct_health_ins')).toBeUndefined();
  });

  it('null / undefined sal 不炸、回 0 結果', () => {
    const r1 = SB.buildSalaryBreakdown(null);
    expect(r1.grossSubtotal).toBe(0);
    expect(r1.deductSubtotal).toBe(0);
    expect(r1.net).toBe(0);
    expect(r1.grossItems.length).toBe(0);
    expect(r1.deductItems.length).toBe(0);
    const r2 = SB.buildSalaryBreakdown(undefined);
    expect(r2.grossSubtotal).toBe(0);
  });

  it('GROSS_FIELDS / DEDUCT_FIELDS 順序固定、長度 16 + 12(2026-06-03 加 night_allowance)', () => {
    expect(SB.GROSS_FIELDS.length).toBe(16);
    expect(SB.DEDUCT_FIELDS.length).toBe(12);
    expect(SB.GROSS_FIELDS[0].key).toBe('__base__');
    expect(SB.GROSS_FIELDS[1].key).toBe('attendance_bonus_actual');
    // night_allowance 插在 extra_allowance 後、overtime_pay_auto 前
    const nightIdx = SB.GROSS_FIELDS.findIndex(f => f.key === 'night_allowance');
    const extraIdx = SB.GROSS_FIELDS.findIndex(f => f.key === 'extra_allowance');
    const otIdx    = SB.GROSS_FIELDS.findIndex(f => f.key === 'overtime_pay_auto');
    expect(extraIdx).toBeGreaterThan(-1);
    expect(nightIdx).toBe(extraIdx + 1);
    expect(otIdx).toBe(nightIdx + 1);
    expect(SB.DEDUCT_FIELDS[0].key).toBe('deduct_absence');
    expect(SB.DEDUCT_FIELDS[DEDUCT_LAST_IDX()].key).toBe('deduct_other');
  });

  // ── buildCompExpiryLines ─────────────────────────────
  // 對齊 /api/comp-time?view=expiry 回傳的 records shape;確認 Σ payout 等於
  // 該員工該月 salary_records.comp_expiry_payout、hourly 反推正確。

  function makeCompRecord({ id, remain, payout, expires_at, processed_at, src_ot }) {
    return {
      id,
      earned_hours: remain,
      used_hours:   0,
      remaining_hours: remain,
      expires_at,
      expiry_processed_at: processed_at,
      expiry_payout_amount: payout,
      status: 'expired_paid',
      source_overtime_request_id: src_ot,
    };
  }

  it('buildCompExpiryLines:洪千雅 5月真實案例 — 1 筆 58.5h × 125 × 1.34 = 9798.75', () => {
    const records = [
      makeCompRecord({ id: 36, remain: 58.5, payout: 9798.75,
        expires_at: '2026-04-30', processed_at: '2026-04-30T17:00:40+00', src_ot: null }),
    ];
    const r = SB.buildCompExpiryLines(records);
    expect(r.lines.length).toBe(1);
    expect(r.lines[0].payout).toBe(9798.75);
    // hourly 反推 = 9798.75 / (58.5 × 1.34) = 125 整
    expect(r.lines[0].sub).toContain('剩餘 58.5h');
    expect(r.lines[0].sub).toContain('時薪 125');
    expect(r.lines[0].sub).toContain('1.34 倍');
    expect(r.lines[0].label).toBe('補休 #36');  // src_ot=null → 不附加班單號
    expect(Math.abs(r.total - 9798.75)).toBeLessThan(0.01);
  });

  it('buildCompExpiryLines:邱子于 5月案例 — Σ payout === comp_expiry_payout', () => {
    const records = [
      makeCompRecord({ id: 45, remain: 67, payout: 11222.50,
        expires_at: '2026-04-30', processed_at: '2026-04-30T17:00:40+00', src_ot: null }),
    ];
    const r = SB.buildCompExpiryLines(records);
    expect(Math.abs(r.total - 11222.50)).toBeLessThan(0.01);
    expect(r.lines[0].sub).toContain('時薪 125');
  });

  it('buildCompExpiryLines:多筆對應同月、Σ 對得上總額', () => {
    const records = [
      makeCompRecord({ id: 1, remain: 10, payout: 1675,
        expires_at: '2026-05-10', processed_at: '2026-05-11T01:00:00+08', src_ot: 100 }),
      makeCompRecord({ id: 2, remain: 5, payout: 837.5,
        expires_at: '2026-05-20', processed_at: '2026-05-21T01:00:00+08', src_ot: 101 }),
    ];
    const r = SB.buildCompExpiryLines(records);
    expect(r.lines.length).toBe(2);
    expect(Math.abs(r.total - 2512.5)).toBeLessThan(0.01);
    // src_ot 有值 → label 附加班單號
    expect(r.lines[0].label).toContain('來自加班單 #100');
    expect(r.lines[1].label).toContain('來自加班單 #101');
  });

  it('buildCompExpiryLines:remaining_hours=0 → hourly=0 不爆 / payout 視為 0', () => {
    const records = [
      makeCompRecord({ id: 99, remain: 0, payout: 0,
        expires_at: '2026-05-30', processed_at: '2026-05-31T01:00:00+08', src_ot: null }),
    ];
    const r = SB.buildCompExpiryLines(records);
    expect(r.total).toBe(0);
    expect(r.lines[0].sub).toContain('時薪 0');
  });

  it('buildCompExpiryLines:null/undefined records 不爆、回空陣列', () => {
    const r1 = SB.buildCompExpiryLines(null);
    expect(r1.lines).toEqual([]);
    expect(r1.total).toBe(0);
    const r2 = SB.buildCompExpiryLines(undefined);
    expect(r2.lines).toEqual([]);
  });

  it('buildCompExpiryLines:meta 顯示「expires_at 到期 · processed 處理」', () => {
    const records = [
      makeCompRecord({ id: 54, remain: 8, payout: 1340,
        expires_at: '2026-05-13', processed_at: '2026-05-26T00:38:32+08', src_ot: null }),
    ];
    const r = SB.buildCompExpiryLines(records);
    expect(r.lines[0].meta).toContain('2026-05-13 到期');
    expect(r.lines[0].meta).toContain('2026-05-26 處理');
  });

  it('不納入 audit/狀態/snapshot 欄位', () => {
    const f = makeNormal();
    f.admin_audit_note = '不該出現';
    f.status = 'paid';
    f.calculated_at = '2026-05-30T10:00:00Z';
    f.taxable_income_snapshot = 99999;
    f.insured_salary_labor_snapshot = 33300;
    const r = SB.buildSalaryBreakdown(f);
    const allKeys = [...r.grossItems, ...r.deductItems].map(it => it.key);
    expect(allKeys).not.toContain('admin_audit_note');
    expect(allKeys).not.toContain('status');
    expect(allKeys).not.toContain('calculated_at');
    expect(allKeys).not.toContain('taxable_income_snapshot');
    expect(allKeys).not.toContain('insured_salary_labor_snapshot');
  });
});

function DEDUCT_LAST_IDX() { return 11; } // 12 項、0-indexed
