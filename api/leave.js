// api/leave.js
import { supabase } from '../lib/supabase.js';
import { requireRole } from '../lib/auth.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  const { id } = req.query;
  if (!id) return res.status(400).json({ error: '缺少 id' });

  if (req.method === 'GET') {
    // 步驟一：查詢假單
    const { data: leave, error } = await supabase
      .from('leave_requests').select('*').eq('id', id).single();
    if (error) return res.status(404).json({ error: '找不到假單' });

    // 步驟二：查詢員工資料
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

  if (req.method === 'PUT') {
    const caller = await requireRole(req, res, ['hr', 'admin']);
    if (!caller) return;
    const { status, handler_note } = req.body;
    if (!['approved','rejected'].includes(status))
      return res.status(400).json({ error: '無效的 status' });
    const { error } = await supabase.from('leave_requests')
      .update({ status, handler_note: handler_note||'', handled_at: new Date().toISOString() })
      .eq('id', id);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ message: '審核完成' });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
