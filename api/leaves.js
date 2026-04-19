// api/leaves.js — 請假單（合併自 leave.js + leaves.js）
// GET  /api/leaves              → 清單（含統計 ?stats=true）
// GET  /api/leaves?id=XXX       → 單筆詳情
// POST /api/leaves              → 新增假單
// PUT  /api/leaves?id=XXX       → 審核假單（manager/hr/admin）
import { supabase } from '../lib/supabase.js';
import { requireRole } from '../lib/auth.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { id } = req.query;

  // ── GET ────────────────────────────────────────────────────────────────────
  if (req.method === 'GET') {

    // 單筆詳情（原 leave.js GET）
    if (id) {
      const { data: leave, error } = await supabase
        .from('leave_requests').select('*').eq('id', id).single();
      if (error) return res.status(404).json({ error: '找不到假單' });

      const { data: emp } = await supabase
        .from('employees').select('name, dept, position, avatar')
        .eq('id', leave.employee_id).single();

      return res.status(200).json({
        ...leave,
        emp_name: emp?.name,
        dept:     emp?.dept,
        position: emp?.position,
        avatar:   emp?.avatar,
      });
    }

    // 統計（?stats=true）
    if (req.query.stats === 'true') {
      const { data, error } = await supabase.from('leave_requests').select('status');
      if (error) return res.status(500).json({ error: error.message });
      const stats = { pending: 0, approved: 0, rejected: 0, total: data.length };
      data.forEach(r => { if (r.status in stats) stats[r.status]++; });
      return res.status(200).json(stats);
    }

    // 清單
    const { status, dept, type, search } = req.query;
    let q = supabase.from('leave_requests')
      .select('*').order('applied_at', { ascending: false });
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

  // ── POST: 新增假單 ─────────────────────────────────────────────────────────
  if (req.method === 'POST') {
    const { employee_id, leave_type, start_date, end_date, days, reason } = req.body;
    if (!employee_id || !leave_type || !start_date || !end_date || !days)
      return res.status(400).json({ error: '缺少必填欄位' });
    const lid = 'L' + Date.now();
    const { error } = await supabase.from('leave_requests')
      .insert([{ id: lid, employee_id, leave_type, start_date, end_date, days, reason, status: 'pending' }]);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(201).json({ id: lid, message: '假單已建立' });
  }

  // ── PUT: 審核假單（原 leave.js PUT）────────────────────────────────────────
  if (req.method === 'PUT') {
    if (!id) return res.status(400).json({ error: '缺少 id' });
    const caller = await requireRole(req, res, ['hr', 'admin', 'manager']);
    if (!caller) return;
    const { status, handler_note } = req.body;
    if (!['approved', 'rejected'].includes(status))
      return res.status(400).json({ error: '無效的 status' });
    const { error } = await supabase.from('leave_requests')
      .update({ status, handler_note: handler_note || '', handled_at: new Date().toISOString() })
      .eq('id', id);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ message: '審核完成' });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
