// tests/api-salary-admin-edit.test.js — P6.1:salary_records admin_edit + period lock + audit
//
// 對 api/salary/[id].js PUT handler 覆蓋:
//   SE1  numeric 欄位(bonus)→ 200 + audit 列 `bonus 5000→6000`
//   SE2  text 欄位(note)→ 200 + audit 列 `note updated`(不列 value、避免過長)
//   SE3  bool 欄位(deduct_tax_manual_override)→ 200 + audit 列 false→true
//   SE4  多欄位混合(numeric + text + bool)→ audit 列三類正確 format
//   SE5  period.status='locked' + 無 ?force → 403 PERIOD_LOCKED
//   SE6  period.status='locked' + ?force=true → 200 + audit 含 [FORCE]
//   SE7  period.status='paid'(非 locked)+ 無 ?force → 200(只 locked 才 block)
//   SE8  無實際變化(callerPatch 全跟 existing 相同)→ 400 no actual changes
//   SE9  黑名單欄位(gross_salary)→ 過濾後空 → 400 no allowed fields
//   SE10 row 不存在 → 404
//   SE11 existing.admin_audit_note 已有 → 新 line 在頂 + '\n' 分隔
//   SE12 action=confirm + locked + 無 force → 403 PERIOD_LOCKED
//   SE13 caller role='employee' → 403 (requireRole 擋)
//
// Mock 策略(對齊 tests/api-salary-periods.test.js):
//   supabase chain by table、dataByQuery['table:maybeSingle'] 控 SELECT、calls.updates 攔 UPDATE
//   auth.requireRole 真實 check role list

import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls = { tables: [], updates: [] };
const dataByQuery = {};
const overrides = { caller: null };

vi.mock('../lib/supabase.js', () => {
  function chain(table) {
    const c = {};
    c.select = vi.fn(() => c);
    c.eq = vi.fn(() => c);
    c.update = vi.fn((patch) => { calls.updates.push({ table, patch }); return c; });
    c.maybeSingle = vi.fn(() => Promise.resolve({
      data: dataByQuery[`${table}:maybeSingle`] ?? null, error: null,
    }));
    c.single = vi.fn(() => Promise.resolve({ data: null, error: null }));
    return c;
  }
  const client = { from: vi.fn((table) => { calls.tables.push(table); return chain(table); }) };
  return { supabase: client, supabaseAdmin: client };
});

vi.mock('../lib/auth.js', () => ({
  requireRole: vi.fn(async (req, res, allowedRoles, opts = {}) => {
    if (!overrides.caller) { res.status(401).json({ error: 'Unauthorized' }); return null; }
    const allowManager = opts.allowManager === true;
    const passByRole = allowedRoles.includes(overrides.caller.role);
    const passByManager = allowManager && overrides.caller.is_manager === true;
    if (!passByRole && !passByManager) {
      res.status(403).json({ error: 'Forbidden: insufficient role' });
      return null;
    }
    return overrides.caller;
  }),
}));

const { default: handler } = await import('../api/salary/[id].js');

function makeReqRes({ method = 'PUT', query = { id: 'SR1' }, body = {} } = {}) {
  const res = {
    statusCode: 200, body: undefined,
    status(c) { this.statusCode = c; return this; },
    json(p)   { this.body = p; return this; },
    end()     { return this; },
  };
  return [{ method, query, body, headers: {} }, res];
}

beforeEach(() => {
  calls.tables = []; calls.updates = [];
  for (const k of Object.keys(dataByQuery)) delete dataByQuery[k];
  overrides.caller = { id: 'HR1', role: 'hr', is_manager: false };
});

function setExisting(over = {}) {
  dataByQuery['salary_records:maybeSingle'] = {
    id: 'SR1', employee_id: 'E1', year: 2026, month: 4,
    status: 'draft',
    overtime_pay: 0, bonus: 5000, allowance: 0, extra_allowance: 0,
    deduct_absence: 0, deduct_labor_ins: 0, deduct_health_ins: 0, deduct_tax: 0,
    deduct_tax_manual_override: false,
    note: 'orig note', overtime_pay_note: '', settlement_note: '',
    admin_audit_note: null,
    ...over,
  };
}

function setPeriod(status) {
  dataByQuery['payroll_periods:maybeSingle'] = { status };
}

// ════════════════════════════════════════════════════════════
describe('PUT /api/salary/:id — P6.1 admin_edit + period lock + audit', () => {

  it('SE1: 改 bonus(numeric)→ 200 + audit 列 bonus 5000→6000', async () => {
    setExisting({ bonus: 5000 });
    setPeriod('draft');
    const [req, res] = makeReqRes({ body: { bonus: 6000 } });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    const upd = calls.updates.find(u => u.table === 'salary_records');
    expect(upd.patch.bonus).toBe(6000);
    expect(upd.patch.admin_audit_note).toMatch(/admin_edit by HR1: bonus 5000→6000/);
    expect(upd.patch.admin_audit_note).not.toMatch(/\[FORCE\]/);
  });

  it('SE2: 改 note(text)→ audit 列 `note updated`(不列 value)', async () => {
    setExisting({ note: 'old' });
    setPeriod('draft');
    const [req, res] = makeReqRes({ body: { note: 'new' } });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    const upd = calls.updates[0];
    expect(upd.patch.note).toBe('new');
    expect(upd.patch.admin_audit_note).toMatch(/note updated/);
    expect(upd.patch.admin_audit_note).not.toMatch(/note old→/);
  });

  it('SE3: 改 deduct_tax_manual_override(bool)→ audit 列 false→true', async () => {
    setExisting({ deduct_tax_manual_override: false });
    setPeriod('draft');
    const [req, res] = makeReqRes({ body: { deduct_tax_manual_override: true } });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    const upd = calls.updates[0];
    expect(upd.patch.deduct_tax_manual_override).toBe(true);
    expect(upd.patch.admin_audit_note).toMatch(/deduct_tax_manual_override false→true/);
  });

  it('SE4: 多欄位混合(bonus + note + bool)→ audit 列三類', async () => {
    setExisting({ bonus: 5000, note: 'old', deduct_tax_manual_override: false });
    setPeriod('draft');
    const [req, res] = makeReqRes({ body: {
      bonus: 8000, note: 'new note', deduct_tax_manual_override: true,
    }});
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    const upd = calls.updates[0];
    expect(upd.patch.admin_audit_note).toMatch(/bonus 5000→8000/);
    expect(upd.patch.admin_audit_note).toMatch(/note updated/);
    expect(upd.patch.admin_audit_note).toMatch(/deduct_tax_manual_override false→true/);
  });

  it('SE5: period.status=locked + 無 ?force → 403 PERIOD_LOCKED', async () => {
    setExisting();
    setPeriod('locked');
    const [req, res] = makeReqRes({ body: { bonus: 7000 } });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toBe('PERIOD_LOCKED');
    expect(calls.updates.find(u => u.table === 'salary_records')).toBeUndefined();
  });

  it('SE6: period.status=locked + ?force=true → 200 + audit 含 [FORCE]', async () => {
    setExisting({ bonus: 5000 });
    setPeriod('locked');
    const [req, res] = makeReqRes({
      query: { id: 'SR1', force: 'true' }, body: { bonus: 7000 },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    const upd = calls.updates[0];
    expect(upd.patch.bonus).toBe(7000);
    expect(upd.patch.admin_audit_note).toMatch(/admin_edit \[FORCE\] by HR1:/);
  });

  it('SE7: period.status=paid(非 locked)+ 無 ?force → 200(只 locked 才 block)', async () => {
    setExisting({ bonus: 5000 });
    setPeriod('paid');
    const [req, res] = makeReqRes({ body: { bonus: 6000 } });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    const upd = calls.updates[0];
    expect(upd.patch.bonus).toBe(6000);
  });

  it('SE8: 無實際變化(送的值跟 existing 全相同)→ 400 no actual changes', async () => {
    setExisting({ bonus: 5000, note: 'orig note' });
    setPeriod('draft');
    const [req, res] = makeReqRes({ body: { bonus: 5000, note: 'orig note' } });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('no actual changes');
    expect(calls.updates.find(u => u.table === 'salary_records')).toBeUndefined();
  });

  it('SE9: 黑名單欄位(gross_salary)→ 過濾後空 → 400 no allowed fields', async () => {
    setExisting();
    setPeriod('draft');
    const [req, res] = makeReqRes({ body: { gross_salary: 99999 } });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('no allowed fields to update');
    expect(calls.updates.find(u => u.table === 'salary_records')).toBeUndefined();
  });

  it('SE10: row 不存在 → 404', async () => {
    // dataByQuery['salary_records:maybeSingle'] 不 set → null
    setPeriod('draft');
    const [req, res] = makeReqRes({ body: { bonus: 1 } });
    await handler(req, res);
    expect(res.statusCode).toBe(404);
    expect(calls.updates.find(u => u.table === 'salary_records')).toBeUndefined();
  });

  it('SE11: existing.admin_audit_note 已有 → 新 line 在頂 + \\n 分隔', async () => {
    setExisting({
      bonus: 5000,
      admin_audit_note: '[2026-04-15] admin_edit by HR1: bonus 3000→5000',
    });
    setPeriod('draft');
    const [req, res] = makeReqRes({ body: { bonus: 7000 } });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    const upd = calls.updates[0];
    const lines = upd.patch.admin_audit_note.split('\n');
    expect(lines[0]).toMatch(/admin_edit by HR1: bonus 5000→7000/);
    expect(lines[1]).toMatch(/admin_edit by HR1: bonus 3000→5000/);
  });

  it('SE12: action=confirm + locked + 無 force → 403 PERIOD_LOCKED', async () => {
    setExisting();
    setPeriod('locked');
    const [req, res] = makeReqRes({
      query: { id: 'SR1', action: 'confirm' }, body: {},
    });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toBe('PERIOD_LOCKED');
    expect(calls.updates.find(u => u.table === 'salary_records')).toBeUndefined();
  });

  it('SE13: caller role=employee → 403(requireRole 擋)', async () => {
    overrides.caller = { id: 'E1', role: 'employee', is_manager: false };
    setExisting();
    setPeriod('draft');
    const [req, res] = makeReqRes({ body: { bonus: 1 } });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
    expect(calls.updates.find(u => u.table === 'salary_records')).toBeUndefined();
  });
});
