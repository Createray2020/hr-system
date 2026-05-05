// api/leaves/index.js
//
// 本檔同時服務兩條路徑：
//   舊路徑（legacy）：employee-leave.html / dashboard.html / calendar.html
//     - GET  ?id=X / ?stats=true / ?status=approved|pending / 清單(含 dept / type / search 篩選)
//     - POST body { employee_id, leave_type, start_date, end_date, days, reason, attachment_url }
//     - PUT  ?id=X body { status: 'approved'|'rejected', handler_note }
//   新路徑(Batch 5+):leave.html (新版) / leave-admin.html / annual-leave-admin.html
//     - GET ?employee_id&year[&month] → 列表
//     - GET ?annual_balance=true&employee_id → 取特休餘額
//     - POST body { start_at, end_at, leave_type, reason } → 走 lib/leave/request-flow.js
//
// 分流訊號:
//   POST: req.body.start_at 存在 → 新邏輯
//   GET:  req.query.annual_balance / (employee_id + year [+ month] 且無 ?id ?stats ?status) → 新邏輯
//
// 既有 vercel.json 的 /api/leaves/:id/review rewrite 已在本批移除。PUT/DELETE 個別 ID
// 走 file-system route → [id].js(規範新路徑)。Legacy PUT ?id=X 仍走本檔(分流保留)。
//
// 對應設計文件：docs/attendance-system-design-v1.md §4.3.2
// 對應實作計畫：docs/attendance-system-implementation-plan-v1.md §7.6
//
// Routing 假設:同 api/holidays/{[id].js, import.js, index.js} 與
// api/attendance/{[id].js, anomaly.js, index.js} precedent,Vercel 靜態檔名優先 dynamic route。

import { supabaseAdmin } from '../../lib/supabase.js';
import { requireAuth, requireRole } from '../../lib/auth.js';
import { BACKOFFICE_ROLES, canAccessBackoffice } from '../../lib/roles.js';
import { sendPushToEmployees, createNotifications } from '../../lib/push.js';
import { submitLeaveRequest } from '../../lib/leave/request-flow.js';
import { getAnnualBalance } from '../../lib/leave/balance.js';
import { makeLeaveRepo } from './_repo.js';
import { addDeptName, addDeptNameSingle } from '../../lib/dept-name-mapper.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── GET leave_types 清單（前端假別下拉用）──────────────────
  // 不需要登入身份；這只是 active leave types 的中繼資料。
  if (req.method === 'GET' && req.query._resource === 'leave_types') {
    // Phase 1.4: SELECT 補 advance_hours / advance_rule / requires_proof / proof_grace_days
    // 給 public/js/utils.js 的 advanceHintText / proofHintText / checkAdvanceClient 用。
    // 純加欄位、無 row-level filter / 業務邏輯改動。
    const { data, error } = await supabaseAdmin
      .from('leave_types')
      .select('code, name_zh, is_paid, has_balance, legal_max_days_per_year, display_order, description, advance_hours, advance_rule, requires_proof, proof_grace_days')
      .eq('is_active', true)
      .order('display_order');
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json(data || []);
  }

  // ── 新路徑:annual_balance ────────────────────────────────
  if (req.method === 'GET' && req.query.annual_balance === 'true') {
    return handleGetAnnualBalance(req, res);
  }

  // ── 新路徑:GET 列表(employee_id + year [+ month])──────
  if (req.method === 'GET' &&
      req.query.employee_id && req.query.year &&
      !req.query.id && !req.query.stats && !req.query.status) {
    return handleNewGet(req, res);
  }

  // ── 新路徑:POST(body 含 start_at)─────────────────────
  if (req.method === 'POST' && req.body && req.body.start_at) {
    return handleNewPost(req, res);
  }

  // ── 以下:legacy 邏輯整段搬自舊 api/leaves.js 不動 ────────
  const { id } = req.query;

  // GET
  if (req.method === 'GET') {
    if (id) {
      const { data: leave, error } = await supabaseAdmin
        .from('leave_requests').select('*').eq('id', id).single();
      if (error) return res.status(404).json({ error: '找不到假單' });
      const { data: emp } = await supabaseAdmin
        .from('employees').select('name, dept_id, position, avatar, departments(name)')
        .eq('id', leave.employee_id).single();
      addDeptNameSingle(emp);
      return res.status(200).json({
        ...leave,
        emp_name: emp?.name, dept_id: emp?.dept_id, dept_name: emp?.dept_name, position: emp?.position, avatar: emp?.avatar,
      });
    }

    if (req.query.stats === 'true') {
      const { data, error } = await supabaseAdmin.from('leave_requests').select('status');
      if (error) return res.status(500).json({ error: error.message });
      const stats = { pending: 0, approved: 0, rejected: 0, total: data.length };
      data.forEach(r => { if (r.status in stats) stats[r.status]++; });
      return res.status(200).json(stats);
    }

    const { status, dept, dept_id, type, search } = req.query;
    let q = supabaseAdmin.from('leave_requests').select('*').order('applied_at', { ascending: false });
    if (status) q = q.eq('status',     status);
    if (type)   q = q.eq('leave_type', type);

    // 員工只能看自己已核准/送審的假;主管/HR 看全公司(leave-admin 等頁面靠 dept_id 再篩)
    const caller = await requireAuth(req, res);
    if (!caller) return;
    if (!canAccessBackoffice(caller) && caller.id) q = q.eq('employee_id', caller.id);

    const { data: leaves, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    if (!leaves.length) return res.status(200).json([]);

    const empIds = [...new Set(leaves.map(l => l.employee_id))];
    const { data: emps, error: empErr } = await supabaseAdmin
      .from('employees').select('id, name, dept_id, position, avatar, departments(name)').in('id', empIds);
    if (empErr) return res.status(500).json({ error: empErr.message });
    addDeptName(emps);

    const empMap = Object.fromEntries(emps.map(e => [e.id, e]));
    let rows = leaves.map(l => {
      const e = empMap[l.employee_id] || {};
      return { ...l, emp_name: e.name, dept_id: e.dept_id, dept_name: e.dept_name, position: e.position, avatar: e.avatar };
    });
    if (dept_id)   rows = rows.filter(r => r.dept_id === dept_id);
    if (search) rows = rows.filter(r => (r.emp_name || '').includes(search));
    return res.status(200).json(rows);
  }

  // POST(legacy:start_date/end_date/days)
  if (req.method === 'POST') {
    const { employee_id, leave_type, start_date, end_date, days, reason, attachment_url, attachment_name } = req.body;
    if (!employee_id || !leave_type || !start_date || !end_date || !days)
      return res.status(400).json({ error: '缺少必填欄位' });
    const lid = 'L' + Date.now();
    const { error } = await supabaseAdmin.from('leave_requests')
      .insert([{ id: lid, employee_id, leave_type, start_date, end_date, days, reason, status: 'pending',
                 attachment_url: attachment_url || null, attachment_name: attachment_name || null }]);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(201).json({ id: lid, message: '假單已建立' });
  }

  // PUT(legacy 審核)— 已棄用。
  // 此路徑會直接 update status='approved' 但不重算時數、不扣餘額,造成
  // 薪資結算 / 全勤獎金 / 特休餘額計算缺資料。
  // 新路徑請走 PUT /api/leaves/:id body { decision: 'approve'|'reject' }
  // (走 lib/leave/request-flow.js 的 approveLeaveRequest)。
  if (req.method === 'PUT') {
    return res.status(410).json({
      error: 'GONE',
      message: 'legacy PUT /api/leaves?id=X 已棄用。請改用 PUT /api/leaves/:id body { decision }',
    });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

// ─────────────────────────────────────────────────────────────────
// 新路徑(Batch 5+):用 lib/leave/* + repo 注入
// ─────────────────────────────────────────────────────────────────

async function handleGetAnnualBalance(req, res) {
  const { employee_id } = req.query;
  if (!employee_id) return res.status(400).json({ error: 'employee_id required' });
  try {
    const balance = await getAnnualBalance(makeLeaveRepo(), employee_id);
    return res.status(200).json({ balance });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

async function handleNewGet(req, res) {
  const { employee_id, year, month } = req.query;
  const y = parseInt(year);
  if (!Number.isInteger(y)) return res.status(400).json({ error: 'invalid year' });

  let q = supabaseAdmin.from('leave_requests').select('*')
    .eq('employee_id', employee_id)
    .order('start_at', { ascending: false });

  // 用 start_at 範圍篩選(新欄位)
  const yearStart = `${y}-01-01T00:00:00+08:00`;
  const yearEnd   = `${y}-12-31T23:59:59+08:00`;
  q = q.gte('start_at', yearStart).lte('start_at', yearEnd);

  if (month) {
    const m = parseInt(month);
    if (Number.isInteger(m) && m >= 1 && m <= 12) {
      const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
      q = q.gte('start_at', `${y}-${String(m).padStart(2,'0')}-01T00:00:00+08:00`)
           .lte('start_at', `${y}-${String(m).padStart(2,'0')}-${lastDay}T23:59:59+08:00`);
    }
  }

  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ requests: data || [] });
}

async function handleNewPost(req, res) {
  // 員工自己提交假單(本人提自己的);HR/主管可代提別人的(管理者場景)
  const caller = await requireAuth(req, res);
  if (!caller) return;

  const {
    leave_type, start_at, end_at, reason,
    late_reason,                            // Phase 1.3a: soft late 時必填
    attachment_url, attachment_name,
  } = req.body;
  const target_employee_id = req.body.employee_id || caller.id;
  if (!target_employee_id) return res.status(400).json({ error: 'employee_id required' });

  // 代提權限檢查:若 target 不是 caller 本人,必須是 backoffice role 或 is_manager。
  if (target_employee_id !== caller.id) {
    const isBackoffice = ['hr','ceo','chairman','admin'].includes(caller.role);
    if (!isBackoffice && caller.is_manager !== true) {
      return res.status(403).json({ error: 'Forbidden: 只能提交自己的假單' });
    }
  }

  if (!leave_type || !start_at || !end_at) {
    return res.status(400).json({ error: 'leave_type / start_at / end_at required' });
  }

  try {
    const r = await submitLeaveRequest(makeLeaveRepo(), {
      employee_id: target_employee_id, leave_type, start_at, end_at, reason,
      late_reason,
      attachment_url, attachment_name,
    });
    // r.ok=false 時 r 已含 reason / advance_hours / gap_hours / requested_hours / remaining 等
    // 前端依 reason 決定 UX(ADVANCE_TIME_NOT_MET / LATE_REASON_REQUIRED / INSUFFICIENT_BALANCE 等)
    if (!r.ok) return res.status(400).json(r);
    return res.status(201).json({ ok: true, request: r.request });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
