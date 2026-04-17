// api/salary/[id].js — PUT update / confirm / pay
import { supabase } from '../../lib/supabase.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { id, action } = req.query;

  // PUT /api/salary/[id]/confirm
  if (action === 'confirm' && req.method === 'PUT') {
    const { error } = await supabase.from('salary_records')
      .update({ status: 'confirmed', updated_at: new Date().toISOString() }).eq('id', id);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ message: '已確認' });
  }

  // PUT /api/salary/[id]/pay
  if (action === 'pay' && req.method === 'PUT') {
    const { error } = await supabase.from('salary_records')
      .update({ status: 'paid', pay_date: new Date().toISOString().split('T')[0], updated_at: new Date().toISOString() })
      .eq('id', id);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ message: '已標記發放' });
  }

  // PUT /api/salary/[id] — 更新薪資項目
  if (req.method === 'PUT') {
    const allowed = ['overtime_pay','bonus','allowance','deduct_absence',
                     'deduct_labor_ins','deduct_health_ins','deduct_tax','note'];
    const update  = {};
    allowed.forEach(k => { if (req.body[k] !== undefined) update[k] = req.body[k]; });
    update.updated_at = new Date().toISOString();

    const { error } = await supabase.from('salary_records').update(update).eq('id', id);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ message: '已更新' });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
