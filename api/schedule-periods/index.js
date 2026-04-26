// api/schedule-periods/index.js
// GET  /api/schedule-periods?year=&month=&employee_id=  → 該年月該員工的 period + schedules
// POST /api/schedule-periods                            → 建立 draft 週期
//
// 對應設計文件：docs/attendance-system-design-v1.md §4.2.1
// 對應實作計畫：docs/attendance-system-implementation-plan-v1.md §5.8

import { supabase } from '../../lib/supabase.js';
import { requireRoleOrPass } from '../../lib/auth.js';

const ALLOWED_STATUSES = ['draft', 'submitted', 'approved', 'locked'];

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  const caller = await requireRoleOrPass(req, res, []);
  if (!caller) return;

  if (req.method === 'GET') return handleGet(req, res, caller);
  if (req.method === 'POST') return handlePost(req, res, caller);
  return res.status(405).json({ error: 'Method not allowed' });
}

async function handleGet(req, res, caller) {
  const { year, month, employee_id, status } = req.query;
  const y = year != null ? parseInt(year) : null;
  const m = month != null ? parseInt(month) : null;
  if (year != null && (!Number.isInteger(y) || y < 1900 || y > 2999)) {
    return res.status(400).json({ error: 'invalid year' });
  }
  if (month != null && (!Number.isInteger(m) || m < 1 || m > 12)) {
    return res.status(400).json({ error: 'invalid month' });
  }
  if (status && !ALLOWED_STATUSES.includes(status)) {
    return res.status(400).json({ error: 'invalid status' });
  }

  let q = supabase.from('schedule_periods').select('*').order('period_start', { ascending: true });
  if (y != null) q = q.eq('period_year', y);
  if (m != null) q = q.eq('period_month', m);
  if (employee_id) q = q.eq('employee_id', employee_id);
  if (status) q = q.eq('status', status);

  // 權限：員工只能看自己；主管/HR 看下屬或全部（dev mode 寬鬆）
  const callerRole = caller.role || '';
  const callerIsManagerOrHR = caller.is_manager === true || ['hr', 'admin'].includes(callerRole);
  if (!callerIsManagerOrHR && caller.id) {
    q = q.eq('employee_id', caller.id);
  }

  const { data: periods, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  if (!periods || periods.length === 0) return res.status(200).json({ periods: [], schedules: [] });

  // 一次撈所有相關 schedules
  const periodIds = periods.map(p => p.id);
  const { data: schedules, error: sErr } = await supabase
    .from('schedules').select('*').in('period_id', periodIds).order('work_date');
  if (sErr) return res.status(500).json({ error: sErr.message });

  return res.status(200).json({ periods, schedules: schedules || [] });
}

async function handlePost(req, res, caller) {
  const { year, month, employee_id } = req.body || {};
  const y = parseInt(year);
  const m = parseInt(month);
  if (!Number.isInteger(y) || y < 1900 || y > 2999) return res.status(400).json({ error: 'invalid year' });
  if (!Number.isInteger(m) || m < 1 || m > 12) return res.status(400).json({ error: 'invalid month' });

  // 員工自建 → employee_id 必須是自己；HR 代建 → 接受 body.employee_id
  const callerIsHR = ['hr', 'admin'].includes(caller.role || '');
  const targetEmpId = (callerIsHR && employee_id) ? employee_id : caller.id;
  if (!targetEmpId) return res.status(400).json({ error: 'employee_id required (caller has no id, must be HR providing target)' });

  const periodStart = `${y}-${String(m).padStart(2, '0')}-01`;
  const periodEnd   = lastDayOfMonth(y, m);
  const id = `s_period_${targetEmpId}_${y}_${String(m).padStart(2, '0')}`;

  const row = {
    id,
    employee_id: targetEmpId,
    period_year: y,
    period_month: m,
    period_start: periodStart,
    period_end: periodEnd,
    status: 'draft',
    start_date: periodStart, // legacy column 仍 NOT NULL（既有 schema）
    end_date:   periodEnd,
  };

  const { data, error } = await supabase
    .from('schedule_periods')
    .upsert([row], { onConflict: 'employee_id,period_year,period_month', ignoreDuplicates: true })
    .select()
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });

  // ignoreDuplicates → 已存在時 data 為 null，撈一次回給呼叫端
  if (!data) {
    const { data: existing } = await supabase
      .from('schedule_periods').select('*')
      .eq('employee_id', targetEmpId).eq('period_year', y).eq('period_month', m)
      .maybeSingle();
    return res.status(200).json({ period: existing, created: false });
  }
  return res.status(201).json({ period: data, created: true });
}

function lastDayOfMonth(y, m) {
  // m: 1-12; 用 Date(y, m, 0) 取上個月最後一天 = m 月最後一天
  const d = new Date(Date.UTC(y, m, 0));
  return d.toISOString().slice(0, 10);
}
