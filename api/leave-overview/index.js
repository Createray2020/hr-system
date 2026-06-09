// api/leave-overview/index.js
// GET /api/leave-overview?year=YYYY&month=MM
//   → 撈該月區間重疊的 leave_requests + join leave_types,以員工分組 + 全月 summary
//
// 角色:BACKOFFICE_ROLES。唯讀(不寫 DB、不重算薪資、不動審核)。
//
// 月份重疊:start_date <= 月末 AND end_date >= 月初(對齊 calendar 範式)。

import { requireRole } from '../../lib/auth.js';
import { BACKOFFICE_ROLES } from '../../lib/roles.js';
import { applyExcludeSystemAccountsQuery } from '../../lib/salary/system-accounts.js';
import { makeLeaveOverviewRepo } from './_repo.js';
import { supabaseAdmin } from '../../lib/supabase.js';

// pay_rate 分類:full_paid=1 / half_paid=(0,1) / unpaid=0 / pending=null
function classifyPayRate(rate) {
  if (rate == null) return 'pending';
  const n = Number(rate);
  if (n === 1) return 'full_paid';
  if (n === 0) return 'unpaid';
  if (n > 0 && n < 1) return 'half_paid';
  return 'pending';   // 防呆:rate < 0 或 > 1 視為待設定
}

function num(v) { return v == null ? 0 : (Number(v) || 0); }

function monthBounds(year, month) {
  const y = parseInt(year, 10), m = parseInt(month, 10);
  if (!Number.isInteger(y) || !Number.isInteger(m) || m < 1 || m > 12) {
    return null;
  }
  const monthStart = `${y}-${String(m).padStart(2,'0')}-01`;
  // 最後一天:UTC 算
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const monthEnd = `${y}-${String(m).padStart(2,'0')}-${String(lastDay).padStart(2,'0')}`;
  return { year: y, month: m, monthStart, monthEnd };
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')     return res.status(405).json({ error: 'Method not allowed' });

  const caller = await requireRole(req, res, BACKOFFICE_ROLES);
  if (!caller) return;

  const bounds = monthBounds(req.query.year, req.query.month);
  if (!bounds) {
    return res.status(400).json({ error: 'year & month required (YYYY & 1-12)' });
  }

  const repo = makeLeaveOverviewRepo();
  try {
    const leaves = await repo.listForMonth(bounds);

    // 撈這批 employee_id 的員工資料(排除系統帳號)
    const empIds = [...new Set(leaves.map(l => l.employee_id).filter(Boolean))];
    let empMap = {};
    if (empIds.length) {
      // 直接走 supabase + applyExcludeSystemAccountsQuery,過濾 EMP_99999999
      const q = supabaseAdmin
        .from('employees')
        .select('id, name, dept_id, status, employment_type')
        .in('id', empIds);
      const { data: emps } = await applyExcludeSystemAccountsQuery(q);
      for (const e of emps || []) empMap[e.id] = e;
    }
    const realLeaves = leaves.filter(l => empMap[l.employee_id]);

    const departments = await repo.listDepartments();
    const deptMap = {};
    for (const d of departments) deptMap[d.id] = d.name;

    // rows + per-employee subtotal
    const rowsByEmp = new Map();   // employee_id → { name, dept_name, leaves: [], totals }

    for (const l of realLeaves) {
      const emp = empMap[l.employee_id];
      const lt  = l.leave_types || {};
      const pay = classifyPayRate(lt.pay_rate);
      const dayN = num(l.days), hrN = num(l.hours);

      if (!rowsByEmp.has(emp.id)) {
        rowsByEmp.set(emp.id, {
          employee_id: emp.id,
          name:        emp.name,
          dept_id:     emp.dept_id,
          dept_name:   deptMap[emp.dept_id] || null,
          employment_type: emp.employment_type,
          leaves: [],
          totals: {
            full_paid: { days: 0, hours: 0, count: 0 },
            half_paid: { days: 0, hours: 0, count: 0 },
            unpaid:    { days: 0, hours: 0, count: 0 },
            pending:   { days: 0, hours: 0, count: 0 },
            total:     { days: 0, hours: 0, count: 0 },
          },
        });
      }
      const bucket = rowsByEmp.get(emp.id);
      bucket.leaves.push({
        leave_request_id: l.id,
        leave_type:       l.leave_type,
        leave_type_name:  lt.name_zh || l.leave_type,
        pay_rate:         lt.pay_rate ?? null,
        is_paid:          lt.is_paid ?? null,
        has_balance:      lt.has_balance ?? false,
        pay_category:     pay,
        start_date:       l.start_date,
        end_date:         l.end_date,
        start_at:         l.start_at,
        end_at:           l.end_at,
        days:             l.days,
        hours:            l.hours,
        finalized_hours:  l.finalized_hours,
        status:           l.status,
        reason:           l.reason,
        admin_audit_note: l.admin_audit_note,
        created_at:       l.created_at,
      });
      bucket.totals[pay].days  += dayN;
      bucket.totals[pay].hours += hrN;
      bucket.totals[pay].count += 1;
      bucket.totals.total.days  += dayN;
      bucket.totals.total.hours += hrN;
      bucket.totals.total.count += 1;
    }

    const employees = [...rowsByEmp.values()];
    // 排序:依部門名(zh)、再 employee_id
    employees.sort((a, b) => {
      const da = a.dept_name || '￿', db = b.dept_name || '￿';
      const cmp = da.localeCompare(db, 'zh-Hant');
      if (cmp !== 0) return cmp;
      return String(a.employee_id).localeCompare(String(b.employee_id));
    });

    // 全月 summary
    const summary = {
      year:        bounds.year,
      month:       bounds.month,
      employees_count: employees.length,
      total_leaves:    realLeaves.length,
      by_category: {
        full_paid: { days: 0, hours: 0, count: 0 },
        half_paid: { days: 0, hours: 0, count: 0 },
        unpaid:    { days: 0, hours: 0, count: 0 },
        pending:   { days: 0, hours: 0, count: 0 },
      },
      total_days:  0,
      total_hours: 0,
    };
    for (const emp of employees) {
      for (const cat of ['full_paid','half_paid','unpaid','pending']) {
        summary.by_category[cat].days  += emp.totals[cat].days;
        summary.by_category[cat].hours += emp.totals[cat].hours;
        summary.by_category[cat].count += emp.totals[cat].count;
      }
      summary.total_days  += emp.totals.total.days;
      summary.total_hours += emp.totals.total.hours;
    }

    // 順便給前端 leave_types pickListfor edit modal
    const leaveTypes = await repo.listLeaveTypes();

    return res.status(200).json({
      year:  bounds.year,
      month: bounds.month,
      employees,
      summary,
      leave_types: leaveTypes,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
