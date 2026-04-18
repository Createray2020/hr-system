// api/departments.js — GET list / POST create / PUT update / DELETE
//
// 若尚未執行，請在 Supabase SQL Editor 補充欄位：
//   ALTER TABLE departments ADD COLUMN IF NOT EXISTS description TEXT DEFAULT '';
//   ALTER TABLE departments ADD COLUMN IF NOT EXISTS color TEXT DEFAULT '#5B8DEF';
import { supabase } from '../lib/supabase.js';
import { requireRoleOrPass } from '../lib/auth.js';

const WRITE_ROLES  = ['hr', 'ceo', 'chairman', 'manager', 'admin'];
const DELETE_ROLES = ['hr', 'ceo', 'chairman', 'manager', 'admin'];

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  // GET — 不需要權限驗證
  if (req.method === 'GET') {
    try {
      // 步驟一：查詢所有部門
      const { data: depts, error } = await supabase
        .from('departments').select('*').order('name');
      if (error) return res.status(500).json({ error: error.message, details: error.details, hint: error.hint });

      // 步驟二：統計各部門在職人數（以 dept 名稱欄位對應）
      const { data: emps } = await supabase
        .from('employees').select('dept').eq('status', 'active');
      const countMap = {};
      (emps || []).forEach(e => { countMap[e.dept] = (countMap[e.dept] || 0) + 1; });

      // 步驟三：查詢主管名稱
      const managerIds = depts.map(d => d.manager_id).filter(Boolean);
      let managerMap = {};
      if (managerIds.length) {
        const { data: mgrs } = await supabase
          .from('employees').select('id, name').in('id', managerIds);
        (mgrs || []).forEach(m => { managerMap[m.id] = m.name; });
      }

      return res.status(200).json(depts.map(d => ({
        ...d,
        emp_count:    countMap[d.name] || 0,
        manager_name: managerMap[d.manager_id] || null,
      })));
    } catch (e) {
      return res.status(500).json({ error: e.message, stack: e.stack });
    }
  }

  if (req.method === 'POST') {
    const caller = await requireRoleOrPass(req, res, WRITE_ROLES);
    if (!caller) return;
    const { name, description, color, manager_id } = req.body;
    if (!name) return res.status(400).json({ error: '缺少部門名稱' });
    const id = 'D' + Date.now();
    const { error } = await supabase.from('departments').insert([{
      id,
      name,
      description: description || '',
      color:       color || '#5B8DEF',
      manager_id:  manager_id || null,
    }]);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(201).json({ id, message: '部門已建立' });
  }

  if (req.method === 'PUT') {
    const caller = await requireRoleOrPass(req, res, WRITE_ROLES);
    if (!caller) return;
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: '缺少 id' });
    const allowed = ['name', 'description', 'color', 'manager_id'];
    const update = {};
    allowed.forEach(k => { if (req.body[k] !== undefined) update[k] = req.body[k]; });
    const { error } = await supabase.from('departments').update(update).eq('id', id);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ message: '已更新' });
  }

  if (req.method === 'DELETE') {
    const caller = await requireRoleOrPass(req, res, DELETE_ROLES);
    if (!caller) return;
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: '缺少 id' });

    // 取得部門名稱以便比對員工
    const { data: dept } = await supabase
      .from('departments').select('name').eq('id', id).single();
    if (!dept) return res.status(404).json({ error: '找不到部門' });

    // 有在職員工時拒絕刪除
    const { data: active } = await supabase
      .from('employees').select('id').eq('dept', dept.name).eq('status', 'active').limit(1);
    if (active && active.length > 0)
      return res.status(409).json({ error: '該部門仍有在職員工，無法刪除' });

    const { error } = await supabase.from('departments').delete().eq('id', id);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ message: '已刪除' });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
