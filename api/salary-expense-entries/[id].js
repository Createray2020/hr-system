// api/salary-expense-entries/[id].js
// PATCH  /api/salary-expense-entries/:id              HR 調整 amount / category / description / note
// DELETE /api/salary-expense-entries/:id[?force=true] HR 作廢(status='voided');force 給 approved 期間用
//
// 寫子表後一律呼叫 reflectExpenseEntriesToSalary;失敗 → 還原舊值(PATCH)/重設 active(DELETE)+ 對應 code。

import { requireRole } from '../../lib/auth.js';
import { BACKOFFICE_ROLES } from '../../lib/roles.js';
import { reflectExpenseEntriesToSalary } from '../../lib/salary/expense-cascade.js';
import { makeSalaryExpenseEntryRepo } from './_repo.js';

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

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

  const caller = await requireRole(req, res, BACKOFFICE_ROLES);
  if (!caller) return;

  const id = req.query.id;
  if (!id) return res.status(400).json({ error: 'id required' });

  const repo = makeSalaryExpenseEntryRepo();

  let existing;
  try {
    existing = await repo.getById(id);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
  if (!existing) return res.status(404).json({ error: 'entry not found' });

  if (req.method === 'PATCH') return handlePatch(req, res, { caller, repo, existing });
  if (req.method === 'DELETE') return handleDelete(req, res, { caller, repo, existing });
  return res.status(405).json({ error: 'Method not allowed' });
}

async function handlePatch(req, res, { caller, repo, existing }) {
  if (existing.status !== 'active') {
    return res.status(409).json({ error: '已作廢的明細不可調整', status: existing.status });
  }

  const body = req.body || {};
  const nowIso = new Date().toISOString();

  // 收集舊值快照(回滾用)
  const oldSnapshot = {
    amount: existing.amount,
    category_id: existing.category_id,
    category_name_snapshot: existing.category_name_snapshot,
    is_wage_snapshot: existing.is_wage_snapshot,
    is_taxable_snapshot: existing.is_taxable_snapshot,
    description: existing.description,
    note: existing.note,
    updated_at: existing.updated_at,
  };

  const patch = {};

  // 換類別 → 三個 snapshot 跟著更新
  if (body.category_id != null && body.category_id !== existing.category_id) {
    let cat;
    try {
      cat = await repo.getCategoryById(body.category_id);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
    if (!cat || cat.is_active === false) {
      return res.status(400).json({ error: '類別不存在或已停用', category_id: body.category_id });
    }
    patch.category_id          = cat.id;
    patch.category_name_snapshot = cat.name;
    patch.is_wage_snapshot     = !!cat.is_wage;
    patch.is_taxable_snapshot  = !!cat.is_taxable;
  }

  if (body.amount != null) {
    const amt = Number(body.amount);
    if (!Number.isFinite(amt) || amt <= 0) {
      return res.status(400).json({ error: 'amount must be positive' });
    }
    patch.amount = round2(amt);
  }

  if (body.description !== undefined) patch.description = body.description || null;

  // note 追加軌跡(若 body 帶 note 則覆寫,否則 append)
  if (body.note !== undefined) {
    patch.note = body.note || null;
  } else {
    const trail = `[調整 ${nowIso} by ${caller.id}]`;
    patch.note = `${existing.note || ''}\n${trail}`.trim();
  }

  if (Object.keys(patch).length === 1 && 'note' in patch && body.note === undefined) {
    // 只有自動 append 的 trail、沒實際變更 → 400(避免空 PATCH 亂跑 reflect)
    return res.status(400).json({ error: 'no actual changes' });
  }

  patch.updated_at = nowIso;

  let updated;
  try {
    updated = await repo.update(existing.id, patch);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }

  // reflect;失敗 → 還原
  let reflectRes;
  const auditLabel = `[FORCE 併薪-調整 ${nowIso}] ${existing.id}(HR:${caller.id})`;
  try {
    reflectRes = await reflectExpenseEntriesToSalary({
      employee_id: existing.employee_id,
      year:  existing.target_year,
      month: existing.target_month,
      force: body.force === true,
      callerId:   caller.id || null,
      callerRole: caller.role || null,
      auditLabel,
    });
  } catch (e) {
    try { await repo.update(existing.id, oldSnapshot); } catch (_) {}
    return res.status(500).json({ error: e.message });
  }

  if (!reflectRes.ok) {
    try { await repo.update(existing.id, oldSnapshot); } catch (_) {}
    const m = mapReflectFailure(reflectRes.reason);
    return res.status(m.status).json(m.body);
  }

  return res.status(200).json({ entry: updated, reflect: reflectRes.action });
}

async function handleDelete(req, res, { caller, repo, existing }) {
  // idempotent:已作廢直接回 200、不呼叫 reflect
  if (existing.status === 'voided') {
    return res.status(200).json({ entry: existing, reflect: 'noop' });
  }

  // 在 update 之前先拍 snapshot(若 repo getById 回 reference、後續 update mutate
  // 會讓 existing.note 變動,還原時拿到的就是已混入「[作廢]」的字串)
  const oldNote = existing.note;

  const nowIso = new Date().toISOString();
  const voidPatch = {
    status: 'voided',
    note: `${oldNote || ''}\n[作廢 ${nowIso} by ${caller.id}]`.trim(),
    updated_at: nowIso,
  };

  let updated;
  try {
    updated = await repo.update(existing.id, voidPatch);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }

  // reflect;失敗 → 還原 active
  let reflectRes;
  const force = req.query.force === 'true' || req.query.force === true;
  const auditLabel = `[FORCE 併薪-作廢 ${nowIso}] ${existing.id}(HR:${caller.id})`;
  try {
    reflectRes = await reflectExpenseEntriesToSalary({
      employee_id: existing.employee_id,
      year:  existing.target_year,
      month: existing.target_month,
      force,
      callerId:   caller.id || null,
      callerRole: caller.role || null,
      auditLabel,
    });
  } catch (e) {
    try {
      await repo.update(existing.id, {
        status: 'active',
        note: oldNote,
        updated_at: nowIso,
      });
    } catch (_) {}
    return res.status(500).json({ error: e.message });
  }

  if (!reflectRes.ok) {
    try {
      await repo.update(existing.id, {
        status: 'active',
        note: oldNote,
        updated_at: nowIso,
      });
    } catch (_) {}
    const m = mapReflectFailure(reflectRes.reason);
    return res.status(m.status).json(m.body);
  }

  return res.status(200).json({ entry: updated, reflect: reflectRes.action });
}
