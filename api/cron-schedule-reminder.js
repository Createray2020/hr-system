// api/cron-schedule-reminder.js
// cron entry：每月 26 日 09:00 跑（在 vercel.json crons 啟用）
//
// thin wrapper：將 supabase + lib/push.js 包成 lib/schedule/reminder.js 期望的 repo。
//
// 對應設計文件：docs/attendance-system-design-v1.md §6.4
// 對應實作計畫：docs/attendance-system-implementation-plan-v1.md §5.7

import { supabaseAdmin } from '../lib/supabase.js';
import { runScheduleReminder } from '../lib/schedule/reminder.js';
import { sendPushToEmployees, createNotification } from '../lib/push.js';
import { requireCron } from '../lib/cron-auth.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!requireCron(req, res)) return;

  const today = (req.query?.today || new Date().toISOString()).slice(0, 10);

  try {
    const result = await runScheduleReminder(supabaseRepo(), today);
    return res.status(200).json({ ok: true, today, ...result });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}

function supabaseRepo() {
  return {
    async findEmployeesNeedingReminder(year, month) {
      // 找下個月已建立但 status='draft' 的員工
      const { data: drafts, error: dErr } = await supabaseAdmin
        .from('schedule_periods')
        .select('employee_id')
        .eq('period_year', year).eq('period_month', month).eq('status', 'draft');
      if (dErr) throw dErr;
      const draftIds = new Set((drafts || []).map(p => p.employee_id));

      // 也找該月「還沒建 period」的活躍員工 — 也要提醒
      const { data: allEmps, error: eErr } = await supabaseAdmin
        .from('employees').select('id, name').eq('status', 'active');
      if (eErr) throw eErr;

      const { data: existingPeriods } = await supabaseAdmin
        .from('schedule_periods').select('employee_id')
        .eq('period_year', year).eq('period_month', month);
      const existingIds = new Set((existingPeriods || []).map(p => p.employee_id));

      // 提醒對象 = (有 draft 還沒送) ∪ (沒建 period)
      return (allEmps || []).filter(e =>
        draftIds.has(e.id) || !existingIds.has(e.id)
      );
    },

    async sendReminderNotification(employee, year, month) {
      const title = '排班提醒';
      const body  = `請於本月 25 號前送出 ${year}/${String(month).padStart(2, '0')} 月份排班`;
      try {
        await Promise.allSettled([
          sendPushToEmployees([employee.id], { title, body, url: '/employee-schedule', tag: 'schedule-reminder' }),
          createNotification(employee.id, { title, body, url: '/employee-schedule', type: 'reminder' }),
        ]);
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },
  };
}
