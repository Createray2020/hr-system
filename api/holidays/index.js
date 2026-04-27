// api/holidays/index.js
// GET  /api/holidays?year=2026[&type=national]  → 清單
// POST /api/holidays                            → HR/admin 新建單筆
//
// 對應設計文件：docs/attendance-system-design-v1.md §4.1.1
// 對應實作計畫：docs/attendance-system-implementation-plan-v1.md §4.4
import { supabaseAdmin } from '../../lib/supabase.js';
import { requireRole } from '../../lib/auth.js';
import { BACKOFFICE_ROLES } from '../../lib/roles.js';

const HOLIDAY_TYPES = ['national', 'makeup_workday', 'company', 'flexible'];

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') {
    const { year, type } = req.query;
    if (!year) return res.status(400).json({ error: 'year required' });
    const y = parseInt(year);
    if (!Number.isInteger(y) || y < 1900 || y > 2999) {
      return res.status(400).json({ error: 'invalid year' });
    }

    let q = supabaseAdmin.from('holidays')
      .select('*')
      .gte('date', `${y}-01-01`)
      .lte('date', `${y}-12-31`)
      .order('date', { ascending: true });
    if (type) {
      if (!HOLIDAY_TYPES.includes(type)) {
        return res.status(400).json({ error: 'invalid type' });
      }
      q = q.eq('holiday_type', type);
    }

    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json(data || []);
  }

  if (req.method === 'POST') {
    const caller = await requireRole(req, res, BACKOFFICE_ROLES);
    if (!caller) return;

    const { date, holiday_type, name, description, pay_multiplier } = req.body || {};
    if (!date || !holiday_type || !name) {
      return res.status(400).json({ error: 'date / holiday_type / name 必填' });
    }
    if (!HOLIDAY_TYPES.includes(holiday_type)) {
      return res.status(400).json({ error: 'invalid holiday_type' });
    }

    const row = {
      date,
      holiday_type,
      name,
      description: description || null,
      pay_multiplier: pay_multiplier != null ? Number(pay_multiplier) : 2.00,
      source: 'manual',
      created_by: caller.id || null,
    };

    const { data, error } = await supabaseAdmin.from('holidays').insert([row]).select().single();
    if (error) return res.status(500).json({ error: error.message });
    return res.status(201).json(data);
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
