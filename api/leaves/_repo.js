// api/leaves/_repo.js — supabase 注入式 repo for lib/leave/*
//
// 同時被 leaves/index.js / leaves/[id].js / annual-leaves/* / cron-annual-leave-rollover.js 共用。
// _ 前綴避免被當成 API route(Vercel 不會把 _xxx.js 當 endpoint)。

import { supabaseAdmin } from '../../lib/supabase.js';

export function makeLeaveRepo() {
  return {
    nowIso() { return new Date().toISOString(); },

    // ─── leave_types ─────
    async findLeaveType(code) {
      const { data, error } = await supabaseAdmin
        .from('leave_types').select('*').eq('code', code).maybeSingle();
      if (error) throw error;
      return data || null;
    },
    async listActiveLeaveTypes() {
      const { data, error } = await supabaseAdmin
        .from('leave_types').select('*').eq('is_active', true).order('display_order');
      if (error) throw error;
      return data || [];
    },

    // ─── schedules ───────
    async findSchedulesInRange(employee_id, dateStart, dateEnd) {
      const { data, error } = await supabaseAdmin
        .from('schedules')
        .select('id, employee_id, work_date, start_time, end_time, crosses_midnight, scheduled_work_minutes, segment_no, period_id')
        .eq('employee_id', employee_id)
        .gte('work_date', dateStart).lte('work_date', dateEnd)
        .order('work_date').order('segment_no');
      if (error) throw error;
      return data || [];
    },

    // ─── annual_leave_records ─────
    async findActiveAnnualRecord(employee_id) {
      const { data, error } = await supabaseAdmin
        .from('annual_leave_records').select('*')
        .eq('employee_id', employee_id).eq('status', 'active')
        .order('period_start', { ascending: false }).limit(1).maybeSingle();
      if (error) throw error;
      return data || null;
    },

    async lockAndIncrementUsedDays({ record_id, delta_days, allow_negative = false, max_retries = 3 }) {
      // 樂觀鎖:UPDATE WHERE used_days = current_used_days,失敗則重試
      for (let attempt = 0; attempt < max_retries; attempt++) {
        const { data: cur } = await supabaseAdmin
          .from('annual_leave_records').select('id, granted_days, used_days, status')
          .eq('id', record_id).maybeSingle();
        if (!cur) return { ok: false, reason: 'NOT_FOUND' };

        const granted = Number(cur.granted_days);
        const curUsed = Number(cur.used_days);
        const newUsed = curUsed + Number(delta_days);

        if (newUsed > granted + 1e-6) return { ok: false, reason: 'INSUFFICIENT_BALANCE' };
        if (newUsed < -1e-6 && !allow_negative) return { ok: false, reason: 'NEGATIVE_BALANCE' };

        const { data: updated, error } = await supabaseAdmin
          .from('annual_leave_records')
          .update({ used_days: newUsed, updated_at: new Date().toISOString() })
          .eq('id', record_id).eq('used_days', curUsed)
          .select().maybeSingle();
        if (error) return { ok: false, reason: error.message };
        if (updated) return { ok: true, record: updated };
        // 否則 race,重試
      }
      return { ok: false, reason: 'CONCURRENT_UPDATE' };
    },

    async insertAnnualRecord(row) {
      // remaining_days 是 GENERATED,不能 INSERT
      const { remaining_days, ...payload } = row;
      const { data, error } = await supabaseAdmin
        .from('annual_leave_records').insert([payload]).select().single();
      if (error) throw error;
      return data;
    },

    async updateAnnualRecord(id, patch) {
      const { remaining_days, ...rest } = patch;
      const { data, error } = await supabaseAdmin
        .from('annual_leave_records').update({ ...rest, updated_at: new Date().toISOString() })
        .eq('id', id).select().maybeSingle();
      if (error) throw error;
      return data;
    },

    async listAnnualRecords({ employee_id, status }) {
      let q = supabaseAdmin.from('annual_leave_records').select('*').order('period_start', { ascending: false });
      if (employee_id) q = q.eq('employee_id', employee_id);
      if (status)      q = q.eq('status', status);
      const { data, error } = await q;
      if (error) throw error;
      return data || [];
    },

    // ─── leave_balance_logs ──
    async insertBalanceLog(row) {
      const { data, error } = await supabaseAdmin
        .from('leave_balance_logs').insert([row]).select().single();
      if (error) throw error;
      return data;
    },

    // ─── leave_requests ──────
    async insertLeaveRequest(row) {
      const { data, error } = await supabaseAdmin
        .from('leave_requests').insert([row]).select().single();
      if (error) throw error;
      return data;
    },
    async findLeaveRequestById(id) {
      const { data, error } = await supabaseAdmin
        .from('leave_requests').select('*').eq('id', id).maybeSingle();
      if (error) throw error;
      return data || null;
    },
    async updateLeaveRequest(id, patch) {
      const { data, error } = await supabaseAdmin
        .from('leave_requests').update(patch).eq('id', id).select().maybeSingle();
      if (error) throw error;
      return data;
    },

    // ─── comp_time_balance(Batch 6 加,deductCompTime / refundCompTime / getCompBalance 用)──
    async findActiveCompBalances(employee_id) {
      const { data, error } = await supabaseAdmin
        .from('comp_time_balance').select('*')
        .eq('employee_id', employee_id).eq('status', 'active')
        .order('expires_at', { ascending: true })
        .order('earned_at',  { ascending: true });
      if (error) throw error;
      return data || [];
    },

    async lockAndIncrementCompUsedHours({ comp_id, delta_hours, allow_negative = false, max_retries = 3 }) {
      // 樂觀鎖:UPDATE WHERE used_hours = current,失敗則重試
      for (let attempt = 0; attempt < max_retries; attempt++) {
        const { data: cur } = await supabaseAdmin
          .from('comp_time_balance').select('id, earned_hours, used_hours, status')
          .eq('id', comp_id).maybeSingle();
        if (!cur) return { ok: false, reason: 'NOT_FOUND' };

        const earned = Number(cur.earned_hours);
        const curUsed = Number(cur.used_hours);
        const newUsed = curUsed + Number(delta_hours);

        if (newUsed > earned + 1e-6) return { ok: false, reason: 'INSUFFICIENT_BALANCE' };
        if (newUsed < -1e-6 && !allow_negative) return { ok: false, reason: 'NEGATIVE_BALANCE' };

        // 自動標 fully_used:若扣到 used == earned 把 status 改成 fully_used
        const patch = { used_hours: newUsed, updated_at: new Date().toISOString() };
        if (newUsed >= earned - 1e-6 && delta_hours > 0) patch.status = 'fully_used';

        const { data: updated, error } = await supabaseAdmin
          .from('comp_time_balance').update(patch)
          .eq('id', comp_id).eq('used_hours', curUsed)
          .select().maybeSingle();
        if (error) return { ok: false, reason: error.message };
        if (updated) return { ok: true, record: updated };
      }
      return { ok: false, reason: 'CONCURRENT_UPDATE' };
    },

    async insertCompBalance(row) {
      const { remaining_hours, ...payload } = row;
      const { data, error } = await supabaseAdmin
        .from('comp_time_balance').insert([payload]).select().single();
      if (error) throw error;
      return data;
    },

    async updateCompBalance(id, patch) {
      const { remaining_hours, ...rest } = patch;
      const { data, error } = await supabaseAdmin
        .from('comp_time_balance').update({ ...rest, updated_at: new Date().toISOString() })
        .eq('id', id).select().maybeSingle();
      if (error) throw error;
      return data;
    },

    async findExpiringCompBalances(today) {
      const { data, error } = await supabaseAdmin
        .from('comp_time_balance').select('*')
        .eq('status', 'active').lte('expires_at', today)
        .order('expires_at');
      if (error) throw error;
      return data || [];
    },

    async findCompBalancesExpiringOn(date) {
      const { data, error } = await supabaseAdmin
        .from('comp_time_balance').select('*')
        .eq('status', 'active').eq('expires_at', date);
      if (error) throw error;
      return data || [];
    },

    // ─── system_overtime_settings ─────
    async getSystemOvertimeSettings() {
      const { data, error } = await supabaseAdmin
        .from('system_overtime_settings').select('*').eq('id', 1).maybeSingle();
      if (error) throw error;
      return data || null;
    },

    // ─── 員工時薪(expiry-sweep auto_payout 算金額用)─────
    async findEmployeeHourlyRate(employee_id) {
      // 粗估:salary_records.base_salary / monthly_work_hours_base
      const { data: settings } = await supabaseAdmin
        .from('system_overtime_settings').select('monthly_work_hours_base').eq('id', 1).maybeSingle();
      const base = Number(settings?.monthly_work_hours_base) || 240;
      const { data: sal } = await supabaseAdmin
        .from('salary_records').select('base_salary')
        .eq('employee_id', employee_id).order('year', { ascending: false })
        .order('month', { ascending: false }).limit(1).maybeSingle();
      const monthly = Number(sal?.base_salary) || 0;
      return base > 0 ? monthly / base : 0;
    },

    // 注意:Batch 6 原版有 applyToSalaryRecord method,Batch 9 重新設計後**移除**
    //      (改由 lib/salary/calculator.js + lib/salary/settlement.js 月底跑時讀
    //      comp_time_balance.expiry_payout_amount 加總到 salary_records.comp_expiry_payout)。

    // ─── 推播:補休失效預警(Batch 6 expiry-warning 用)──
    async notifyExpiryWarning({ employee_id, comp_id, expires_at, remaining_hours }) {
      // dynamic import 避免 lib/comp-time/* 在純函式 / test 時被 push.js side effect 影響
      try {
        const { sendPushToEmployees, createNotification } = await import('../../lib/push.js');
        const payload = {
          title: '補休即將失效',
          body:  `你的補休餘額 ${remaining_hours}h 將於 ${expires_at} 失效,請盡早申請使用`,
          url:   '/comp-time',
          tag:   `comp-expiry-${comp_id}`,
        };
        await Promise.allSettled([
          sendPushToEmployees([employee_id], payload),
          createNotification(employee_id, { ...payload, type: 'comp_expiry' }),
        ]);
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },

    // ─── employees(annual rollover 用)─────
    async findEmployeesWithAnniversaryToday(today) {
      // today: 'YYYY-MM-DD',匹配 annual_leave_seniority_start 月日
      const md = today.slice(5); // 'MM-DD'
      const { data, error } = await supabaseAdmin
        .from('employees')
        .select('id, name, annual_leave_seniority_start')
        .eq('status', 'active');
      if (error) throw error;
      return (data || []).filter(e =>
        e.annual_leave_seniority_start && e.annual_leave_seniority_start.slice(5) === md
      );
    },
  };
}
