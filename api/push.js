// api/push.js — Web Push 推播通知 API
// POST action=subscribe    → 儲存訂閱
// POST action=unsubscribe  → 取消訂閱
// POST action=send         → 發送給指定員工
// POST action=send_to_role → 發送給某角色
import { sendPushToEmployees, sendPushToRoles } from '../lib/push.js';
import { supabase } from '../lib/supabase.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action } = req.body;

  // ── 訂閱 ────────────────────────────────────────────────────────────────
  if (action === 'subscribe') {
    const { employee_id, subscription } = req.body;
    if (!employee_id || !subscription) return res.status(400).json({ error: '缺少參數' });
    const { error } = await supabase.from('push_subscriptions').upsert([{
      id:          'PUSH_' + employee_id,
      employee_id,
      subscription: typeof subscription === 'string' ? subscription : JSON.stringify(subscription),
      updated_at:  new Date().toISOString(),
    }], { onConflict: 'employee_id' });
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ message: '已訂閱推播通知' });
  }

  // ── 取消訂閱 ─────────────────────────────────────────────────────────────
  if (action === 'unsubscribe') {
    const { employee_id } = req.body;
    if (!employee_id) return res.status(400).json({ error: '缺少 employee_id' });
    await supabase.from('push_subscriptions').delete().eq('employee_id', employee_id);
    return res.status(200).json({ message: '已取消訂閱' });
  }

  // ── 發送給指定員工 ────────────────────────────────────────────────────────
  if (action === 'send') {
    const { employee_ids, title, body, url, tag } = req.body;
    if (!employee_ids?.length) return res.status(400).json({ error: '缺少 employee_ids' });
    const result = await sendPushToEmployees(employee_ids, { title, body, url, tag });
    return res.status(200).json(result);
  }

  // ── 發送給某角色 ─────────────────────────────────────────────────────────
  if (action === 'send_to_role') {
    const { roles, title, body, url, tag } = req.body;
    if (!roles?.length) return res.status(400).json({ error: '缺少 roles' });
    const result = await sendPushToRoles(roles, { title, body, url, tag });
    return res.status(200).json(result);
  }

  return res.status(400).json({ error: '未知的 action' });
}
