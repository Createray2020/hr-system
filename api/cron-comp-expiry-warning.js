// api/cron-comp-expiry-warning.js
// cron entry:每天 02:00 跑(在 vercel.json crons 啟用)
//
// thin wrapper:將 supabase + push 包成 lib/comp-time/expiry-warning.js 期望的 repo。
//
// 對應設計文件:docs/attendance-system-design-v1.md §6.4
// 對應實作計畫:docs/attendance-system-implementation-plan-v1.md §8.5

import { runCompExpiryWarning } from '../lib/comp-time/expiry-warning.js';
import { makeLeaveRepo } from './leaves/_repo.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const today = (req.query?.today || new Date().toISOString()).slice(0, 10);

  try {
    const result = await runCompExpiryWarning(makeLeaveRepo(), today);
    return res.status(200).json({ ok: true, today, ...result });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
