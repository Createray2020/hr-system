// api/announcements.js — 公告系統 CRUD + 發布推播
import { supabase } from '../lib/supabase.js';
import { sendPushToEmployees, createNotifications } from '../lib/push.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── GET ──────────────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    const { id, role, employee_id, draft } = req.query;

    // 單筆（記錄已讀 + 增加瀏覽數）
    if (id) {
      const { data, error } = await supabase
        .from('announcements').select('*').eq('id', id).single();
      if (error) return res.status(404).json({ error: '找不到公告' });

      await supabase.from('announcements')
        .update({ view_count: (data.view_count || 0) + 1 }).eq('id', id);

      if (employee_id) {
        await supabase.from('announcement_reads').upsert([{
          id: `READ_${id}_${employee_id}`,
          announcement_id: id,
          employee_id,
        }], { onConflict: 'announcement_id,employee_id' });
      }

      // 取作者資料（避免 FK join）
      let author = null;
      if (data.author_id) {
        const { data: emp } = await supabase
          .from('employees').select('name, position, avatar').eq('id', data.author_id).single();
        author = emp || null;
      }
      return res.status(200).json({ ...data, author });
    }

    // 列表
    let q = supabase.from('announcements').select('*')
      .order('is_pinned', { ascending: false })
      .order('published_at', { ascending: false });

    if (!draft) q = q.eq('is_published', true);

    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });

    let rows = data || [];

    // 過濾過期
    if (!draft) {
      const now = new Date().toISOString();
      rows = rows.filter(a => !a.expires_at || a.expires_at > now);
    }

    // 依角色過濾
    if (role) {
      rows = rows.filter(a => {
        const t = a.target_roles || ['all'];
        return t.includes('all') || t.includes(role);
      });
    }

    // 補充作者名稱（two-query merge）
    const authorIds = [...new Set(rows.map(r => r.author_id).filter(Boolean))];
    if (authorIds.length) {
      const { data: emps } = await supabase
        .from('employees').select('id, name, avatar').in('id', authorIds);
      const empMap = {};
      (emps || []).forEach(e => { empMap[e.id] = e; });
      rows = rows.map(r => ({ ...r, author: empMap[r.author_id] || null }));
    }

    return res.status(200).json(rows);
  }

  // ── POST ─────────────────────────────────────────────────────────────────
  if (req.method === 'POST') {
    const body = req.body;

    // 新增草稿
    if (body.action === 'create') {
      const id = 'ANN' + Date.now();
      const { error } = await supabase.from('announcements').insert([{
        id,
        title:        body.title,
        content:      body.content,
        category:     body.category  || 'general',
        priority:     body.priority  || 'normal',
        target_roles: body.target_roles || ['all'],
        is_pinned:    body.is_pinned || false,
        is_published: false,
        author_id:    body.author_id || null,
        expires_at:   body.expires_at || null,
      }]);
      if (error) return res.status(500).json({ error: error.message });
      return res.status(201).json({ id, message: '草稿已儲存' });
    }

    // 更新
    if (body.action === 'update') {
      const { error } = await supabase.from('announcements').update({
        title:        body.title,
        content:      body.content,
        category:     body.category,
        priority:     body.priority,
        target_roles: body.target_roles,
        is_pinned:    body.is_pinned,
        expires_at:   body.expires_at || null,
        updated_at:   new Date().toISOString(),
      }).eq('id', body.id);
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ message: '已更新' });
    }

    // 發布
    if (body.action === 'publish') {
      await supabase.from('announcements').update({
        is_published: true,
        published_at: new Date().toISOString(),
        updated_at:   new Date().toISOString(),
      }).eq('id', body.id);

      const { data: ann } = await supabase
        .from('announcements').select('*').eq('id', body.id).single();

      const targets = ann?.target_roles || ['all'];
      let empQuery = supabase.from('employees').select('id').eq('status', 'active');
      if (!targets.includes('all')) empQuery = empQuery.in('role', targets);
      const { data: emps } = await empQuery;
      const empIds = (emps || []).map(e => e.id);

      const notifPayload = {
        title: `📢 ${ann.title}`,
        body:  ann.content.slice(0, 80) + (ann.content.length > 80 ? '…' : ''),
        url:   `/announcements.html?id=${body.id}`,
        type:  'announcement',
      };

      createNotifications(empIds, notifPayload).catch(() => {});
      sendPushToEmployees(empIds, { ...notifPayload, tag: 'ann-' + body.id }).catch(() => {});

      return res.status(200).json({ message: '已發布', recipients: empIds.length });
    }

    // 置頂切換
    if (body.action === 'pin') {
      const { data: ann } = await supabase
        .from('announcements').select('is_pinned').eq('id', body.id).single();
      const newPinned = !ann?.is_pinned;
      await supabase.from('announcements').update({ is_pinned: newPinned }).eq('id', body.id);
      return res.status(200).json({ message: newPinned ? '已置頂' : '已取消置頂' });
    }

    // 刪除
    if (body.action === 'delete') {
      await supabase.from('announcements').delete().eq('id', body.id);
      return res.status(200).json({ message: '已刪除' });
    }

    return res.status(400).json({ error: '未知的 action' });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
