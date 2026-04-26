// api/attendance/anomaly.js
// POST  /api/attendance/anomaly  → HR / admin 標記 / 取消 is_anomaly + anomaly_note
//
// body: { attendance_id, is_anomaly: bool, anomaly_note: string }
//
// 對應設計文件：docs/attendance-system-design-v1.md §4.2.4
// 對應實作計畫：docs/attendance-system-implementation-plan-v1.md §6.4
//
// Routing 假設（Vercel file-system routing）：
//   本檔跟 [id].js 同目錄,Vercel 慣例「靜態檔名優先於 dynamic route」會把
//   /api/attendance/anomaly 路由到本檔（而非 [id].js?id=anomaly）。
//   本 repo precedent: api/holidays/{[id].js, import.js, index.js} 已驗證 work。
//   Batch 10 上 prod 後手測再次確認。

import { supabase } from '../../lib/supabase.js';
import { requireRoleOrPass } from '../../lib/auth.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const caller = await requireRoleOrPass(req, res, ['hr', 'admin']);
  if (!caller) return;
  const isHR = ['hr', 'admin'].includes(caller.role || '');
  if (!isHR) return res.status(403).json({ error: 'HR / admin only' });

  const { attendance_id, is_anomaly, anomaly_note } = req.body || {};
  if (!attendance_id) return res.status(400).json({ error: 'attendance_id required' });
  if (typeof is_anomaly !== 'boolean') {
    return res.status(400).json({ error: 'is_anomaly must be boolean' });
  }

  const { data: existing, error: gErr } = await supabase
    .from('attendance').select('id').eq('id', attendance_id).maybeSingle();
  if (gErr) return res.status(500).json({ error: gErr.message });
  if (!existing) return res.status(404).json({ error: 'attendance not found' });

  const patch = {
    is_anomaly,
    // 取消 anomaly 時清空 note;設為 anomaly 時若有 note 寫入,沒 note 則保留 null
    anomaly_note: is_anomaly ? (anomaly_note || null) : null,
  };

  const { data, error } = await supabase
    .from('attendance').update(patch).eq('id', attendance_id).select().maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ attendance: data });
}
