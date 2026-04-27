// api/overtime-requests/_repo.js — supabase 注入式 repo for lib/overtime/* + comp-conversion
//
// 同時被 overtime-requests/{index,[id]/manager-review,[id]/ceo-review,[id]/cancel}.js 共用。
// _ 前綴避免被當成 API route(Vercel 不會把 _xxx.js 當 endpoint)。
//
// 對應實作計畫:docs/attendance-system-implementation-plan-v1.md §9.6

import { supabaseAdmin } from '../../lib/supabase.js';

export function makeOvertimeRepo() {
  return {
    nowIso() { return new Date().toISOString(); },

    // ─── overtime_limits ─────────────────────────────────────
    async findActiveOvertimeLimits(employee_id, today) {
      // 先個人,後公司
      const { data: empRow } = await supabaseAdmin
        .from('overtime_limits').select('*')
        .eq('scope', 'employee').eq('employee_id', employee_id)
        .lte('effective_from', today)
        .or(`effective_to.is.null,effective_to.gte.${today}`)
        .order('effective_from', { ascending: false }).limit(1).maybeSingle();

      const { data: coRow } = await supabaseAdmin
        .from('overtime_limits').select('*')
        .eq('scope', 'company')
        .lte('effective_from', today)
        .or(`effective_to.is.null,effective_to.gte.${today}`)
        .order('effective_from', { ascending: false }).limit(1).maybeSingle();

      return { employee: empRow || null, company: coRow || null };
    },

    async listOvertimeLimits({ scope, employee_id }) {
      let q = supabaseAdmin.from('overtime_limits').select('*').order('effective_from', { ascending: false });
      if (scope) q = q.eq('scope', scope);
      if (employee_id) q = q.eq('employee_id', employee_id);
      const { data, error } = await q;
      if (error) throw error;
      return data || [];
    },

    async insertOvertimeLimit(row) {
      const { data, error } = await supabaseAdmin
        .from('overtime_limits').insert([row]).select().single();
      if (error) throw error;
      return data;
    },

    async updateOvertimeLimit(id, patch) {
      const { data, error } = await supabaseAdmin
        .from('overtime_limits').update({ ...patch, updated_at: new Date().toISOString() })
        .eq('id', id).select().maybeSingle();
      if (error) throw error;
      return data;
    },

    async deleteOvertimeLimit(id) {
      const { error } = await supabaseAdmin.from('overtime_limits').delete().eq('id', id);
      if (error) throw error;
    },

    async findOvertimeLimitById(id) {
      const { data, error } = await supabaseAdmin
        .from('overtime_limits').select('*').eq('id', id).maybeSingle();
      if (error) throw error;
      return data || null;
    },

    // ─── overtime_requests:歷史時數 (status='approved' 加總) ──
    async findOvertimeApprovedHours(employee_id, ranges) {
      // 一次撈出該員工該年所有 approved 然後 client side filter,避免多次 RTT
      const { data, error } = await supabaseAdmin
        .from('overtime_requests')
        .select('overtime_date, hours, status')
        .eq('employee_id', employee_id).eq('status', 'approved')
        .gte('overtime_date', ranges.yearStart).lte('overtime_date', ranges.yearEnd);
      if (error) throw error;

      let daily = 0, weekly = 0, monthly = 0, yearly = 0;
      for (const r of (data || [])) {
        const h = Number(r.hours);
        const d = String(r.overtime_date);
        if (d === ranges.day) daily += h;
        if (d >= ranges.weekStart  && d <= ranges.weekEnd)  weekly += h;
        if (d >= ranges.monthStart && d <= ranges.monthEnd) monthly += h;
        // year 已被 query 限縮
        yearly += h;
      }
      return { daily, weekly, monthly, yearly };
    },

    // ─── overtime_requests CRUD ──────────────────────────────
    async insertOvertimeRequest(row) {
      const { data, error } = await supabaseAdmin
        .from('overtime_requests').insert([row]).select().single();
      if (error) throw error;
      return data;
    },
    async findOvertimeRequestById(id) {
      const { data, error } = await supabaseAdmin
        .from('overtime_requests').select('*').eq('id', id).maybeSingle();
      if (error) throw error;
      return data || null;
    },
    async updateOvertimeRequest(id, patch) {
      const { data, error } = await supabaseAdmin
        .from('overtime_requests').update({ ...patch, updated_at: new Date().toISOString() })
        .eq('id', id).select().maybeSingle();
      if (error) throw error;
      return data;
    },
    async listOvertimeRequests({ employee_id, status, year, month, manager_id }) {
      let q = supabaseAdmin.from('overtime_requests').select('*').order('overtime_date', { ascending: false });
      if (employee_id) q = q.eq('employee_id', employee_id);
      if (status)      q = q.eq('status', status);
      if (year)        q = q.eq('applies_to_year', parseInt(year));
      if (month)       q = q.eq('applies_to_month', parseInt(month));
      const { data, error } = await q;
      if (error) throw error;
      let rows = data || [];
      if (manager_id) {
        // 撈該主管的下屬 ids,filter
        const { data: emps } = await supabaseAdmin
          .from('employees').select('id').eq('manager_id', manager_id);
        const subIds = new Set((emps || []).map(e => e.id));
        rows = rows.filter(r => subIds.has(r.employee_id));
      }
      return rows;
    },

    // ─── system_overtime_settings ─────
    async getSystemOvertimeSettings() {
      const { data, error } = await supabaseAdmin
        .from('system_overtime_settings').select('*').eq('id', 1).maybeSingle();
      if (error) throw error;
      return data || null;
    },

    // ─── holidays(查 pay_multiplier 凍結用)─────
    async findHolidayByDate(date) {
      const { data, error } = await supabaseAdmin
        .from('holidays').select('id, holiday_type, pay_multiplier')
        .eq('date', date).limit(1).maybeSingle();
      if (error) throw error;
      return data || null;
    },

    // ─── 員工資料(時薪計算用)─────
    async findEmployeeMonthlySalary(employee_id) {
      const { data, error } = await supabaseAdmin
        .from('salary_records').select('monthly_salary, year, month')
        .eq('employee_id', employee_id)
        .order('year', { ascending: false }).order('month', { ascending: false })
        .limit(1).maybeSingle();
      if (error) throw error;
      return data?.monthly_salary != null ? Number(data.monthly_salary) : 0;
    },

    async findEmployeeManager(employee_id) {
      const { data, error } = await supabaseAdmin
        .from('employees').select('id, manager_id, name').eq('id', employee_id).maybeSingle();
      if (error) throw error;
      return data || null;
    },

    // ─── comp-conversion 接通(grantCompTime 需要的 method 共用) ──
    // 直接 import lib/comp-time/balance.js 的 grantCompTime,本檔提供 supabase 實作:
    async insertCompBalance(row) {
      const { remaining_hours, ...payload } = row;
      const { data, error } = await supabaseAdmin
        .from('comp_time_balance').insert([payload]).select().single();
      if (error) throw error;
      return data;
    },
    async insertBalanceLog(row) {
      const { data, error } = await supabaseAdmin
        .from('leave_balance_logs').insert([row]).select().single();
      if (error) throw error;
      return data;
    },
    async updateOvertimeCompBalanceId(request_id, comp_balance_id) {
      const { data, error } = await supabaseAdmin
        .from('overtime_requests').update({
          comp_balance_id, updated_at: new Date().toISOString(),
        }).eq('id', request_id).select().maybeSingle();
      if (error) throw error;
      return data;
    },
  };
}
