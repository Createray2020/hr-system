// api/holidays/[id].js
// PUT    /api/holidays/:id  → HR/admin 修改單筆（不影響 source 欄位）
// DELETE /api/holidays/:id  → HR/admin 刪除
//
// 對應設計文件：docs/attendance-system-design-v1.md §4.1.1
// 對應實作計畫：docs/attendance-system-implementation-plan-v1.md §4.4
import { supabase } from '../../lib/supabase.js';
import { requireRoleOrPass } from '../../lib/auth.js';

const HOLIDAY_TYPES = ['national', 'makeup_workday', 'company', 'flexible'];

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'id required' });

  if (req.method === 'PUT') {
    const caller = await requireRoleOrPass(req, res, ['hr', 'admin']);
    if (!caller) return;

    const allowed = ['date', 'holiday_type', 'name', 'description', 'pay_multiplier'];
    const update = {};
    allowed.forEach(k => { if (req.body[k] !== undefined) update[k] = req.body[k]; });

    if (update.holiday_type && !HOLIDAY_TYPES.includes(update.holiday_type)) {
      return res.status(400).json({ error: 'invalid holiday_type' });
    }
    if (update.pay_multiplier != null) update.pay_multiplier = Number(update.pay_multiplier);
    update.updated_at = new Date().toISOString();

    const { data, error } = await supabase
      .from('holidays').update(update).eq('id', id).select().single();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: 'not found' });
    return res.status(200).json(data);
  }

  if (req.method === 'DELETE') {
    const caller = await requireRoleOrPass(req, res, ['hr', 'admin']);
    if (!caller) return;

    const { error } = await supabase.from('holidays').delete().eq('id', id);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ message: '已刪除' });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
