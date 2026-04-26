// api/attendance-penalties/_repo.js — supabase 注入式 repo for lib/attendance/{penalty,bonus,rate}.js
//
// 同時被 attendance-penalties/{index,[id]}.js + attendance-penalty-records/{index,[id]/waive}.js 共用。
// _ 前綴避免被當成 API route。

import { supabase } from '../../lib/supabase.js';

export function makeAttendancePenaltyRepo() {
  return {
    nowIso() { return new Date().toISOString(); },

    // ─── attendance_penalties (rules) ────────────────────────
    async findActivePenaltyRules({ trigger_type, on_date }) {
      let q = supabase.from('attendance_penalties').select('*')
        .eq('is_active', true)
        .lte('effective_from', on_date)
        .or(`effective_to.is.null,effective_to.gte.${on_date}`)
        .order('threshold_minutes_min', { ascending: true });
      if (trigger_type) q = q.eq('trigger_type', trigger_type);
      const { data, error } = await q;
      if (error) throw error;
      return data || [];
    },

    async listPenalties({ trigger_type, is_active }) {
      let q = supabase.from('attendance_penalties').select('*')
        .order('trigger_type').order('display_order').order('threshold_minutes_min');
      if (trigger_type) q = q.eq('trigger_type', trigger_type);
      if (is_active !== undefined) q = q.eq('is_active', is_active === true || is_active === 'true');
      const { data, error } = await q;
      if (error) throw error;
      return data || [];
    },

    async findPenaltyById(id) {
      const { data, error } = await supabase
        .from('attendance_penalties').select('*').eq('id', id).maybeSingle();
      if (error) throw error;
      return data || null;
    },

    async insertPenalty(row) {
      const { data, error } = await supabase
        .from('attendance_penalties').insert([row]).select().single();
      if (error) throw error;
      return data;
    },

    async updatePenalty(id, patch) {
      const { data, error } = await supabase
        .from('attendance_penalties').update({ ...patch, updated_at: new Date().toISOString() })
        .eq('id', id).select().maybeSingle();
      if (error) throw error;
      return data;
    },

    async deletePenalty(id) {
      const { error } = await supabase.from('attendance_penalties').delete().eq('id', id);
      if (error) throw error;
    },

    // ─── attendance_penalty_records ──────────────────────────
    async insertPenaltyRecord(row) {
      const { data, error } = await supabase
        .from('attendance_penalty_records').insert([row]).select().single();
      if (error) throw error;
      return data;
    },

    async listPenaltyRecords({ employee_id, year, month, status }) {
      let q = supabase.from('attendance_penalty_records').select('*')
        .order('applies_to_year', { ascending: false })
        .order('applies_to_month', { ascending: false })
        .order('id', { ascending: false });
      if (employee_id) q = q.eq('employee_id', employee_id);
      if (year)        q = q.eq('applies_to_year',  parseInt(year));
      if (month)       q = q.eq('applies_to_month', parseInt(month));
      if (status)      q = q.eq('status', status);
      const { data, error } = await q;
      if (error) throw error;
      return data || [];
    },

    async findPenaltyRecordById(id) {
      const { data, error } = await supabase
        .from('attendance_penalty_records').select('*').eq('id', id).maybeSingle();
      if (error) throw error;
      return data || null;
    },

    async updatePenaltyRecord(id, patch) {
      const { data, error } = await supabase
        .from('attendance_penalty_records').update({ ...patch, updated_at: new Date().toISOString() })
        .eq('id', id).select().maybeSingle();
      if (error) throw error;
      return data;
    },

    async findPenaltyRecordsByEmployeeMonth({ employee_id, year, month }) {
      const { data, error } = await supabase
        .from('attendance_penalty_records').select('*')
        .eq('employee_id', employee_id)
        .eq('applies_to_year', year).eq('applies_to_month', month);
      if (error) throw error;
      return data || [];
    },

    async countMonthlyTriggerEvents({ employee_id, year, month, trigger_type }) {
      // 算當月該員工該 trigger_type 已發生的次數(從 attendance 表算 status 對應)
      const triggerStatusMap = { late: 'late', early_leave: 'early_leave', absent: 'absent' };
      const status = triggerStatusMap[trigger_type];
      if (!status) return 0;
      const start = `${year}-${String(month).padStart(2,'0')}-01`;
      const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
      const end   = `${year}-${String(month).padStart(2,'0')}-${String(lastDay).padStart(2,'0')}`;
      const { data, error } = await supabase
        .from('attendance').select('work_date, status', { count: 'exact', head: false })
        .eq('employee_id', employee_id).eq('status', status)
        .gte('work_date', start).lte('work_date', end);
      if (error) throw error;
      return (data || []).length;
    },

    // ─── bonus / rate 用 ────────────────────────────────────
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
        .from('leave_types').select('code, affects_attendance_bonus, affects_attendance_rate').in('code', types);
      const bonusMap = Object.fromEntries((lts || []).map(t => [t.code, t.affects_attendance_bonus]));
      return (leaves || []).map(l => ({
        ...l,
        affects_attendance_bonus: bonusMap[l.leave_type] === true,
      }));
    },

    async findApprovedLeavesByEmployeeMonth({ employee_id, year, month }) {
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
        .from('leave_types').select('code, affects_attendance_rate').in('code', types);
      const rateMap = Object.fromEntries((lts || []).map(t => [t.code, t.affects_attendance_rate]));
      return (leaves || []).map(l => ({ ...l, affects_attendance_rate: rateMap[l.leave_type] !== false }));
    },

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

    async getAbsentDayDeductionRate() {
      // 從 attendance_penalties 中 trigger_type='absent' 且 penalty_type='deduct_attendance_bonus_pct'
      // 的活躍規則讀 penalty_amount(視為比例)
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

    async findAttendanceByEmployeeMonth({ employee_id, year, month }) {
      const start = `${year}-${String(month).padStart(2,'0')}-01`;
      const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
      const end   = `${year}-${String(month).padStart(2,'0')}-${String(lastDay).padStart(2,'0')}`;
      const { data, error } = await supabase
        .from('attendance').select('*')
        .eq('employee_id', employee_id)
        .gte('work_date', start).lte('work_date', end);
      if (error) throw error;
      return data || [];
    },

    async findHolidaysByMonth(year, month) {
      const start = `${year}-${String(month).padStart(2,'0')}-01`;
      const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
      const end   = `${year}-${String(month).padStart(2,'0')}-${String(lastDay).padStart(2,'0')}`;
      const { data, error } = await supabase
        .from('holidays').select('date, holiday_type')
        .gte('date', start).lte('date', end);
      if (error) throw error;
      return data || [];
    },
  };
}
