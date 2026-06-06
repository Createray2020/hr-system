// api/schedule-periods/batch.js
// POST /api/schedule-periods/batch  → 主管/HR 一鍵幫部門整批建立當月 draft period
//
// 解決「多數員工無 period 導致套範本被跳過」的入口缺口。
// 設計同 api/schedule-periods/index.js handlePost(id 格式 / period_start/end /
// 法定 legacy start_date/end_date 寫法 / upsert idempotent),只把 target scope
// 從單員工換成「整個部門(或全公司)的 active 員工」。

import { supabaseAdmin } from '../../lib/supabase.js';
import { requireAuth } from '../../lib/auth.js';
import { isBackofficeRole, isExecutiveRole } from '../../lib/roles.js';
import { applyExcludeSystemAccountsQuery } from '../../lib/salary/system-accounts.js';

// 2026-06-06:executive(ceo/chairman/admin)排除在「被排班」之外。
// 撈員工 id 時補 role,組出集合後一律 isExecutiveRole 過濾掉再建 draft period。
// 不沿用 lib/auth-scope.js findActiveEmployeeIdsByDept(它只回 id、其他 endpoint 共用),
// 改本檔內 inline 撈含 role 的版本,executive filter 收斂在本檔內。
async function findSchedulableEmployeeIds(deptId) {
  let q = supabaseAdmin.from('employees').select('id, role').eq('status', 'active');
  q = applyExcludeSystemAccountsQuery(q);
  if (deptId) q = q.eq('dept_id', deptId);
  const { data, error } = await q;
  if (error) throw error;
  return (data || []).filter(e => !isExecutiveRole(e.role)).map(e => e.id);
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const caller = await requireAuth(req, res);
  if (!caller) return;

  const { year, month, dept_id } = req.body || {};
  const y = parseInt(year);
  const m = parseInt(month);
  if (!Number.isInteger(y) || y < 1900 || y > 2999 ||
      !Number.isInteger(m) || m < 1 || m > 12) {
    return res.status(400).json({ error: 'INVALID_PERIOD' });
  }

  // ─ 解析權限與目標員工 ─────────────────────────────────────
  let targetEmpIds;
  const callerIsHR = isBackofficeRole(caller);

  try {
    if (callerIsHR) {
      // HR 有 dept_id → 該部門 active;無 dept_id → 全公司 active
      targetEmpIds = await findSchedulableEmployeeIds(dept_id || null);
    } else if (caller.is_manager === true && caller.dept_id) {
      // 主管強鎖自己部門、忽略 body.dept_id
      targetEmpIds = await findSchedulableEmployeeIds(caller.dept_id);
    } else {
      return res.status(403).json({ error: 'NOT_MANAGER_OR_HR' });
    }
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }

  if (!targetEmpIds || targetEmpIds.length === 0) {
    return res.status(200).json({ created: [], skipped_existing: [], total: 0 });
  }

  // ─ 撈既有 period,扣掉避免重複 ────────────────────────────
  const { data: existing, error: exErr } = await supabaseAdmin
    .from('schedule_periods')
    .select('employee_id')
    .eq('period_year', y).eq('period_month', m)
    .in('employee_id', targetEmpIds);
  if (exErr) return res.status(500).json({ error: exErr.message });
  const existingIds = (existing || []).map(r => r.employee_id);
  const existingSet = new Set(existingIds);
  const toCreateIds = targetEmpIds.filter(id => !existingSet.has(id));

  if (toCreateIds.length === 0) {
    return res.status(200).json({
      created: [], skipped_existing: existingIds, total: targetEmpIds.length,
    });
  }

  // ─ 組 rows + 批次 upsert ────────────────────────────────
  const mm = String(m).padStart(2, '0');
  const periodStart = `${y}-${mm}-01`;
  const periodEnd = lastDayOfMonth(y, m);
  const rows = toCreateIds.map(empId => ({
    id: `s_period_${empId}_${y}_${mm}`,
    employee_id: empId,
    period_year: y,
    period_month: m,
    period_start: periodStart,
    period_end: periodEnd,
    status: 'draft',
    start_date: periodStart,  // legacy NOT NULL 欄位(對齊 index.js handlePost)
    end_date: periodEnd,
    created_by: caller.id,    // 既有單筆 endpoint 漏寫、batch 補上
  }));

  const { error: upErr } = await supabaseAdmin
    .from('schedule_periods')
    .upsert(rows, { onConflict: 'employee_id,period_year,period_month', ignoreDuplicates: true });
  if (upErr) return res.status(500).json({ error: upErr.message });

  return res.status(200).json({
    created: toCreateIds,
    skipped_existing: existingIds,
    total: targetEmpIds.length,
  });
}

function lastDayOfMonth(y, m) {
  // m: 1-12; 用 Date(y, m, 0) 取上個月最後一天 = m 月最後一天(對齊 index.js)
  const d = new Date(Date.UTC(y, m, 0));
  return d.toISOString().slice(0, 10);
}
