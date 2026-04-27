// api/attendance/[id].js
// PUT    /api/attendance/:id  → HR / admin 修改 attendance（限定欄位白名單）
// DELETE /api/attendance/:id  → HR / admin 刪除 attendance
//
// 對應設計文件：docs/attendance-system-design-v1.md §4.2.4
// 對應實作計畫：docs/attendance-system-implementation-plan-v1.md §6.4
//
// Routing 假設（Vercel file-system routing）：
//   `api/attendance/anomaly.js` 跟本檔同目錄共存,Vercel 慣例「靜態檔名優先」會
//   把 /api/attendance/anomaly 路由到 anomaly.js,/api/attendance/{其他} 路由到本檔。
//   本 repo precedent: api/holidays/{[id].js, import.js, index.js} 已驗證 work
//   (holidays-admin.html L231/247 PUT/DELETE 走 [id].js,L262 import 走 import.js)。
//   Batch 10 上 prod 後手測再次確認。
//
// vercel.json 中既有的 /api/attendance/:id rewrite 已在 Batch 4 移除,
// 否則本檔永遠不會被 hit(會被 rewrite 到 index.js?_id=...)。

import { supabase } from '../../lib/supabase.js';
import { requireRole } from '../../lib/auth.js';

const ALLOWED_PUT_FIELDS = new Set([
  'clock_in', 'clock_out',
  'late_minutes', 'early_leave_minutes',
  'work_hours', 'overtime_hours',
  'status',
  'is_anomaly', 'anomaly_note',
  'note',
]);

const ALLOWED_STATUSES = new Set(['normal', 'late', 'early_leave', 'absent', 'leave', 'holiday']);

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  const id = req.query.id;
  if (!id || id === 'anomaly') {
    // 'anomaly' 不該透過此檔處理(file-system routing 應該優先匹配 anomaly.js)。
    // 防呆:若 query.id === 'anomaly' 表示路由出錯,直接 400。
    return res.status(400).json({ error: 'invalid id' });
  }

  const caller = await requireRole(req, res, ['hr', 'admin', 'ceo']);
  if (!caller) return;

  // 權限:HR / admin 才能改打卡紀錄
  const isHR = ['hr', 'admin', 'ceo'].includes(caller.role || '');
  if (!isHR) return res.status(403).json({ error: 'HR / admin only' });

  const { data: existing, error: gErr } = await supabase
    .from('attendance').select('*').eq('id', id).maybeSingle();
  if (gErr) return res.status(500).json({ error: gErr.message });
  if (!existing) return res.status(404).json({ error: 'attendance not found' });

  if (req.method === 'PUT') {
    const patch = {};
    for (const k of Object.keys(req.body || {})) {
      if (!ALLOWED_PUT_FIELDS.has(k)) continue;
      patch[k] = req.body[k];
    }
    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ error: 'no allowed fields to update' });
    }
    if (patch.status !== undefined && !ALLOWED_STATUSES.has(patch.status)) {
      return res.status(400).json({ error: 'invalid status' });
    }

    const { data, error } = await supabase
      .from('attendance').update(patch).eq('id', id).select().maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ attendance: data });
  }

  if (req.method === 'DELETE') {
    const { error } = await supabase.from('attendance').delete().eq('id', id);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ deleted: true, id });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
