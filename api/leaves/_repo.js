// api/leaves/_repo.js — supabase 注入式 repo for lib/leave/*
//
// 同時被 leaves/index.js / leaves/[id].js / annual-leaves/* / cron-annual-leave-rollover.js 共用。
// _ 前綴避免被當成 API route(Vercel 不會把 _xxx.js 當 endpoint)。

import { supabase } from '../../lib/supabase.js';

export function makeLeaveRepo() {
  return {
    nowIso() { return new Date().toISOString(); },

    // ─── leave_types ─────
    async findLeaveType(code) {
      const { data, error } = await supabase
        .from('leave_types').select('*').eq('code', code).maybeSingle();
      if (error) throw error;
      return data || null;
    },
    async listActiveLeaveTypes() {
      const { data, error } = await supabase
        .from('leave_types').select('*').eq('is_active', true).order('display_order');
      if (error) throw error;
      return data || [];
    },

    // ─── schedules ───────
    async findSchedulesInRange(employee_id, dateStart, dateEnd) {
      const { data, error } = await supabase
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
      const { data, error } = await supabase
        .from('annual_leave_records').select('*')
        .eq('employee_id', employee_id).eq('status', 'active')
        .order('period_start', { ascending: false }).limit(1).maybeSingle();
      if (error) throw error;
      return data || null;
    },

    async lockAndIncrementUsedDays({ record_id, delta_days, allow_negative = false, max_retries = 3 }) {
      // 樂觀鎖:UPDATE WHERE used_days = current_used_days,失敗則重試
      for (let attempt = 0; attempt < max_retries; attempt++) {
        const { data: cur } = await supabase
          .from('annual_leave_records').select('id, granted_days, used_days, status')
          .eq('id', record_id).maybeSingle();
        if (!cur) return { ok: false, reason: 'NOT_FOUND' };

        const granted = Number(cur.granted_days);
        const curUsed = Number(cur.used_days);
        const newUsed = curUsed + Number(delta_days);

        if (newUsed > granted + 1e-6) return { ok: false, reason: 'INSUFFICIENT_BALANCE' };
        if (newUsed < -1e-6 && !allow_negative) return { ok: false, reason: 'NEGATIVE_BALANCE' };

        const { data: updated, error } = await supabase
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
      const { data, error } = await supabase
        .from('annual_leave_records').insert([payload]).select().single();
      if (error) throw error;
      return data;
    },

    async updateAnnualRecord(id, patch) {
      const { remaining_days, ...rest } = patch;
      const { data, error } = await supabase
        .from('annual_leave_records').update({ ...rest, updated_at: new Date().toISOString() })
        .eq('id', id).select().maybeSingle();
      if (error) throw error;
      return data;
    },

    async listAnnualRecords({ employee_id, status }) {
      let q = supabase.from('annual_leave_records').select('*').order('period_start', { ascending: false });
      if (employee_id) q = q.eq('employee_id', employee_id);
      if (status)      q = q.eq('status', status);
      const { data, error } = await q;
      if (error) throw error;
      return data || [];
    },

    // ─── leave_balance_logs ──
    async insertBalanceLog(row) {
      const { data, error } = await supabase
        .from('leave_balance_logs').insert([row]).select().single();
      if (error) throw error;
      return data;
    },

    // ─── leave_requests ──────
    async insertLeaveRequest(row) {
      const { data, error } = await supabase
        .from('leave_requests').insert([row]).select().single();
      if (error) throw error;
      return data;
    },
    async findLeaveRequestById(id) {
      const { data, error } = await supabase
        .from('leave_requests').select('*').eq('id', id).maybeSingle();
      if (error) throw error;
      return data || null;
    },
    async updateLeaveRequest(id, patch) {
      const { data, error } = await supabase
        .from('leave_requests').update(patch).eq('id', id).select().maybeSingle();
      if (error) throw error;
      return data;
    },

    // ─── employees(annual rollover 用)─────
    async findEmployeesWithAnniversaryToday(today) {
      // today: 'YYYY-MM-DD',匹配 annual_leave_seniority_start 月日
      const md = today.slice(5); // 'MM-DD'
      const { data, error } = await supabase
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
