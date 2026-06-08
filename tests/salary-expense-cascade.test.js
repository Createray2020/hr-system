// tests/salary-expense-cascade.test.js
// Phase 4a:applyExpenseReimbursement cascade 覆蓋

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── 全域 stub state ──────────────────────────────────────────
const state = {
  // (year,month) → { id, status } 表 payroll_periods 現況
  periods: {},
  // (recordId) → salary_records row
  salaryRecords: {},
  // expense_categories by id / by name
  categoriesById: {},
  categoriesByName: {},
  // insurance_settings by employee_id
  insuranceByEmp: {},
  // capture
  insertedEntries: [],
  updatedSalaryRecords: [],
  updatedEntries: [],
  insertedPeriods: [],
  approvalAuditPrepended: [],
  calcCalls: [],
  // controls
  insertEntryError: null,                  // { code, message }
  insertEntrySecondCallError: null,        // 第二次 insert 的錯
  insertPeriodError: null,
  updateRecordError: null,
  calcThrow: false,
  // helpers
  _periodInsertCount: 0,
  _entryInsertCount: 0,
};

// ─── Mocks ────────────────────────────────────────────────────

vi.mock('../lib/supabase.js', () => {
  // table 操作:依 table 名分流
  function table(name) {
    let _filters = {};
    let _selectCols = '*';
    let _isOp = false;            // .is(col, null)
    const ctx = {
      _table: name,
      select: vi.fn(function (cols = '*') { _selectCols = cols; return this; }),
      eq: vi.fn(function (col, val) { _filters[col] = val; return this; }),
      is: vi.fn(function (col, val) { _filters[col + '__is'] = val; return this; }),
      maybeSingle: vi.fn(async function () {
        return doSelect(name, _filters, _selectCols, true);
      }),
      single: vi.fn(async function () {
        const r = await doSelect(name, _filters, _selectCols, true);
        return r;
      }),
      insert: vi.fn(async function (rows) {
        return doInsert(name, rows);
      }),
      update: vi.fn(function (patch) {
        ctx._updatePatch = patch;
        return ctx;
      }),
    };
    // update 是 chained,真正的執行在後續 .eq().eq() 解析後;為簡化,用 await ctx 模式
    ctx.then = function (resolve, reject) {
      // 用於 update 鏈:.update(patch).eq(...).eq(...).then(...)
      if (ctx._updatePatch != null) {
        return doUpdate(name, _filters, ctx._updatePatch).then(resolve, reject);
      }
      // fallback list select(await q):回空陣列
      return Promise.resolve({ data: [], error: null }).then(resolve, reject);
    };
    return ctx;
  }
  const client = { from: vi.fn((n) => table(n)) };
  return { supabase: client, supabaseAdmin: client };
});

function doSelect(table, filters, cols, single) {
  // payroll_periods
  if (table === 'payroll_periods') {
    if (filters.id) {
      const p = Object.values(state.periods).find(x => x.id === filters.id);
      return Promise.resolve({ data: p || null, error: null });
    }
    if (filters.year != null && filters.month != null) {
      const key = `${filters.year}_${filters.month}`;
      return Promise.resolve({ data: state.periods[key] || null, error: null });
    }
  }
  // salary_records
  if (table === 'salary_records') {
    if (filters.id) {
      return Promise.resolve({ data: state.salaryRecords[filters.id] || null, error: null });
    }
  }
  // expense_categories
  if (table === 'expense_categories') {
    if (filters.id) {
      return Promise.resolve({ data: state.categoriesById[filters.id] || null, error: null });
    }
    if (filters.name) {
      return Promise.resolve({ data: state.categoriesByName[filters.name] || null, error: null });
    }
  }
  // insurance_settings
  if (table === 'insurance_settings') {
    if (filters.employee_id) {
      return Promise.resolve({ data: state.insuranceByEmp[filters.employee_id] || null, error: null });
    }
  }
  // approval_requests(only used to read admin_audit_note)
  if (table === 'approval_requests') {
    if (filters.id) {
      return Promise.resolve({ data: { admin_audit_note: null }, error: null });
    }
  }
  return Promise.resolve({ data: null, error: null });
}

function doInsert(table, rows) {
  if (table === 'payroll_periods') {
    state._periodInsertCount += 1;
    if (state.insertPeriodError) {
      const e = state.insertPeriodError;
      state.insertPeriodError = null;
      return Promise.resolve({ data: null, error: e });
    }
    for (const r of rows) {
      state.periods[`${r.year}_${r.month}`] = { id: r.id, status: r.status };
      state.insertedPeriods.push(r);
    }
    return Promise.resolve({ data: rows[0], error: null });
  }
  if (table === 'salary_expense_entries') {
    state._entryInsertCount += 1;
    if (state._entryInsertCount === 1 && state.insertEntryError) {
      const e = state.insertEntryError;
      state.insertEntryError = null;
      return Promise.resolve({ data: null, error: e });
    }
    if (state._entryInsertCount === 2 && state.insertEntrySecondCallError) {
      const e = state.insertEntrySecondCallError;
      state.insertEntrySecondCallError = null;
      return Promise.resolve({ data: null, error: e });
    }
    for (const r of rows) state.insertedEntries.push(r);
    return Promise.resolve({ data: rows[0], error: null });
  }
  return Promise.resolve({ data: rows[0], error: null });
}

function doUpdate(table, filters, patch) {
  if (table === 'salary_records') {
    if (state.updateRecordError) {
      const e = state.updateRecordError;
      state.updateRecordError = null;
      return Promise.resolve({ data: null, error: e });
    }
    state.updatedSalaryRecords.push({ id: filters.id, patch });
    if (filters.id && state.salaryRecords[filters.id]) {
      Object.assign(state.salaryRecords[filters.id], patch);
    }
    return Promise.resolve({ data: null, error: null });
  }
  if (table === 'approval_requests') {
    if (patch?.admin_audit_note) state.approvalAuditPrepended.push(patch.admin_audit_note);
    return Promise.resolve({ data: null, error: null });
  }
  if (table === 'salary_expense_entries') {
    state.updatedEntries.push({ filters: { ...filters }, patch });
    return Promise.resolve({ data: null, error: null });
  }
  return Promise.resolve({ data: null, error: null });
}

// roles:真正用 isExecutiveRole 邏輯
vi.mock('../lib/roles.js', () => ({
  isExecutiveRole: vi.fn((role) => ['admin', 'chairman', 'ceo'].includes(role)),
}));

// tax-withholding:回固定值方便驗
vi.mock('../lib/salary/tax-withholding.js', () => ({
  calculateWithholding: vi.fn(({ monthlyPayment }) => Math.round(monthlyPayment * 0.06)),
  getWithholdingDefaults: vi.fn(() => ({ taxFreeAllowanceBase: 88500, taxFreeAllowancePerDep: 88500, rate: 0.06 })),
}));

// calculator:預設成功;可切 throw
const mockCalc = vi.fn(async (_repo, args) => {
  state.calcCalls.push(args);
  if (state.calcThrow) throw new Error('calc boom');
  return { record: { id: `S_${args.employee_id}_${args.year}_${String(args.month).padStart(2, '0')}` }, breakdown: {} };
});
vi.mock('../lib/salary/calculator.js', () => ({
  calculateMonthlySalary: mockCalc,
}));

// salary repo:mock 整個 factory(cascade 用 makeSalaryRepo())
vi.mock('../api/salary/_repo.js', () => ({
  makeSalaryRepo: vi.fn(() => ({ /* stub repo,只丟給 calculator,內容不重要 */ })),
}));

const {
  applyExpenseReimbursement,
  inferNextPayrollPeriod,
  isSettledStatus,
  isUnsettledStatus,
} = await import('../lib/salary/expense-cascade.js');

// ─── 共用 fixture helpers ─────────────────────────────────────

function setPeriod(year, month, status, id) {
  state.periods[`${year}_${month}`] = { id: id || `PP_${year}_${String(month).padStart(2,'0')}`, status };
}
function setSalaryRecord(employee_id, year, month, over = {}) {
  const id = `S_${employee_id}_${year}_${String(month).padStart(2,'0')}`;
  state.salaryRecords[id] = {
    id, employee_id, year, month, status: 'approved',
    taxable_income_snapshot: 50000,
    deduct_tax: 3000,
    deduct_tax_manual_override: false,
    expense_reimbursement_total: 0,
    expense_reimbursement_taxable: 0,
    expense_reimbursement_note: null,
    admin_audit_note: null,
    ...over,
  };
}

function makeRequest(over = {}) {
  return {
    id: 'APR_TEST_1',
    request_type: 'expense_reimbursement',
    applicant_id: 'EMP_X',
    completed_at: '2026-06-08T10:00:00.000Z',  // → 隔月 = 2026-07
    form_data: {
      expense_date: '2026-06-08',
      expense_category: '交通',
      amount: '1000',
      description: 'test',
    },
    ...over,
  };
}

beforeEach(() => {
  state.periods = {};
  state.salaryRecords = {};
  state.categoriesById = {};
  state.categoriesByName = {};
  state.insuranceByEmp = {};
  state.insertedEntries = [];
  state.updatedSalaryRecords = [];
  state.updatedEntries = [];
  state.insertedPeriods = [];
  state.approvalAuditPrepended = [];
  state.calcCalls = [];
  state.insertEntryError = null;
  state.insertEntrySecondCallError = null;
  state.insertPeriodError = null;
  state.updateRecordError = null;
  state.calcThrow = false;
  state._periodInsertCount = 0;
  state._entryInsertCount = 0;
  mockCalc.mockClear();
});

// ════════════════════════════════════════════════════════════
describe('inferNextPayrollPeriod / isSettledStatus / isUnsettledStatus', () => {
  it('一般月:2026-06-08 → 2026-07', () => {
    expect(inferNextPayrollPeriod('2026-06-08')).toEqual({ year: 2026, month: 7 });
  });
  it('12 月跨年:2026-12-15 → 2027-01', () => {
    expect(inferNextPayrollPeriod('2026-12-15')).toEqual({ year: 2027, month: 1 });
  });
  it('帶完整 ISO 也只取前 10 字', () => {
    expect(inferNextPayrollPeriod('2026-05-30T16:00:00.000Z')).toEqual({ year: 2026, month: 6 });
  });
  it('isSettledStatus / isUnsettledStatus 分桶', () => {
    expect(isSettledStatus('approved')).toBe(true);
    expect(isSettledStatus('paid')).toBe(true);
    expect(isSettledStatus('locked')).toBe(true);
    expect(isSettledStatus('draft')).toBe(false);
    expect(isUnsettledStatus('draft')).toBe(true);
    expect(isUnsettledStatus('calculating')).toBe(true);
    expect(isUnsettledStatus('pending_review')).toBe(true);
    expect(isUnsettledStatus('approved')).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════
describe('defer 進 draft 期間', () => {
  it('隔月 draft + 該員 unsettled salary_records → 寫 entry + 觸發 recompute', async () => {
    setPeriod(2026, 7, 'draft');
    setSalaryRecord('EMP_X', 2026, 7, { status: 'draft' });
    state.categoriesByName['交通'] = { id: 'EC1', name: '交通', is_wage: false, is_taxable: true };

    await applyExpenseReimbursement(makeRequest(), { id: 'HR1', role: 'hr' });

    expect(state.insertedEntries).toHaveLength(1);
    const e = state.insertedEntries[0];
    expect(e.target_year).toBe(2026);
    expect(e.target_month).toBe(7);
    expect(e.settlement_mode).toBe('defer');
    expect(e.deferred_from).toBeNull();
    expect(e.amount).toBe(1000);
    expect(e.is_taxable_snapshot).toBe(true);
    expect(e.category_id).toBe('EC1');
    expect(e.salary_record_id).toBe('S_EMP_X_2026_07');
    // recompute 被觸發
    expect(mockCalc).toHaveBeenCalledTimes(1);
    expect(state.calcCalls[0]).toMatchObject({ employee_id: 'EMP_X', year: 2026, month: 7 });
  });

  it('隔月 draft + 該員無 salary_records → 寫 entry、不觸發 recompute', async () => {
    setPeriod(2026, 7, 'draft');
    state.categoriesByName['交通'] = { id: 'EC1', name: '交通', is_wage: false, is_taxable: true };

    await applyExpenseReimbursement(makeRequest(), { id: 'HR1', role: 'hr' });

    expect(state.insertedEntries).toHaveLength(1);
    expect(state.insertedEntries[0].settlement_mode).toBe('defer');
    expect(mockCalc).not.toHaveBeenCalled();
  });

  it('隔月 period 不存在 → 自動建 draft + 寫 entry', async () => {
    // 不 setPeriod → getOrCreatePayrollPeriod 會 INSERT draft
    state.categoriesByName['交通'] = { id: 'EC1', name: '交通', is_wage: false, is_taxable: true };

    await applyExpenseReimbursement(makeRequest(), { id: 'HR1', role: 'hr' });

    expect(state.insertedPeriods.some(p => p.id === 'PP_2026_07' && p.status === 'draft')).toBe(true);
    expect(state.insertedEntries).toHaveLength(1);
    expect(state.insertedEntries[0].settlement_mode).toBe('defer');
  });
});

// ════════════════════════════════════════════════════════════
describe('隔月已結算 + mode=defer → 往後滾', () => {
  it('隔月 approved + mode=defer → 滾到下一個未結算、deferred_from=原月', async () => {
    setPeriod(2026, 7, 'approved');
    setPeriod(2026, 8, 'paid');
    setPeriod(2026, 9, 'draft');           // 第一個 unsettled
    state.categoriesByName['交通'] = { id: 'EC1', name: '交通', is_wage: false, is_taxable: true };

    await applyExpenseReimbursement(makeRequest(), { id: 'HR1', role: 'hr' });

    const e = state.insertedEntries[0];
    expect(e.target_year).toBe(2026);
    expect(e.target_month).toBe(9);
    expect(e.settlement_mode).toBe('defer');
    expect(e.deferred_from).toBe('2026-07');
    expect(e.note).toMatch(/遞延自 2026-07/);
  });

  it('隔月 paid + mode=force + executive → 仍退回遞延(force 只適用 approved)', async () => {
    setPeriod(2026, 7, 'paid');
    setPeriod(2026, 8, 'draft');
    state.categoriesByName['交通'] = { id: 'EC1', name: '交通', is_wage: false, is_taxable: true };

    await applyExpenseReimbursement(makeRequest(), { id: 'CEO1', role: 'ceo' }, 'force');

    const e = state.insertedEntries[0];
    expect(e.target_month).toBe(8);
    expect(e.settlement_mode).toBe('defer');
    expect(e.deferred_from).toBe('2026-07');
    expect(e.note).toMatch(/force 不適用 status=paid/);
    expect(state.updatedSalaryRecords).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════
describe('mode=force(approved + executive)外科 UPDATE', () => {
  it('外科 UPDATE 4 欄 + taxable_income_snapshot + deduct_tax + [FORCE] audit、不呼叫 calculator', async () => {
    setPeriod(2026, 7, 'approved');
    setSalaryRecord('EMP_X', 2026, 7, {
      status: 'approved',
      taxable_income_snapshot: 50000,
      deduct_tax: 3000,
      deduct_tax_manual_override: false,
      expense_reimbursement_total: 200,
      expense_reimbursement_taxable: 100,
      expense_reimbursement_note: '舊一筆 NT$200',
    });
    state.categoriesByName['交通'] = { id: 'EC1', name: '交通', is_wage: false, is_taxable: true };
    state.insuranceByEmp['EMP_X'] = { health_ins_dependents: 1, has_insurance: true };

    await applyExpenseReimbursement(makeRequest(), { id: 'CEO1', role: 'ceo' }, 'force');

    const e = state.insertedEntries[0];
    expect(e.settlement_mode).toBe('force');
    expect(e.deferred_from).toBeNull();
    expect(mockCalc).not.toHaveBeenCalled();

    expect(state.updatedSalaryRecords).toHaveLength(1);
    const upd = state.updatedSalaryRecords[0];
    expect(upd.id).toBe('S_EMP_X_2026_07');
    expect(upd.patch.expense_reimbursement_total).toBe(1200);   // 200+1000
    expect(upd.patch.expense_reimbursement_taxable).toBe(1100); // 100+1000
    expect(upd.patch.expense_reimbursement_note).toContain('舊一筆 NT$200');
    expect(upd.patch.expense_reimbursement_note).toContain('交通 NT$1000');
    expect(upd.patch.taxable_income_snapshot).toBe(51000);      // 50000+1000
    expect(upd.patch.deduct_tax).toBe(Math.round(51000 * 0.06));// mock = monthlyPayment*0.06
    expect(upd.patch.admin_audit_note).toMatch(/^\[FORCE 併薪 /);
    expect(upd.patch.admin_audit_note).toContain('交通 NT$1000');
    expect(upd.patch.admin_audit_note).toContain('APR_TEST_1');
  });

  it('mode=force + 非 executive → 退回遞延(force 被忽略)', async () => {
    setPeriod(2026, 7, 'approved');
    setPeriod(2026, 8, 'draft');
    setSalaryRecord('EMP_X', 2026, 7, { status: 'approved' });
    state.categoriesByName['交通'] = { id: 'EC1', name: '交通', is_wage: false, is_taxable: true };

    await applyExpenseReimbursement(makeRequest(), { id: 'HR1', role: 'hr' }, 'force');

    expect(state.insertedEntries[0].settlement_mode).toBe('defer');
    expect(state.insertedEntries[0].target_month).toBe(8);
    expect(state.insertedEntries[0].note).toMatch(/force 被忽略\(caller=hr/);
    expect(state.updatedSalaryRecords).toHaveLength(0);
  });

  it('deduct_tax_manual_override=true → 不動 deduct_tax、只動 taxable + expense 欄', async () => {
    setPeriod(2026, 7, 'approved');
    setSalaryRecord('EMP_X', 2026, 7, {
      status: 'approved',
      taxable_income_snapshot: 60000,
      deduct_tax: 4500,
      deduct_tax_manual_override: true,
      expense_reimbursement_total: 0,
      expense_reimbursement_taxable: 0,
    });
    state.categoriesByName['交通'] = { id: 'EC1', name: '交通', is_wage: false, is_taxable: true };

    await applyExpenseReimbursement(makeRequest(), { id: 'CEO1', role: 'ceo' }, 'force');

    const upd = state.updatedSalaryRecords[0];
    expect(upd.patch.expense_reimbursement_total).toBe(1000);
    expect(upd.patch.expense_reimbursement_taxable).toBe(1000);
    expect(upd.patch.taxable_income_snapshot).toBe(61000);
    expect(upd.patch).not.toHaveProperty('deduct_tax');         // 沒動
  });

  it('非稅類別 force → expense_taxable 不增 / taxable_snapshot 不變 / deduct_tax 不變(deltaTaxable=0 跳過)', async () => {
    setPeriod(2026, 7, 'approved');
    setSalaryRecord('EMP_X', 2026, 7, {
      status: 'approved',
      taxable_income_snapshot: 50000,
      deduct_tax: 3000,
      expense_reimbursement_total: 0,
      expense_reimbursement_taxable: 0,
    });
    state.categoriesByName['零用金代墊'] = { id: 'EC2', name: '零用金代墊', is_wage: false, is_taxable: false };

    const req = makeRequest({
      form_data: { amount: '500', expense_category: '零用金代墊' },
    });
    await applyExpenseReimbursement(req, { id: 'CEO1', role: 'ceo' }, 'force');

    const upd = state.updatedSalaryRecords[0];
    expect(upd.patch.expense_reimbursement_total).toBe(500);
    expect(upd.patch.expense_reimbursement_taxable).toBe(0);
    expect(upd.patch.taxable_income_snapshot).toBe(50000);   // 沒動(deltaTaxable=0)
    expect(upd.patch).not.toHaveProperty('deduct_tax');      // deltaTaxable=0 → 跳過
  });

  it('force 目標無 salary_records → 退回 defer、UPDATE entry 改 mode=defer', async () => {
    setPeriod(2026, 7, 'approved');
    // 不 setSalaryRecord('EMP_X', 2026, 7) → sr=null
    state.categoriesByName['交通'] = { id: 'EC1', name: '交通', is_wage: false, is_taxable: true };

    await applyExpenseReimbursement(makeRequest(), { id: 'CEO1', role: 'ceo' }, 'force');

    // 先 insert force entry
    expect(state.insertedEntries[0].settlement_mode).toBe('force');
    // 然後 UPDATE 改 defer
    const updEntry = state.updatedEntries.find(u => u.patch?.settlement_mode === 'defer');
    expect(updEntry).toBeDefined();
    expect(updEntry.patch.deferred_from).toBe('2026-07');
    expect(updEntry.patch.note).toMatch(/force 退回/);
    expect(state.approvalAuditPrepended.some(s => /force 退回/.test(s))).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════
describe('類別解析', () => {
  it('by id → 優先用 expense_category_id', async () => {
    setPeriod(2026, 7, 'draft');
    state.categoriesById['EC_FOO'] = { id: 'EC_FOO', name: '指定類別', is_wage: true, is_taxable: false };
    state.categoriesByName['交通']  = { id: 'EC_BAR', name: '交通',     is_wage: false, is_taxable: true };

    const req = makeRequest({
      form_data: { amount: '500', expense_category_id: 'EC_FOO', expense_category: '交通' },
    });
    await applyExpenseReimbursement(req, { id: 'HR1', role: 'hr' });

    const e = state.insertedEntries[0];
    expect(e.category_id).toBe('EC_FOO');
    expect(e.category_name_snapshot).toBe('指定類別');
    expect(e.is_wage_snapshot).toBe(true);
    expect(e.is_taxable_snapshot).toBe(false);
  });

  it('by name → 找得到、用之', async () => {
    setPeriod(2026, 7, 'draft');
    state.categoriesByName['交通'] = { id: 'EC1', name: '交通', is_wage: false, is_taxable: true };

    await applyExpenseReimbursement(makeRequest(), { id: 'HR1', role: 'hr' });

    const e = state.insertedEntries[0];
    expect(e.category_id).toBe('EC1');
    expect(e.is_taxable_snapshot).toBe(true);
  });

  it('無匹配 → 保守預設 is_taxable=true、is_wage=false、note 標 defaulted', async () => {
    setPeriod(2026, 7, 'draft');
    // 不 set categories → 都查不到

    await applyExpenseReimbursement(makeRequest(), { id: 'HR1', role: 'hr' });

    const e = state.insertedEntries[0];
    expect(e.category_id).toBeNull();
    expect(e.is_taxable_snapshot).toBe(true);
    expect(e.is_wage_snapshot).toBe(false);
    expect(e.category_name_snapshot).toBe('交通');
    expect(e.note).toMatch(/類別預設\(無匹配/);
  });
});

// ════════════════════════════════════════════════════════════
describe('amount 處理', () => {
  it('amount 字串 → cast 成數字', async () => {
    setPeriod(2026, 7, 'draft');
    state.categoriesByName['交通'] = { id: 'EC1', name: '交通', is_wage: false, is_taxable: true };

    await applyExpenseReimbursement(makeRequest(), { id: 'HR1', role: 'hr' });

    expect(state.insertedEntries[0].amount).toBe(1000);
    expect(typeof state.insertedEntries[0].amount).toBe('number');
  });

  it('amount<=0 → skip、no insert / no update', async () => {
    setPeriod(2026, 7, 'draft');
    const req = makeRequest({ form_data: { amount: '0', expense_category: '交通' } });
    await applyExpenseReimbursement(req, { id: 'HR1', role: 'hr' });

    expect(state.insertedEntries).toHaveLength(0);
    expect(state.updatedSalaryRecords).toHaveLength(0);
    expect(mockCalc).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════
describe('冪等 + best-effort', () => {
  it('uq_see_approval_active(23505)→ skip、不重複入帳、不 throw', async () => {
    setPeriod(2026, 7, 'draft');
    state.categoriesByName['交通'] = { id: 'EC1', name: '交通', is_wage: false, is_taxable: true };
    state.insertEntryError = { code: '23505', message: 'duplicate key' };

    // 不應 throw
    await applyExpenseReimbursement(makeRequest(), { id: 'HR1', role: 'hr' });
    expect(state.insertedEntries).toHaveLength(0);  // insert 被擋
    expect(mockCalc).not.toHaveBeenCalled();        // 短路 return,不 recompute
  });

  it('recompute 拋錯 → cascade 不 throw + audit prepend 留紀錄', async () => {
    setPeriod(2026, 7, 'draft');
    setSalaryRecord('EMP_X', 2026, 7, { status: 'draft' });
    state.categoriesByName['交通'] = { id: 'EC1', name: '交通', is_wage: false, is_taxable: true };
    state.calcThrow = true;

    await expect(applyExpenseReimbursement(makeRequest(), { id: 'HR1', role: 'hr' })).resolves.toBeUndefined();
    expect(state.insertedEntries).toHaveLength(1);  // entry 仍寫入
    expect(state.approvalAuditPrepended.some(s => /recompute 失敗/.test(s))).toBe(true);
  });

  it('完全外層拋錯(non-23505 insert)→ cascade 不 throw、寫 audit', async () => {
    setPeriod(2026, 7, 'draft');
    state.categoriesByName['交通'] = { id: 'EC1', name: '交通', is_wage: false, is_taxable: true };
    state.insertEntryError = { code: 'XX000', message: '怪錯' };

    await expect(applyExpenseReimbursement(makeRequest(), { id: 'HR1', role: 'hr' })).resolves.toBeUndefined();
    expect(state.approvalAuditPrepended.some(s => /併薪失敗/.test(s))).toBe(true);
  });
});
