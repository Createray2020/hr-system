// api/expense-categories/_repo.js — supabase 注入式 repo for expense_categories CRUD
//
// 同時被 expense-categories/{index,[id]}.js 共用。
// _ 前綴避免被當成 API route(Vercel 不會把 _xxx.js 當 endpoint)。
//
// 對齊風格:api/attendance-penalties/_repo.js(no-param factory + 內部 import supabaseAdmin)

import { supabaseAdmin } from '../../lib/supabase.js';

export function makeExpenseCategoryRepo() {
  return {
    nowIso() { return new Date().toISOString(); },

    // ─── expense_categories ──────────────────────────────────
    async listCategories({ includeInactive } = {}) {
      let q = supabaseAdmin.from('expense_categories').select('*');
      if (!includeInactive) q = q.eq('is_active', true);
      q = q.order('sort_order', { ascending: true }).order('created_at', { ascending: true });
      const { data, error } = await q;
      if (error) throw error;
      return data || [];
    },

    async getCategory(id) {
      const { data, error } = await supabaseAdmin
        .from('expense_categories').select('*').eq('id', id).maybeSingle();
      if (error) throw error;
      return data || null;
    },

    // 對齊 lib/shift-types/handler.js:25-28 的「自動接末位」pattern
    async nextSortOrder() {
      const { data, error } = await supabaseAdmin
        .from('expense_categories').select('sort_order')
        .order('sort_order', { ascending: false }).limit(1);
      if (error) throw error;
      return (data?.[0]?.sort_order ?? 0) + 1;
    },

    async insertCategory(row) {
      const { data, error } = await supabaseAdmin
        .from('expense_categories').insert([row]).select().single();
      if (error) throw error;
      return data;
    },

    async updateCategory(id, patch) {
      const { data, error } = await supabaseAdmin
        .from('expense_categories').update(patch).eq('id', id).select().maybeSingle();
      if (error) throw error;
      return data;
    },

    // 引用計數:用於 DELETE 前的撞 FK 檢查
    async countEntriesUsing(id) {
      const { count, error } = await supabaseAdmin
        .from('salary_expense_entries')
        .select('id', { count: 'exact', head: true })
        .eq('category_id', id)
        .is('deleted_at', null);
      if (error) throw error;
      return count || 0;
    },

    async deleteCategory(id) {
      const { error } = await supabaseAdmin.from('expense_categories').delete().eq('id', id);
      if (error) throw error;
    },
  };
}
