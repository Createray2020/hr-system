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
    const body = req.body;
    const id = 'E' + Date.now();
    const { error } = await supabase.from('employees').insert([{ id, ...body }]);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(201).json({ id, message: '員工已建立' });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
