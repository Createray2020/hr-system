// api/cron-schedule-lock.js
// cron entry：每天 00:30 跑一次（在 vercel.json crons 啟用）
//
// thin wrapper：將 supabase 包成 lib/schedule/lock-sweep.js 期望的 repo 介面，
// 業務邏輯在 lib/。
//
// 對應設計文件：docs/attendance-system-design-v1.md §6.4
// 對應實作計畫：docs/attendance-system-implementation-plan-v1.md §5.5

import { supabase } from '../lib/supabase.js';
import { runLockSweep } from '../lib/schedule/lock-sweep.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const today = (req.query?.today || todayIso()).slice(0, 10);

  try {
    const result = await runLockSweep(supabaseRepo(), today);
    return res.status(200).json({ ok: true, today, ...result });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}

function todayIso() {
  return new Date().toISOString();
}

function supabaseRepo() {
  return {
    async findApprovedPeriodsToLock(today) {
      const { data, error } = await supabase
        .from('schedule_periods').select('id, employee_id, period_start, period_end, status')
        .eq('status', 'approved').lte('period_start', today);
      if (error) throw error;
      return data || [];
    },

    async lockPeriod(id, today) {
      const now = new Date().toISOString();
      const { data, error } = await supabase
        .from('schedule_periods')
        .update({ status: 'locked', locked_at: now, updated_at: now })
        .eq('id', id).eq('status', 'approved')
        .select().maybeSingle();
      if (error) return { ok: false, error: error.message };
      return { ok: !!data };
    },

    async logChange(row) {
      const { data, error } = await supabase
        .from('schedule_change_logs').insert([row]).select().single();
      if (error) throw error;
      return data;
    },
  };
}
