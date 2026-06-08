// api/salary-expense-entries/_repo.js — salary_expense_entries CRUD repo
//
// Phase 6b:管理頁專用,讀寫 salary_expense_entries 子表。配合
// lib/salary/expense-cascade.js::reflectExpenseEntriesToSalary 一起用
// (寫子表 → call reflect → 失敗回滾)。
//
// 風格對齊 api/expense-categories/_repo.js:無參數 factory + 內部 import supabaseAdmin。

import { supabaseAdmin } from '../../lib/supabase.js';

export function makeSalaryExpenseEntryRepo() {
  return {
    nowIso() { return new Date().toISOString(); },

    // 回該員當期未軟刪全部 rows(active + voided 都要,給管理頁顯示完整歷史)。
    async list({ employee_id, year, month }) {
      const { data, error } = await supabaseAdmin
        .from('salary_expense_entries')
        .select('id, approval_request_id, employee_id, salary_record_id, ' +
                'target_year, target_month, category_id, category_name_snapshot, ' +
                'is_wage_snapshot, is_taxable_snapshot, amount, expense_date, ' +
                'description, settlement_mode, deferred_from, status, note, ' +
                'created_by, created_at, updated_at')
        .eq('employee_id', employee_id)
        .eq('target_year', year)
        .eq('target_month', month)
        .is('deleted_at', null)
        .order('created_at', { ascending: true });
      if (error) throw error;
      return data || [];
    },

    async getById(id) {
      const { data, error } = await supabaseAdmin
        .from('salary_expense_entries').select('*')
        .eq('id', id).is('deleted_at', null).maybeSingle();
      if (error) throw error;
      return data || null;
    },

    async getCategoryById(id) {
      const { data, error } = await supabaseAdmin
        .from('expense_categories')
        .select('id, name, is_wage, is_taxable, is_active')
        .eq('id', id).maybeSingle();
      if (error) throw error;
      return data || null;
    },

    async insert(row) {
      const { data, error } = await supabaseAdmin
        .from('salary_expense_entries').insert([row]).select().single();
      if (error) throw error;
      return data;
    },

    async update(id, patch) {
      const { data, error } = await supabaseAdmin
        .from('salary_expense_entries').update(patch).eq('id', id)
        .select().maybeSingle();
      if (error) throw error;
      return data;
    },

    // 硬刪(POST 失敗回滾用、不留 voided 孤兒)
    async hardDelete(id) {
      const { error } = await supabaseAdmin
        .from('salary_expense_entries').delete().eq('id', id);
      if (error) throw error;
    },
  };
}
