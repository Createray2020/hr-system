// lib/supabase.js
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_ANON_KEY');
}

if (!supabaseServiceRoleKey) {
  throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY (required for server-side operations)');
}

/**
 * Anon client.
 * 給驗證 user JWT 用（auth.getUser）、不該用來讀寫業務表。
 * 業務表讀寫請用 supabaseAdmin。
 */
export const supabase = createClient(supabaseUrl, supabaseAnonKey);

/**
 * Service role client.
 * 繞過 RLS、有完整資料庫存取權。
 * 只在 server-side（api/ + lib/）使用、絕對不能進 client bundle。
 */
export const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});
