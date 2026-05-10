// api/cron-lock-payroll-period.js
// cron entry:每月 1 號 00:00 UTC (台灣 08:00) 跑、自動 lock 上個月以前 paid 的薪資期間
//
// 對應設計:階段 C3 — HR 不用每月手動點 lock、cron 自動接手
// 對應 lib:lib/salary/payroll-period-lock.js (純函式 + repo 注入)

import { supabaseAdmin } from '../lib/supabase.js';
import { runLockPayrollPeriodSweep } from '../lib/salary/payroll-period-lock.js';
import { requireCron } from '../lib/cron-auth.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!requireCron(req, res)) return;

  const today = (req.query?.today || new Date().toISOString()).slice(0, 10);

  try {
    const result = await runLockPayrollPeriodSweep(supabaseRepo(), today);
    return res.status(200).json({ ok: true, today, ...result });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}

function supabaseRepo() {
  return {
    async findPaidPeriodsBefore({ year, month }) {
      // 撈 status='paid' 的 periods、然後 in-memory filter
      // (year < y) OR (year=y AND month < m) — supabase or() 字面複雜、in-memory 比較直觀
      const { data, error } = await supabaseAdmin
        .from('payroll_periods').select('id, year, month, status')
        .eq('status', 'paid');
      if (error) throw error;
      return (data || []).filter(p =>
        p.year < year || (p.year === year && p.month < month)
      );
    },

    async lockPeriod(id) {
      const now = new Date().toISOString();
      // 條件 status='paid' 防 race(只在 paid 狀態才 lock、避免覆蓋其他狀態)
      const { data, error } = await supabaseAdmin
        .from('payroll_periods')
        .update({ status: 'locked', locked_at: now })
        .eq('id', id).eq('status', 'paid')
        .select().maybeSingle();
      if (error) throw error;
      return data || null;
    },
  };
}
