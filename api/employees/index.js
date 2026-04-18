// api/employees/index.js — GET all / POST new
import { supabase } from '../../lib/supabase.js';
import { requireRoleOrPass } from '../../lib/auth.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  // GET — 不需要權限驗證
  if (req.method === 'GET') {
    const { status, dept, search } = req.query;
    let q = supabase.from('employees').select('*').order('name');
    if (status) q = q.eq('status', status);
    if (dept)   q = q.eq('dept', dept);
    if (search) q = q.or(`name.ilike.%${search}%,email.ilike.%${search}%`);
    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json(data);
  }

  if (req.method === 'POST') {
    const caller = await requireRoleOrPass(req, res, ['hr', 'ceo', 'admin']);
    if (!caller) return;
    const body = { ...req.body };
    const id = 'E' + Date.now();

    // ── 自動產生員工編號（若未傳入）EMP-001, EMP-002... ──
    if (!body.emp_no) {
      const { data: existing } = await supabase
        .from('employees')
        .select('emp_no')
        .like('emp_no', 'EMP-%')
        .order('emp_no', { ascending: false })
        .limit(1);
      let nextNum = 1;
      if (existing && existing.length > 0) {
        const last = existing[0].emp_no; // e.g. "EMP-042"
        const parsed = parseInt(last.replace('EMP-', ''), 10);
        if (!isNaN(parsed)) nextNum = parsed + 1;
      }
      body.emp_no = 'EMP-' + String(nextNum).padStart(3, '0');
    }

    const { error } = await supabase.from('employees').insert([{ id, ...body }]);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(201).json({ id, emp_no: body.emp_no, message: '員工已建立' });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
