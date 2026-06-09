// api/salary-parameters/_repo.js — supabase 注入式 repo for salary_parameter_definitions
//
// 同時被 salary-parameters/{index,[id]}.js 共用。
// _ 前綴避免被當成 API route(Vercel 不會把 _xxx.js 當 endpoint)。
//
// 對齊風格:api/expense-categories/_repo.js / api/leave-types/_repo.js
//   (no-param factory + 內部 import supabaseAdmin)

import { supabaseAdmin } from '../../lib/supabase.js';

export function makeSalaryParameterRepo() {
  return {
    nowIso() { return new Date().toISOString(); },

    // ─── 全部列表(含歷史版本)──────────────────────────────
    async listAll() {
      const { data, error } = await supabaseAdmin
        .from('salary_parameter_definitions').select('*')
        .order('category',       { ascending: true  })
        .order('parameter_name', { ascending: true  })
        .order('effective_from', { ascending: false });
      if (error) throw error;
      return data || [];
    },

    async getById(id) {
      const { data, error } = await supabaseAdmin
        .from('salary_parameter_definitions').select('*').eq('id', id).maybeSingle();
      if (error) throw error;
      return data || null;
    },

    // 找該 (category, parameter_name) 目前 effective_to IS NULL 的當前版本
    async findCurrentVersion(category, parameter_name) {
      const { data, error } = await supabaseAdmin
        .from('salary_parameter_definitions').select('*')
        .eq('category', category).eq('parameter_name', parameter_name)
        .is('effective_to', null)
        .order('effective_from', { ascending: false })
        .limit(1).maybeSingle();
      if (error) throw error;
      return data || null;
    },

    async insertRow(row) {
      const { data, error } = await supabaseAdmin
        .from('salary_parameter_definitions').insert([row]).select().single();
      if (error) throw error;
      return data;
    },

    async updateRow(id, patch) {
      const { data, error } = await supabaseAdmin
        .from('salary_parameter_definitions').update(patch).eq('id', id).select().maybeSingle();
      if (error) throw error;
      return data;
    },
  };
}
