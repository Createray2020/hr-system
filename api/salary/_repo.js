// api/salary/_repo.js — supabase 注入式 repo for lib/salary/*
//
// 同時被 api/salary/{index,[id],recalculate}.js 共用。

import { supabaseAdmin } from '../../lib/supabase.js';
import { applyExcludeSystemAccountsQuery } from '../../lib/salary/system-accounts.js';

export function makeSalaryRepo() {
  return {
    nowIso() { return new Date().toISOString(); },

    // ─── employees ────────────────────────────────────────────
    async findEmployeeForSalary(id) {
      const { data, error } = await supabaseAdmin
        .from('employees')
        .select('id, name, base_salary, attendance_bonus, employment_type, manager_allowance, grade_allowance, dept_id, departments(name)')
        .eq('id', id).maybeSingle();
      if (error) throw error;
      return data || null;
    },

    async findEmployeeHourlyRate(employee_id) {
      const { data: settings } = await supabaseAdmin
        .from('system_overtime_settings').select('monthly_work_hours_base').eq('id', 1).maybeSingle();
      const base = Number(settings?.monthly_work_hours_base) || 240;
      const { data: emp } = await supabaseAdmin
        .from('employees').select('base_salary').eq('id', employee_id).maybeSingle();
      const monthly = Number(emp?.base_salary) || 0;
      return base > 0 ? monthly / base : 0;
    },

    async listActiveEmployees() {
      // 排除系統管理員 EMP_99999999(虛擬帳號、status=active 但不是真員工);
      // 真實 base_salary=0 的兼職員工(EMP_02xxx)保留不擋。
      let q = supabaseAdmin
        .from('employees').select('id, name, dept_id, departments(name), base_salary, attendance_bonus, employment_type')
        .eq('status', 'active');
      q = applyExcludeSystemAccountsQuery(q);
      const { data, error } = await q.order('id');
      if (error) throw error;
      return data || [];
    },

    // ─── salary_records ──────────────────────────────────────
    async findSalaryRecord(id) {
      const { data, error } = await supabaseAdmin
        .from('salary_records').select('*').eq('id', id).maybeSingle();
      if (error) throw error;
      return data || null;
    },

    async upsertSalaryRecord(row) {
      // GENERATED column 不能 INSERT/UPDATE
      const { gross_salary, net_salary, ...payload } = row;
      const { data, error } = await supabaseAdmin
        .from('salary_records')
        .upsert([{ ...payload, updated_at: new Date().toISOString() }], { onConflict: 'id' })
        .select().maybeSingle();
      if (error) throw error;
      return data;
    },

    async updateSalaryRecord(id, patch) {
      const { gross_salary, net_salary, ...rest } = patch;
      const { data, error } = await supabaseAdmin
        .from('salary_records').update({ ...rest, updated_at: new Date().toISOString() })
        .eq('id', id).select().maybeSingle();
      if (error) throw error;
      return data;
    },

    async listSalaryRecords({ year, month, employee_id, status }) {
      let q = supabaseAdmin.from('salary_records').select('*').order('employee_id');
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
      const { error } = await supabaseAdmin
        .from('overtime_requests')
        .update({ applied_to_salary_record_id: null, updated_at: new Date().toISOString() })
        .eq('applied_to_salary_record_id', salary_record_id);
      if (error) throw error;
    },

    async resetPenaltyRecordsMarkers(salary_record_id) {
      const { error } = await supabaseAdmin
        .from('attendance_penalty_records')
        .update({ salary_record_id: null, status: 'pending', updated_at: new Date().toISOString() })
        .eq('salary_record_id', salary_record_id);
      if (error) throw error;
    },

    // 階段 C3 補:HR DELETE salary_records 後、PG FK ON DELETE SET NULL 自動清 FK
    // 但 status 沒連動、仍是 'applied'。calculator 重跑時 findPendingPenaltyRecords
    // (filter status='pending') 撈不到 → 罰款被吞掉。
    // 此 method 補:該員工該月 status='applied' 且 salary_record_id IS NULL → 改 pending。
    async resetOrphanedPenaltyForMonth({ employee_id, year, month }) {
      const { error } = await supabaseAdmin
        .from('attendance_penalty_records')
        .update({ status: 'pending', updated_at: new Date().toISOString() })
        .eq('employee_id', employee_id)
        .eq('applies_to_year', year).eq('applies_to_month', month)
        .eq('status', 'applied')
        .is('salary_record_id', null);
      if (error) throw error;
    },

    // ─── attendance / holidays / leaves ──────────────────────
    async findAbsentDaysByEmployeeMonth({ employee_id, year, month }) {
      const start = `${year}-${String(month).padStart(2,'0')}-01`;
      const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
      const end   = `${year}-${String(month).padStart(2,'0')}-${String(lastDay).padStart(2,'0')}`;
      const { data, error } = await supabaseAdmin
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
      const { data, error } = await supabaseAdmin
        .from('holidays').select('id, date, holiday_type, pay_multiplier')
        .gte('date', start).lte('date', end);
      if (error) throw error;
      return data || [];
    },

    async findHolidayWorkAttendance({ employee_id, year, month }) {
      const start = `${year}-${String(month).padStart(2,'0')}-01`;
      const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
      const end   = `${year}-${String(month).padStart(2,'0')}-${String(lastDay).padStart(2,'0')}`;
      const { data, error } = await supabaseAdmin
        .from('attendance').select('id, work_date, work_hours, holiday_id')
        .eq('employee_id', employee_id).eq('is_holiday_work', true)
        .gte('work_date', start).lte('work_date', end);
      if (error) throw error;
      return data || [];
    },

    // attendance-bonus / lib/attendance/bonus.js 需要的
    async findPenaltyRecordsByEmployeeMonth({ employee_id, year, month }) {
      const { data, error } = await supabaseAdmin
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
      const { data: leaves, error } = await supabaseAdmin
        .from('leave_requests')
        .select('id, leave_type, hours, finalized_hours, days, start_at, end_at')
        .eq('employee_id', employee_id).eq('status', 'approved')
        .gte('start_at', start).lte('start_at', end);
      if (error) throw error;
      const types = [...new Set((leaves || []).map(l => l.leave_type))];
      if (!types.length) return [];
      const { data: lts } = await supabaseAdmin
        .from('leave_types').select('code, affects_attendance_bonus').in('code', types);
      const map = Object.fromEntries((lts || []).map(t => [t.code, t.affects_attendance_bonus]));
      return (leaves || []).map(l => ({ ...l, affects_attendance_bonus: map[l.leave_type] === true }));
    },

    // ─── overtime_requests ──────────────────────────────────
    async findApprovedOvertimePayRequests({ employee_id, year, month }) {
      const { data, error } = await supabaseAdmin
        .from('overtime_requests').select('*')
        .eq('employee_id', employee_id).eq('status', 'approved')
        .eq('compensation_type', 'overtime_pay')
        .eq('applies_to_year', year).eq('applies_to_month', month);
      if (error) throw error;
      return data || [];
    },

    async markOvertimeRequestApplied(id, salary_record_id) {
      const { error } = await supabaseAdmin
        .from('overtime_requests')
        .update({ applied_to_salary_record_id: salary_record_id, updated_at: new Date().toISOString() })
        .eq('id', id);
      if (error) throw error;
    },

    // ─── attendance_penalty_records ─────────────────────────
    async findPendingPenaltyRecords({ employee_id, year, month }) {
      const { data, error } = await supabaseAdmin
        .from('attendance_penalty_records').select('*')
        .eq('employee_id', employee_id)
        .eq('applies_to_year', year).eq('applies_to_month', month)
        .eq('status', 'pending');
      if (error) throw error;
      return data || [];
    },

    async markPenaltyRecordApplied(id, salary_record_id) {
      const { error } = await supabaseAdmin
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
      const { data, error } = await supabaseAdmin
        .from('annual_leave_records').select('*')
        .eq('employee_id', employee_id).eq('status', 'paid_out')
        .gte('settled_at', start).lte('settled_at', end);
      if (error) throw error;
      return (data || []).filter(r => r.settlement_amount == null || Number(r.settlement_amount) === 0);
    },

    async updateAnnualRecord(id, patch) {
      const { data, error } = await supabaseAdmin
        .from('annual_leave_records').update({ ...patch, updated_at: new Date().toISOString() })
        .eq('id', id).select().maybeSingle();
      if (error) throw error;
      return data;
    },

    async findCompBalancesForSettlement({ employee_id, year, month }) {
      const start = `${year}-${String(month).padStart(2,'0')}-01T00:00:00+08:00`;
      const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
      const end   = `${year}-${String(month).padStart(2,'0')}-${String(lastDay).padStart(2,'0')}T23:59:59+08:00`;
      const { data, error } = await supabaseAdmin
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
      const { data: rec } = await supabaseAdmin
        .from('salary_records').select('daily_wage_snapshot, base_salary').eq('id', id).maybeSingle();
      if (rec?.daily_wage_snapshot != null) return Number(rec.daily_wage_snapshot);
      if (rec?.base_salary != null) return Math.round((Number(rec.base_salary) / 22) * 100) / 100;
      return 0;
    },

    async getSystemOvertimeSettings() {
      const { data, error } = await supabaseAdmin
        .from('system_overtime_settings').select('*').eq('id', 1).maybeSingle();
      if (error) throw error;
      return data || null;
    },

    // ─── 階段 2.5.2 新增 ────────────────────────────────────
    // 撈員工的 insurance_settings 整筆(pension_wage / brackets / company_premium / voluntary_rate / dependents 等)
    async findEmployeeInsuranceSettings(employee_id) {
      const { data, error } = await supabaseAdmin
        .from('insurance_settings').select('*')
        .eq('employee_id', employee_id).maybeSingle();
      if (error) throw error;
      return data;
    },

    // 找 (year, month) 的 payroll_periods.id + status、給 calculator 寫入 row.payroll_period_id 用
    async findActivePayrollPeriod(year, month) {
      const { data, error } = await supabaseAdmin
        .from('payroll_periods').select('id, status')
        .eq('year', year).eq('month', month).maybeSingle();
      if (error) throw error;
      return data;
    },

    // 加總同年同 employee_id 月份 < monthLte 的 4 個 bonus_* 欄位
    // 給二代健保補充保費計算 ytdAccumulatedBonusBefore 用
    async findYtdAccumulatedBonusBefore({ employee_id, year, monthLte }) {
      const { data, error } = await supabaseAdmin
        .from('salary_records')
        .select('bonus_yearend, bonus_festival, bonus_performance, bonus_other')
        .eq('employee_id', employee_id).eq('year', year).lt('month', monthLte);
      if (error) throw error;
      let total = 0;
      for (const r of (data || [])) {
        total += Number(r.bonus_yearend)     || 0;
        total += Number(r.bonus_festival)    || 0;
        total += Number(r.bonus_performance) || 0;
        total += Number(r.bonus_other)       || 0;
      }
      return total;
    },

    // ─── 階段 2.5.3a 新增 ────────────────────────────────────
    // 撈某 period 下的所有 salary_records(給 reconcilePeriodStats 用)
    async findSalaryRecordsByPeriodId(periodId) {
      if (!periodId) return [];
      const { data, error } = await supabaseAdmin
        .from('salary_records')
        .select('id, employee_id, gross_salary, net_salary, employer_cost_labor, employer_cost_health, employer_cost_pension, employer_cost_occupational, employer_cost_employment, employer_cost_welfare')
        .eq('payroll_period_id', periodId);
      if (error) throw error;
      return data || [];
    },

    // 更新 payroll_periods 任意欄位(給 batch 跑完寫回 cache + status 用)
    async updatePayrollPeriod(periodId, patch) {
      const { data, error } = await supabaseAdmin
        .from('payroll_periods').update(patch).eq('id', periodId).select().maybeSingle();
      if (error) throw error;
      return data;
    },
  };
}
