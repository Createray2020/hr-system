// api/salary/_repo.js — supabase 注入式 repo for lib/salary/*
//
// 同時被 api/salary/{index,[id],recalculate}.js 共用。

import { supabaseAdmin } from '../../lib/supabase.js';
import { applyExcludeSystemAccountsQuery } from '../../lib/salary/system-accounts.js';
import { getOvertimeHourlyBase } from '../../lib/overtime/pay-calc.js';

export function makeSalaryRepo() {
  return {
    nowIso() { return new Date().toISOString(); },

    // ─── employees ────────────────────────────────────────────
    async findEmployeeForSalary(id) {
      // 2026-06-04:加 status / resigned_at / resign_date 給 calculator 的離職月自行推導用
      // (修補「HR 直接標離職未走 approvals cascade、is_final_month 旗標沒寫」的 fail-mode)
      const { data, error } = await supabaseAdmin
        .from('employees')
        .select('id, name, base_salary, attendance_bonus, employment_type, manager_allowance, grade_allowance, dept_id, departments(name), status, resigned_at, resign_date')
        .eq('id', id).maybeSingle();
      if (error) throw error;
      return data || null;
    },

    async findEmployeeHourlyRate(employee_id) {
      // 給 calculator step 8 holiday_work_pay + lib/comp-time/expiry-sweep auto_payout 用。
      // 對齊勞基法 §2-4(平日每小時工資額含經常性給付):走 lib canonical
      // getOvertimeHourlyBase,part_time 用 employees.hourly_rate(已是含經常性的全價),
      // full_time 用 base + attendance_bonus + grade_allowance + manager_allowance + extra_allowance。
      const { data: emp } = await supabaseAdmin
        .from('employees')
        .select('employment_type, hourly_rate, base_salary, attendance_bonus, grade_allowance, manager_allowance, extra_allowance')
        .eq('id', employee_id).maybeSingle();
      const { data: settings } = await supabaseAdmin
        .from('system_overtime_settings').select('monthly_work_hours_base').eq('id', 1).maybeSingle();
      const base = Number(settings?.monthly_work_hours_base) || 240;
      return getOvertimeHourlyBase(emp, base);
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

    // B26 批次 3:batch_v2 走 active + 該月離職員工(讓離職員工最後月薪 batch 撈得到)
    // 用兩條 query Promise.all merge(避開 supabase-js .or + and() nested syntax 不穩)
    // 2026-06:加 hire_date 過濾,排除「入職日晚於結算月」的員工
    //         (例:范峯羽 hire_date=2026-06-02 不該出現在 2026-05 月結)
    async listEmployeesForPayroll(year, month) {
      const periodStart = `${year}-${String(month).padStart(2, '0')}-01T00:00:00+08:00`;
      const nextYear = month === 12 ? year + 1 : year;
      const nextMonth = month === 12 ? 1 : month + 1;
      const periodEnd = `${nextYear}-${String(nextMonth).padStart(2, '0')}-01T00:00:00+08:00`;
      // 結算月最後一天(YYYY-MM-DD),用來排除「入職日晚於結算月」的員工
      const lastDayOfMonth = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);

      const SELECT_COLS = 'id, name, dept_id, departments(name), base_salary, attendance_bonus, employment_type, hire_date';
      const q1 = supabaseAdmin.from('employees').select(SELECT_COLS).eq('status', 'active');
      const q2 = supabaseAdmin.from('employees').select(SELECT_COLS)
        .eq('status', 'resigned').gte('resigned_at', periodStart).lt('resigned_at', periodEnd);

      const [active, resigned] = await Promise.all([
        applyExcludeSystemAccountsQuery(q1).order('id'),
        applyExcludeSystemAccountsQuery(q2).order('id'),
      ]);
      if (active.error) throw active.error;
      if (resigned.error) throw resigned.error;

      // 只納入「結算月當月或更早入職」的在職員工;hire_date 為 null 的舊資料一律保留
      const activeHired = (active.data || []).filter(e => !e.hire_date || e.hire_date <= lastDayOfMonth);
      return [...activeHired, ...(resigned.data || [])];
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

    // 兼職時薪制專用:當月計薪基本工時加總(平日上班、不含 holiday)。
    // status 白名單 = ['normal','late','early_leave'];排除 absent / leave / holiday。
    // 🔴 每日上限 8 小時:每筆 work_hours 用 Math.min(h, 8) cap、超過 8h 屬加班,
    //    需另經核准加班申請(overtime_requests status='approved')才計加班費、
    //    不自動從 attendance 換算加班(Step 6 aggregateOvertimePay 只認核准申請)。
    // holiday_work_pay 在 Step 8 用「全額算法」(multiplier 2.0 = 含基本 1 倍 + 加成 1 倍)
    // 另行計算,本 helper 不重複算 holiday、避免重複給薪。
    async findTotalWorkHoursByEmployeeMonth(employee_id, year, month) {
      const start = `${year}-${String(month).padStart(2,'0')}-01`;
      const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
      const end   = `${year}-${String(month).padStart(2,'0')}-${String(lastDay).padStart(2,'0')}`;
      const { data, error } = await supabaseAdmin
        .from('attendance').select('work_hours')
        .eq('employee_id', employee_id)
        .gte('work_date', start).lte('work_date', end)
        .in('status', ['normal', 'late', 'early_leave'])
        .not('work_hours', 'is', null);
      if (error) throw error;
      return (data || []).reduce(
        (sum, r) => sum + Math.min(Number(r.work_hours) || 0, 8),
        0,
      );
    },

    // 夜間津貼:撈當月排班、過 confirmed/locked + 排除 is_off shift。
    // night_eligible 解析:schedule.night_eligible_override ?? shift_types.night_allowance_eligible
    //   - override = true → 強制 eligible
    //   - override = false → 強制 not eligible
    //   - override = null → 依 shift_types 預設(晚班/夜班 = true、日班/中班 = false)
    async findNightShiftSchedulesByMonth(employee_id, year, month) {
      const start = `${year}-${String(month).padStart(2,'0')}-01`;
      const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
      const end = `${year}-${String(month).padStart(2,'0')}-${String(lastDay).padStart(2,'0')}`;
      const { data, error } = await supabaseAdmin
        .from('schedules')
        .select('work_date, scheduled_work_minutes, segment_no, status, night_eligible_override, shift_types(night_allowance_eligible, is_off)')
        .eq('employee_id', employee_id)
        .gte('work_date', start).lte('work_date', end)
        .in('status', ['confirmed', 'locked']);
      if (error) throw error;
      return (data || [])
        .filter(s => !s.shift_types?.is_off)
        .map(s => {
          const ovr = s.night_eligible_override;
          const night_eligible = ovr === true ? true
            : ovr === false ? false
            : !!s.shift_types?.night_allowance_eligible;
          return { work_date: s.work_date, night_eligible, scheduled_work_minutes: s.scheduled_work_minutes };
        });
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

    // ─── salary_expense_entries(請款核準後併薪、Phase 3)─────
    // 讀 entry 自身 snapshot 欄(category_name_snapshot / is_taxable_snapshot)、
    // 不 join expense_categories — 類別未來改名 / 改稅性 不會回溯影響已寫入薪資。
    // 子表為 SoT;calculator Step 12.5 每次重算都從這裡 reduce 重建 3 個 _auto 欄。
    async fetchExpenseEntries({ employee_id, year, month }) {
      const { data, error } = await supabaseAdmin
        .from('salary_expense_entries')
        .select('id, amount, category_name_snapshot, is_taxable_snapshot')
        .eq('employee_id', employee_id)
        .eq('target_year', year)
        .eq('target_month', month)
        .eq('status', 'active')
        .is('deleted_at', null);
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
        .is('deleted_at', null)
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

    // B26 批次 4:離職月專用,撈不限 month 的 paid_out annual records(已由 cascade #4 寫 settlement_amount)
    // 對齊修正 1:避免「離職在 5/31 但 HR 6/2 簽完 cascade」settled_at month 跟 resigned_at month 不對齊撈不到
    async findAllPaidOutAnnualForEmployee(employee_id) {
      const { data, error } = await supabaseAdmin
        .from('annual_leave_records').select('*')
        .eq('employee_id', employee_id).eq('status', 'paid_out')
        .gt('settlement_amount', 0);
      if (error) throw error;
      return data || [];
    },

    // B26 批次 4:離職月專用,撈不限 month 的 expired_paid comp records(已由 cascade #5 寫 expiry_payout_amount)
    async findAllExpiredPaidCompForEmployee(employee_id) {
      const { data, error } = await supabaseAdmin
        .from('comp_time_balance').select('*')
        .eq('employee_id', employee_id).eq('status', 'expired_paid')
        .gt('expiry_payout_amount', 0);
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

    // Phase 3A:撈在 asOfDate 生效中的費率參數,回 Map<"category:parameter_name", Number>。
    // 選版邏輯:
    //   - WHERE effective_from <= asOfDate AND (effective_to IS NULL OR effective_to >= asOfDate)
    //   - 同 (category, parameter_name) 可能撈到多 row(舊 effective_to 未及時截斷),
    //     JS 端用 effective_from desc 排序後第一筆取勝(等同 SQL DISTINCT ON 的效果)
    //   - 失敗 / 表不存在:return new Map()(caller 端 fallback 到 hardcoded const)
    async getEffectiveParameters(asOfDate) {
      if (!asOfDate) return new Map();
      try {
        const { data, error } = await supabaseAdmin
          .from('salary_parameter_definitions')
          .select('category, parameter_name, parameter_value, effective_from, effective_to')
          .lte('effective_from', asOfDate)
          .or(`effective_to.is.null,effective_to.gte.${asOfDate}`)
          .order('effective_from', { ascending: false });
        if (error) {
          // 表不存在 / 連不到 → fallback 空 Map(caller 走 hardcoded const)
          console.warn('[getEffectiveParameters] supabase error, falling back to empty map:', error.message);
          return new Map();
        }
        const m = new Map();
        for (const row of (data || [])) {
          const key = `${row.category}:${row.parameter_name}`;
          if (!m.has(key)) m.set(key, Number(row.parameter_value));
        }
        return m;
      } catch (e) {
        console.warn('[getEffectiveParameters] threw, falling back to empty map:', e.message);
        return new Map();
      }
    },
  };
}
