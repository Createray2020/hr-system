// api/salary-expense-entries/index.js
// GET  /api/salary-expense-entries?employee_id=X&year=Y&month=M   清單(管理頁顯示用)
// POST /api/salary-expense-entries                                HR 手動新增一筆(不經簽核)
//
// 寫入後一律呼叫 lib/salary/expense-cascade.js::reflectExpenseEntriesToSalary,
// 失敗(NEEDS_FORCE / NEEDS_EXECUTIVE / NO_SALARY_RECORD / PERIOD_LOCKED / throw)
// → 硬刪剛 insert 的 entry(補償式回滾、不留孤兒)+ 對應 HTTP code。
//
// 風格對齊 api/expense-categories/index.js + api/holidays/index.js。

import { requireRole } from '../../lib/auth.js';
import { BACKOFFICE_ROLES } from '../../lib/roles.js';
import { reflectExpenseEntriesToSalary } from '../../lib/salary/expense-cascade.js';
import { makeSalaryExpenseEntryRepo } from './_repo.js';

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

// 對應 reflect helper 的 { ok:false, reason } → HTTP code + 中文訊息
function mapReflectFailure(reason) {
  switch (reason) {
    case 'NEEDS_FORCE':
      return { status: 409, body: { error: '期間已核准,需 force 寫入', reason } };
    case 'NEEDS_EXECUTIVE':
      return { status: 403, body: { error: '需主管權限才能寫入已核准期間', reason } };
    case 'NO_SALARY_RECORD':
      return { status: 409, body: { error: '該期尚無薪資紀錄,無法外科寫入', reason } };
    case 'PERIOD_LOCKED':
      return { status: 409, body: { error: '期間已鎖定/已發放,請先解鎖', reason } };
    default:
      return { status: 500, body: { error: 'reflect 失敗', reason: reason || 'UNKNOWN' } };
  }
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') {
    const caller = await requireRole(req, res, BACKOFFICE_ROLES);
    if (!caller) return;
    const { employee_id, year, month } = req.query || {};
    if (!employee_id) return res.status(400).json({ error: 'employee_id required' });
    const y = parseInt(year), m = parseInt(month);
    if (!Number.isInteger(y) || y < 1900 || y > 2999) {
      return res.status(400).json({ error: 'invalid year' });
    }
    if (!Number.isInteger(m) || m < 1 || m > 12) {
      return res.status(400).json({ error: 'invalid month' });
    }
    const repo = makeSalaryExpenseEntryRepo();
    try {
      const entries = await repo.list({ employee_id, year: y, month: m });
      return res.status(200).json({ entries });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (req.method === 'POST') {
    const caller = await requireRole(req, res, BACKOFFICE_ROLES);
    if (!caller) return;

    const body = req.body || {};
    const employee_id  = body.employee_id;
    const target_year  = parseInt(body.target_year);
    const target_month = parseInt(body.target_month);
    const category_id  = body.category_id;
    const amountNum    = Number(body.amount);

    if (!employee_id) return res.status(400).json({ error: 'employee_id required' });
    if (!Number.isInteger(target_year) || target_year < 1900 || target_year > 2999) {
      return res.status(400).json({ error: 'invalid target_year' });
    }
    if (!Number.isInteger(target_month) || target_month < 1 || target_month > 12) {
      return res.status(400).json({ error: 'invalid target_month' });
    }
    if (!category_id) return res.status(400).json({ error: 'category_id required' });
    if (!Number.isFinite(amountNum) || amountNum <= 0) {
      return res.status(400).json({ error: 'amount must be positive' });
    }

    const repo = makeSalaryExpenseEntryRepo();
    let cat;
    try {
      cat = await repo.getCategoryById(category_id);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
    if (!cat || cat.is_active === false) {
      return res.status(400).json({ error: '類別不存在或已停用', category_id });
    }

    const nowIso = new Date().toISOString();
    const amount = round2(amountNum);

    // 對齊 cascade entryRow shape(L368-387):
    //   - id 同產生法 `SEE_${Date.now()}`
    //   - approval_request_id=null(手動非走簽核)、salary_record_id=null
    //   - settlement_mode='defer'、deferred_from=null
    //   - 類別三個 snapshot 從 expense_categories 寫入時取(日後改名/改稅性不回溯)
    const entryRow = {
      id: `SEE_${Date.now()}`,
      approval_request_id: null,
      employee_id,
      salary_record_id: null,
      target_year, target_month,
      category_id,
      category_name_snapshot: cat.name,
      is_wage_snapshot:    !!cat.is_wage,
      is_taxable_snapshot: !!cat.is_taxable,
      amount,
      expense_date: body.expense_date || null,
      description:  body.description  || null,
      settlement_mode: 'defer',
      deferred_from: null,
      status: 'active',
      note: body.note || `[手動新增 ${nowIso} by ${caller.id}]`,
      created_by: caller.id || null,
    };

    let created;
    try {
      created = await repo.insert(entryRow);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }

    // 反映到薪資;失敗則硬刪剛插入的 entry(補償式回滾)
    let reflectRes;
    try {
      reflectRes = await reflectExpenseEntriesToSalary({
        employee_id,
        year:  target_year,
        month: target_month,
        force: body.force === true,
        callerId:   caller.id || null,
        callerRole: caller.role || null,
        auditLabel: `[FORCE 併薪-手動新增 ${nowIso}] +${cat.name} NT$${amount}(HR:${caller.id})`,
      });
    } catch (e) {
      try { await repo.hardDelete(created.id); } catch (_) {}
      return res.status(500).json({ error: e.message });
    }

    if (!reflectRes.ok) {
      try { await repo.hardDelete(created.id); } catch (_) {}
      const m = mapReflectFailure(reflectRes.reason);
      return res.status(m.status).json(m.body);
    }

    return res.status(201).json({ entry: created, reflect: reflectRes.action });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
