// api/salary-grade-audit/_repo.js — supabase 注入式 repo for 職等↔薪資稽核
//
// 唯讀(只 SELECT、無 UPDATE/INSERT)、對齊 leave-types / salary-grades 風格。

import { supabaseAdmin } from '../../lib/supabase.js';
import { applyExcludeSystemAccountsQuery } from '../../lib/salary/system-accounts.js';

export function makeGradeAuditRepo() {
  return {
    async listActiveEmployees() {
      const q = supabaseAdmin
        .from('employees')
        .select('id, name, grade, grade_level, base_salary, attendance_bonus, grade_allowance, manager_allowance, extra_allowance, hourly_rate, is_manager, employment_type, status, dept_id, position')
        .eq('status', 'active');
      const { data, error } = await applyExcludeSystemAccountsQuery(q)
        .order('grade', { ascending: true })
        .order('grade_level', { ascending: true })
        .order('id', { ascending: true });
      if (error) throw error;
      return data || [];
    },

    async listAllGrades() {
      const { data, error } = await supabaseAdmin
        .from('salary_grade').select('*')
        .order('grade').order('grade_level');
      if (error) throw error;
      return data || [];
    },

    async listDepartments() {
      const { data, error } = await supabaseAdmin
        .from('departments').select('id, name');
      if (error) throw error;
      return data || [];
    },
  };
}
