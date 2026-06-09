// api/salary-grades/_repo.js — supabase 注入式 repo for salary_grade CRUD
//
// 同時被 salary-grades/{index,[id]}.js 共用。
// _ 前綴避免被當成 API route(Vercel 不會把 _xxx.js 當 endpoint)。
//
// 對齊風格:api/leave-types/_repo.js / api/expense-categories/_repo.js
//   (no-param factory + 內部 import supabaseAdmin)

import { supabaseAdmin } from '../../lib/supabase.js';

export function makeSalaryGradeRepo() {
  return {
    nowIso() { return new Date().toISOString(); },

    // ─── salary_grade ────────────────────────────────────────
    // ORDER BY grade(中文字典序,前端會用 GRADE_ORDER 重排成「一→二→三」)再 grade_level
    async listAll() {
      const { data, error } = await supabaseAdmin
        .from('salary_grade').select('*')
        .order('grade',       { ascending: true })
        .order('grade_level', { ascending: true });
      if (error) throw error;
      return data || [];
    },

    async getById(id) {
      const { data, error } = await supabaseAdmin
        .from('salary_grade').select('*').eq('id', id).maybeSingle();
      if (error) throw error;
      return data || null;
    },

    async updateById(id, patch) {
      const { data, error } = await supabaseAdmin
        .from('salary_grade').update(patch).eq('id', id).select().maybeSingle();
      if (error) throw error;
      return data;
    },

    // ─── salary_grade_change_logs ────────────────────────────
    // 一次 INSERT 多筆;空陣列 noop
    async insertChangeLogs(logs) {
      if (!logs || !logs.length) return [];
      const { data, error } = await supabaseAdmin
        .from('salary_grade_change_logs').insert(logs).select();
      if (error) throw error;
      return data || [];
    },
  };
}
