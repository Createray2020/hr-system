// api/leave-types/_repo.js — supabase 注入式 repo for leave_types CRUD
//
// 同時被 leave-types/{index,[code]}.js 共用。
// _ 前綴避免被當成 API route(Vercel 不會把 _xxx.js 當 endpoint)。
//
// 對齊風格:api/expense-categories/_repo.js(no-param factory + 內部 import supabaseAdmin)

import { supabaseAdmin } from '../../lib/supabase.js';

export function makeLeaveTypeRepo() {
  return {
    nowIso() { return new Date().toISOString(); },

    // ─── leave_types ────────────────────────────────────────
    async listAll() {
      const { data, error } = await supabaseAdmin
        .from('leave_types').select('*')
        .order('display_order', { ascending: true })
        .order('code',          { ascending: true });
      if (error) throw error;
      return data || [];
    },

    async getByCode(code) {
      const { data, error } = await supabaseAdmin
        .from('leave_types').select('*').eq('code', code).maybeSingle();
      if (error) throw error;
      return data || null;
    },

    async updateByCode(code, patch) {
      const { data, error } = await supabaseAdmin
        .from('leave_types').update(patch).eq('code', code).select().maybeSingle();
      if (error) throw error;
      return data;
    },

    // ─── leave_type_change_logs ─────────────────────────────
    // 一次 INSERT 多筆(同次 PATCH 改 N 欄寫 N 筆)、空陣列直接 noop。
    async insertChangeLogs(logs) {
      if (!logs || !logs.length) return [];
      const { data, error } = await supabaseAdmin
        .from('leave_type_change_logs').insert(logs).select();
      if (error) throw error;
      return data || [];
    },
  };
}
