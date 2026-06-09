// api/leave-overview/_repo.js — supabase 注入式 repo for 請假總覽管理頁(Phase 2 #3)
//
// 對齊 leave-types / salary-grades / salary-grade-audit 風格(no-param factory + 內部 import supabaseAdmin)。
//
// 唯讀 listForMonth / 看 row 用 getById / 寫 update + 寫 logs。**不動 status / 不動審核欄位**(由 PATCH endpoint 白名單守)。

import { supabaseAdmin } from '../../lib/supabase.js';

export function makeLeaveOverviewRepo() {
  return {
    nowIso() { return new Date().toISOString(); },

    // 月份重疊查詢:start_date <= 月末 AND end_date >= 月初 AND deleted_at IS NULL
    // 同時 join leave_types 取 name_zh / pay_rate / is_paid
    async listForMonth({ monthStart, monthEnd }) {
      const { data, error } = await supabaseAdmin
        .from('leave_requests')
        .select(`
          id, employee_id, leave_type, start_date, end_date, start_at, end_at,
          days, hours, finalized_hours,
          status, reason, admin_audit_note, handler_note, created_at,
          leave_types ( name_zh, pay_rate, is_paid, has_balance )
        `)
        .is('deleted_at', null)
        .lte('start_date', monthEnd)
        .gte('end_date',   monthStart)
        .order('employee_id').order('start_date');
      if (error) throw error;
      return data || [];
    },

    async listEmployeesByIds(ids) {
      if (!ids?.length) return [];
      const { data, error } = await supabaseAdmin
        .from('employees')
        .select('id, name, dept_id, status, employment_type')
        .in('id', ids);
      if (error) throw error;
      return data || [];
    },

    async listDepartments() {
      const { data, error } = await supabaseAdmin
        .from('departments').select('id, name');
      if (error) throw error;
      return data || [];
    },

    async listLeaveTypes() {
      const { data, error } = await supabaseAdmin
        .from('leave_types')
        .select('code, name_zh, pay_rate, is_paid, has_balance, is_active, display_order')
        .order('display_order').order('code');
      if (error) throw error;
      return data || [];
    },

    async getById(id) {
      const { data, error } = await supabaseAdmin
        .from('leave_requests').select('*').is('deleted_at', null)
        .eq('id', id).maybeSingle();
      if (error) throw error;
      return data || null;
    },

    async getLeaveType(code) {
      const { data, error } = await supabaseAdmin
        .from('leave_types')
        .select('code, name_zh, has_balance, pay_rate, is_paid')
        .eq('code', code).maybeSingle();
      if (error) throw error;
      return data || null;
    },

    async updateLeaveRequest(id, patch) {
      const { data, error } = await supabaseAdmin
        .from('leave_requests').update(patch).eq('id', id).select().maybeSingle();
      if (error) throw error;
      return data;
    },

    async insertChangeLogs(logs) {
      if (!logs?.length) return [];
      const { data, error } = await supabaseAdmin
        .from('leave_request_change_logs').insert(logs).select();
      if (error) throw error;
      return data || [];
    },
  };
}
