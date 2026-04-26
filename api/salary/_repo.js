// api/salary/_repo.js — supabase 注入式 repo for lib/salary/*
//
// 同時被 api/salary/{index,[id],recalculate}.js 共用。

import { supabase } from '../../lib/supabase.js';

export function makeSalaryRepo() {
  return {
    nowIso() { return new Date().toISOString(); },

    // ─── employees ────────────────────────────────────────────
    async findEmployeeForSalary(id) {
      const { data, error } = await supabase
        .from('employees')
        .select('id, name, base_salary, attendance_bonus, employment_type, manager_allowance, grade_allowance, dept')
        .eq('id', id).maybeSingle();
      if (error) throw error;
      return data || null;
    },

    async findEmployeeHourlyRate(employee_id) {
      const { data: settings } = await supabase
        .from('system_overtime_settings').select('monthly_work_hours_base').eq('id', 1).maybeSingle();
      const base = Number(settings?.monthly_work_hours_base) || 240;
      const { data: emp } = await supabase
        .from('employees').select('base_salary').eq('id', employee_id).maybeSingle();
      const monthly = Number(emp?.base_salary) || 0;
      return base > 0 ? monthly / base : 0;
    },

    async listActiveEmployees() {
      const { data, error } = await supabase
        .from('employees').select('id, name, dept, base_salary, attendance_bonus, employment_type')
        .eq('status', 'active').order('id');
      if (error) throw error;
      return data || [];
    },

    // ─── salary_records ──────────────────────────────────────
    async findSalaryRecord(id) {
      const { data, error } = await supabase
        .from('salary_records').select('*').eq('id', id).maybeSingle();
      if (error) throw error;
      return data || null;
    },

    async upsertSalaryRecord(row) {
      // GENERATED column 不能 INSERT/UPDATE
      const { gross_salary, net_salary, ...payload } = row;
      const { data, error } = await supabase
        .from('salary_records')
        .upsert([{ ...payload, updated_at: new Date().toISOString() }], { onConflict: 'id' })
        .select().maybeSingle();
      if (error) throw error;
      return data;
    },

    async updateSalaryRecord(id, patch) {
      const { gross_salary, net_salary, ...rest } = patch;
      const { data, error } = await supabase
        .from('salary_records').update({ ...rest, updated_at: new Date().toISOString() })
        .eq('id', id).select().maybeSingle();
      if (error) throw error;
      return data;
    },

    async listSalaryRecords({ year, month, employee_id, status }) {
      let q = supabase.from('salary_records').select('*').order('employee_id');
      if (year)        q = q.eq('year', parseInt(year));
      if (month)       q = q.eq('month', parseInt(month));
      if (employee_id) q = q.eq('employee_id', employee_id);
      if (status)      q = q.eq('status', status);
      const { data, error } = await q;
      if (error) throw error;
      return data || [];
    },

    // ─── 完整重算:reset child markers ──────────────────────
    async resetOvertimeMarkers(salary_record_id) {
      const { error } = await supabase
        .from('overtime_requests')
        .update({ applied_to_salary_record_id: null, updated_at: new Date().toISOString() })
        .eq('applied_to_salary_record_id', salary_record_id);
      if (error) throw error;
    },

    async resetPenaltyRecordsMarkers(salary_record_id) {
      const { error } = await supabase
        .from('attendance_penalty_records')
        .update({ salary_record_id: null, status: 'pending', updated_at: new Date().toISOString() })
        .eq('salary_record_id', salary_record_id);
      if (error) throw error;
    },

    // ─── attendance / holidays / leaves ──────────────────────
    async findAbsentDaysByEmployeeMonth({ employee_id, year, month }) {
      const start = `${year}-${String(month).padStart(2,'0')}-01`;
      const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
      const end   = `${year}-${String(month).padStart(2,'0')}-${String(lastDay).padStart(2,'0')}`;
      const { data, error } = await supabase
        .from('attendance').select('work_date')
        .eq('employee_id', employee_id).eq('status', 'absent')
        .gte('work_date', start).lte('work_date', end);
      if (error) throw error;
      const distinct = new Set((data || []).map(r => r.work_date));
      return distinct.size;
    },

    async findHolidaysByMonth(year, month) {
      const start = `${year}-${String(month).padStart(2,'0')}-01`;
      const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
      const end   = `${year}-${String(month).padStart(2,'0')}-${String(lastDay).padStart(2,'0')}`;
      const { data, error } = await supabase
        .from('holidays').select('id, date, holiday_type, pay_multiplier')
        .gte('date', start).lte('date', end);
      if (error) throw error;
      return data || [];
    },

    async findHolidayWorkAttendance({ employee_id, year, month }) {
      const start = `${year}-${String(month).padStart(2,'0')}-01`;
      const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
      const end   = `${year}-${String(month).padStart(2,'0')}-${String(lastDay).padStart(2,'0')}`;
      const { data, error } = await supabase
        .from('attendance').select('id, work_date, work_hours, holiday_id')
        .eq('employee_id', employee_id).eq('is_holiday_work', true)
        .gte('work_date', start).lte('work_date', end);
      if (error) throw error;
      return data || [];
    },

    // attendance-bonus / lib/attendance/bonus.js 需要的
    async findPenaltyRecordsByEmployeeMonth({ employee_id, year, month }) {
      const { data, error } = await supabase
        .from('attendance_penalty_records').select('*')
        .eq('employee_id', employee_id)
        .eq('applies_to_year', year).eq('applies_to_month', month);
      if (error) throw error;
      return data || [];
    },

    async findApprovedAttendanceBonusLeaves({ employee_id, year, month }) {
      const start = `${year}-${String(month).padStart(2,'0')}-01T00:00:00+08:00`;
      const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
      const end   = `${year}-${String(month).padStart(2,'0')}-${String(lastDay).padStart(2,'0')}T23:59:59+08:00`;
      const { data: leaves, error } = await supabase
        .from('leave_requests')
        .select('id, leave_type, hours, finalized_hours, days, start_at, end_at')
        .eq('employee_id', employee_id).eq('status', 'approved')
        .gte('start_at', start).lte('start_at', end);
      if (error) throw error;
      const types = [...new Set((leaves || []).map(l => l.leave_type))];
      if (!types.length) return [];
      const { data: lts } = await supabase
        .from('leave_types').select('code, affects_attendance_bonus').in('code', types);
      const map = Object.fromEntries((lts || []).map(t => [t.code, t.affects_attendance_bonus]));
      return (leaves || []).map(l => ({ ...l, affects_attendance_bonus: map[l.leave_type] === true }));
    },

    async getAbsentDayDeductionRate() {
      const today = new Date().toISOString().slice(0, 10);
      const { data } = await supabase
        .from('attendance_penalties').select('penalty_amount')
        .eq('is_active', true).eq('trigger_type', 'absent')
        .eq('penalty_type', 'deduct_attendance_bonus_pct')
        .lte('effective_from', today).limit(1).maybeSingle();
      if (!data || data.penalty_amount == null) return 0;
      const raw = Number(data.penalty_amount);
      return raw > 1 ? raw / 100 : raw;
    },

    // ─── overtime_requests ──────────────────────────────────
    async findApprovedOvertimePayRequests({ employee_id, year, month }) {
      const { data, error } = await supabase
        .from('overtime_requests').select('*')
        .eq('employee_id', employee_id).eq('status', 'approved')
        .eq('compensation_type', 'overtime_pay')
        .eq('applies_to_year', year).eq('applies_to_month', month);
      if (error) throw error;
      return data || [];
    },

    async markOvertimeRequestApplied(id, salary_record_id) {
      const { error } = await supabase
        .from('overtime_requests')
        .update({ applied_to_salary_record_id: salary_record_id, updated_at: new Date().toISOString() })
        .eq('id', id);
      if (error) throw error;
    },

    // ─── attendance_penalty_records ─────────────────────────
    async findPendingPenaltyRecords({ employee_id, year, month }) {
      const { data, error } = await supabase
        .from('attendance_penalty_records').select('*')
        .eq('employee_id', employee_id)
        .eq('applies_to_year', year).eq('applies_to_month', month)
        .eq('status', 'pending');
      if (error) throw error;
      return data || [];
    },

    async markPenaltyRecordApplied(id, salary_record_id) {
      const { error } = await supabase
        .from('attendance_penalty_records')
        .update({ salary_record_id, status: 'applied', updated_at: new Date().toISOString() })
        .eq('id', id);
      if (error) throw error;
    },

    // ─── settlement(annual + comp)────────────────────────
    async findAnnualRecordsForSettlement({ employee_id, year, month }) {
      const start = `${year}-${String(month).padStart(2,'0')}-01T00:00:00+08:00`;
      const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
      const end   = `${year}-${String(month).padStart(2,'0')}-${String(lastDay).padStart(2,'0')}T23:59:59+08:00`;
      // 找 status='paid_out' 且 settlement_amount IN (0, NULL) 且 settled_at 在該年月
      const { data, error } = await supabase
        .from('annual_leave_records').select('*')
        .eq('employee_id', employee_id).eq('status', 'paid_out')
        .gte('settled_at', start).lte('settled_at', end);
      if (error) throw error;
      return (data || []).filter(r => r.settlement_amount == null || Number(r.settlement_amount) === 0);
    },

    async updateAnnualRecord(id, patch) {
      const { data, error } = await supabase
        .from('annual_leave_records').update({ ...patch, updated_at: new Date().toISOString() })
        .eq('id', id).select().maybeSingle();
      if (error) throw error;
      return data;
    },

    async findCompBalancesForSettlement({ employee_id, year, month }) {
      const start = `${year}-${String(month).padStart(2,'0')}-01T00:00:00+08:00`;
      const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
      const end   = `${year}-${String(month).padStart(2,'0')}-${String(lastDay).padStart(2,'0')}T23:59:59+08:00`;
      const { data, error } = await supabase
        .from('comp_time_balance').select('*')
        .eq('employee_id', employee_id).eq('status', 'expired_paid')
        .gte('expiry_processed_at', start).lte('expiry_processed_at', end);
      if (error) throw error;
      return data || [];
    },

    async getDailyWageSnapshot({ employee_id, year, month }) {
      // 從 salary_records 拿已凍結的 daily_wage_snapshot;若沒 record(理論不會,calculator 主流程會先算)
      // 退而求其次:base_salary / 22 粗估
      const id = `S_${employee_id}_${year}_${String(month).padStart(2,'0')}`;
      const { data: rec } = await supabase
        .from('salary_records').select('daily_wage_snapshot, base_salary').eq('id', id).maybeSingle();
      if (rec?.daily_wage_snapshot != null) return Number(rec.daily_wage_snapshot);
      if (rec?.base_salary != null) return Math.round((Number(rec.base_salary) / 22) * 100) / 100;
      return 0;
    },

    async getSystemOvertimeSettings() {
      const { data, error } = await supabase
        .from('system_overtime_settings').select('*').eq('id', 1).maybeSingle();
      if (error) throw error;
      return data || null;
    },
  };
}
