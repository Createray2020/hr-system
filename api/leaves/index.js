// api/leaves/index.js
//
// 本檔同時服務兩條路徑：
//   舊路徑（legacy）：employee-leave.html / dashboard.html / calendar.html / leave.html.old
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

import { supabase } from '../../lib/supabase.js';
import { requireRole } from '../../lib/auth.js';
import { sendPushToEmployees, createNotifications } from '../../lib/push.js';
import { submitLeaveRequest } from '../../lib/leave/request-flow.js';
import { getAnnualBalance } from '../../lib/leave/balance.js';
import { makeLeaveRepo } from './_repo.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

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
      const { data: leave, error } = await supabase
        .from('leave_requests').select('*').eq('id', id).single();
      if (error) return res.status(404).json({ error: '找不到假單' });
      const { data: emp } = await supabase
        .from('employees').select('name, dept, position, avatar')
        .eq('id', leave.employee_id).single();
      return res.status(200).json({
        ...leave,
        emp_name: emp?.name, dept: emp?.dept, position: emp?.position, avatar: emp?.avatar,
      });
    }

    if (req.query.stats === 'true') {
      const { data, error } = await supabase.from('leave_requests').select('status');
      if (error) return res.status(500).json({ error: error.message });
      const stats = { pending: 0, approved: 0, rejected: 0, total: data.length };
      data.forEach(r => { if (r.status in stats) stats[r.status]++; });
      return res.status(200).json(stats);
    }

    const { status, dept, type, search } = req.query;
    let q = supabase.from('leave_requests').select('*').order('applied_at', { ascending: false });
    if (status) q = q.eq('status',     status);
    if (type)   q = q.eq('leave_type', type);

    const { data: leaves, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    if (!leaves.length) return res.status(200).json([]);

    const empIds = [...new Set(leaves.map(l => l.employee_id))];
    const { data: emps, error: empErr } = await supabase
      .from('employees').select('id, name, dept, position, avatar').in('id', empIds);
    if (empErr) return res.status(500).json({ error: empErr.message });

    const empMap = Object.fromEntries(emps.map(e => [e.id, e]));
    let rows = leaves.map(l => {
      const e = empMap[l.employee_id] || {};
      return { ...l, emp_name: e.name, dept: e.dept, position: e.position, avatar: e.avatar };
    });
    if (dept)   rows = rows.filter(r => r.dept === dept);
    if (search) rows = rows.filter(r => (r.emp_name || '').includes(search));
    return res.status(200).json(rows);
  }

  // POST(legacy:start_date/end_date/days)
  if (req.method === 'POST') {
    const { employee_id, leave_type, start_date, end_date, days, reason, attachment_url, attachment_name } = req.body;
    if (!employee_id || !leave_type || !start_date || !end_date || !days)
      return res.status(400).json({ error: '缺少必填欄位' });
    const lid = 'L' + Date.now();
    const { error } = await supabase.from('leave_requests')
      .insert([{ id: lid, employee_id, leave_type, start_date, end_date, days, reason, status: 'pending',
                 attachment_url: attachment_url || null, attachment_name: attachment_name || null }]);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(201).json({ id: lid, message: '假單已建立' });
  }

  // PUT(legacy 審核)
  if (req.method === 'PUT') {
    if (!id) return res.status(400).json({ error: '缺少 id' });
    const caller = await requireRole(req, res, ['hr', 'admin'], { allowManager: true });
    if (!caller) return;
    const { status, handler_note } = req.body;
    if (!['approved', 'rejected'].includes(status))
      return res.status(400).json({ error: '無效的 status' });
    const { data: leave } = await supabase
      .from('leave_requests').select('employee_id, leave_type').eq('id', id).single();
    const { error } = await supabase.from('leave_requests')
      .update({ status, handler_note: handler_note || '', handled_at: new Date().toISOString() })
      .eq('id', id);
    if (error) return res.status(500).json({ error: error.message });
    if (leave?.employee_id) {
      const LEAVE_TYPES = { annual:'特休假', sick:'病假', personal:'事假', maternity:'產假', funeral:'喪假', marriage:'婚假' };
      const typeName = LEAVE_TYPES[leave.leave_type] || leave.leave_type;
      const _lp = {
        title: status === 'approved' ? '✅ 假單已核准' : '❌ 假單已退回',
        body:  `你的${typeName}申請${status === 'approved' ? '已核准' : '已被退回'}`,
        url:   '/employee-leave.html',
      };
      sendPushToEmployees([leave.employee_id], { ..._lp, tag: 'leave-' + id }).catch(() => {});
      createNotifications([leave.employee_id], { ..._lp, type: 'leave' }).catch(() => {});
    }
    return res.status(200).json({ message: '審核完成' });
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

  let q = supabase.from('leave_requests').select('*')
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
  const caller = await requireRole(req, res, ['hr', 'admin'], { allowManager: true });
  if (!caller) return;

  const { leave_type, start_at, end_at, reason } = req.body;
  // 員工自己申請;HR 代申請可在 body 傳 employee_id(管理者場景)
  const employee_id = req.body.employee_id || caller.id;
  if (!employee_id) return res.status(400).json({ error: 'employee_id required' });
  if (!leave_type || !start_at || !end_at) {
    return res.status(400).json({ error: 'leave_type / start_at / end_at required' });
  }

  try {
    const r = await submitLeaveRequest(makeLeaveRepo(), {
      employee_id, leave_type, start_at, end_at, reason,
    });
    if (!r.ok) return res.status(400).json(r);
    return res.status(201).json({ ok: true, request: r.request });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
