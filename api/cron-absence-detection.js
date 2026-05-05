// api/cron-absence-detection.js
// cron entry：每天 00:15 跑（在 vercel.json crons 啟用）
//
// thin wrapper：將 supabase + lib/push.js 包成 lib/attendance/absence-sweep.js
// 期望的 repo 介面，業務邏輯在 lib/。
//
// 對應設計文件：docs/attendance-system-design-v1.md §6.4
// 對應實作計畫：docs/attendance-system-implementation-plan-v1.md §6.3

import { supabaseAdmin } from '../lib/supabase.js';
import { runAbsenceSweep } from '../lib/attendance/absence-sweep.js';
import { sendPushToEmployees, sendPushToRoles, createNotification, createNotificationsForRoles } from '../lib/push.js';
import { requireCron } from '../lib/cron-auth.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!requireCron(req, res)) return;

  const today = (req.query?.today || new Date().toISOString()).slice(0, 10);

  try {
    const result = await runAbsenceSweep(supabaseRepo(), today);
    return res.status(200).json({ ok: true, today, ...result });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}

function supabaseRepo() {
  return {
    async findLockedSchedulesByDate(date) {
      // is_off=true 的 schedule(ST003 休假 / ST004 例假 / 國假)員工本來就不該打卡、
      // cron 不對這類 schedule 寫 absent。lib/attendance/absence-sweep.js 信任 repo
      // 給的 list、不重複 shift_type 判斷。
      // !inner 強制 INNER JOIN、shift_types.is_off=false 條件下推給 PG。
      const { data: scheds, error } = await supabaseAdmin
        .from('schedules')
        .select('id, employee_id, segment_no, period_id, shift_types!inner(is_off)')
        .eq('work_date', date)
        .eq('shift_types.is_off', false);
      if (error) throw error;
      if (!scheds || scheds.length === 0) return [];
      const periodIds = [...new Set(scheds.map(s => s.period_id).filter(Boolean))];
      if (periodIds.length === 0) return [];
      const { data: periods } = await supabaseAdmin
        .from('schedule_periods').select('id, status').in('id', periodIds);
      // 已公告(published)或已鎖定(locked)的 period 都應該掃曠職。
      // approved 不掃(尚未對員工公告、員工不知道要打卡)。
      const ATTENDABLE = new Set(['published', 'locked']);
      const lockedSet = new Set((periods || []).filter(p => ATTENDABLE.has(p.status)).map(p => p.id));
      // 回給 lib 的 row 不帶 shift_types 巢狀(契約乾淨、lib 不該知 shift_type)
      return scheds
        .filter(s => lockedSet.has(s.period_id))
        .map(({ shift_types, ...rest }) => rest);
    },

    async findAttendanceByDateSegment(employee_id, date, segment_no) {
      const { data, error } = await supabaseAdmin
        .from('attendance').select('*')
        .eq('employee_id', employee_id).eq('work_date', date).eq('segment_no', segment_no)
        .maybeSingle();
      if (error) throw error;
      return data || null;
    },

    async findApprovedLeaveCovering(employee_id, date) {
      // 找 approved leave_request 涵蓋該日期。schema:start_at / end_at TIMESTAMPTZ
      const dayStart = `${date}T00:00:00+08:00`;
      const dayEnd   = `${date}T23:59:59+08:00`;
      const { data, error } = await supabaseAdmin
        .from('leave_requests').select('id, leave_type, start_at, end_at')
        .eq('employee_id', employee_id).eq('status', 'approved')
        .lte('start_at', dayEnd).gte('end_at', dayStart)
        .limit(1).maybeSingle();
      if (error && error.code !== 'PGRST116') throw error;
      return data || null;
    },

    async getEmployeeManager(employee_id) {
      const { data, error } = await supabaseAdmin
        .from('employees').select('id, manager_id').eq('id', employee_id).maybeSingle();
      if (error) throw error;
      return data || null;
    },

    async upsertAttendance(row) {
      const { data, error } = await supabaseAdmin
        .from('attendance').upsert([row], { onConflict: 'id' }).select().maybeSingle();
      if (error) throw error;
      return data;
    },

    async notifyAbsence({ employee_id, manager_id, work_date, segment_no }) {
      // 補員工姓名(HR / 主管 / 員工自己看通知時要能辨識是誰、不能只 EMP_xxx)
      let empLabel = employee_id;
      try {
        const { data: emp } = await supabaseAdmin
          .from('employees').select('name').eq('id', employee_id).maybeSingle();
        if (emp?.name) empLabel = `${emp.name}(${employee_id})`;
      } catch (_) {}

      const payload = {
        title: '出勤異常:曠職',
        body: `${empLabel} ${work_date}${segment_no > 1 ? ` 段${segment_no}` : ''} 未打卡且無請假`,
        url: '/attendance-admin',
        tag: `absence-${employee_id}-${work_date}-${segment_no}`,
      };
      try {
        // 員工本人通知
        await Promise.allSettled([
          sendPushToEmployees([employee_id], payload),
          createNotification(employee_id, { ...payload, type: 'absence' }),
        ]);
        // 主管通知
        if (manager_id) {
          await Promise.allSettled([
            sendPushToEmployees([manager_id], payload),
            createNotification(manager_id, { ...payload, type: 'absence' }),
          ]);
        }
        // HR 通知(用 role 廣播)
        await Promise.allSettled([
          sendPushToRoles(['hr'], payload),
          createNotificationsForRoles(['hr'], { ...payload, type: 'absence' }),
        ]);
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },
  };
}
