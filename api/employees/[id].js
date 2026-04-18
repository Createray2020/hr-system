// api/employees/[id].js — GET one / PUT update + /me route
import { supabase } from '../../lib/supabase.js';
import { requireRole } from '../../lib/auth.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { id } = req.query;

  // /api/employees/me — 用 JWT 找自己
  if (id === 'me') {
    const token = (req.headers.authorization||'').replace('Bearer ','');
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !user) return res.status(401).json({ error: 'Invalid token' });

    const { data, error } = await supabase
      .from('employees').select('*').eq('email', user.email).single();
    if (error) {
      // 若找不到，回傳基本 user 資料
      return res.status(200).json({ id: null, name: user.email.split('@')[0], email: user.email, role: 'employee' });
    }
    return res.status(200).json(data);
  }

  if (req.method === 'GET') {
    const { data, error } = await supabase.from('employees').select('*').eq('id', id).single();
    if (error) return res.status(404).json({ error: '找不到員工' });
    return res.status(200).json(data);
  }

  if (req.method === 'PUT') {
    const caller = await requireRole(req, res, ['hr', 'admin']);
    if (!caller) return;
    const { error } = await supabase.from('employees')
      .update({ ...req.body, updated_at: new Date().toISOString() }).eq('id', id);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ message: '已更新' });
  }

  if (req.method === 'DELETE') {
    const caller = await requireRole(req, res, ['hr', 'admin']);
    if (!caller) return;
    const { error } = await supabase.from('employees').update({ status: 'resigned' }).eq('id', id);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ message: '已設為離職' });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
