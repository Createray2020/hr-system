// lib/auth.js — 共用授權工具（嚴格模式）
import { supabase, supabaseAdmin } from './supabase.js';

/**
 * 從 Authorization header 取得登入使用者，失敗回傳 null。
 * 用 anon client + token、走 Supabase Auth 驗證。
 */
export async function getAuthUser(req) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return null;
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return null;
  return user;
}

/**
 * 取得登入使用者對應的員工資料。
 * 用 auth_user_id（uuid）反查、不用 email。
 * 回傳含 id, role, is_manager, dept_id, manager_id, status。
 * 用 supabaseAdmin 是因為 employees 表上 RLS 後、anon 看不到別人的 row。
 */
export async function getEmployee(user) {
  if (!user || !user.id) return null;
  const { data } = await supabaseAdmin
    .from('employees')
    .select('id, role, is_manager, dept_id, manager_id, status')
    .eq('auth_user_id', user.id)
    .maybeSingle();
  if (!data) return null;
  if (data.status !== 'active') return null;
  return data;
}

/**
 * 驗證 JWT、未登入回 401。
 * 回傳 caller object 或 null。null 時 res 已寫了 401、handler 應 return。
 */
export async function requireAuth(req, res) {
  const user = await getAuthUser(req);
  if (!user) {
    res.status(401).json({ error: 'Unauthorized: missing or invalid token' });
    return null;
  }
  const emp = await getEmployee(user);
  if (!emp) {
    res.status(401).json({ error: 'Unauthorized: no active employee record' });
    return null;
  }
  return emp;
}

/**
 * 驗證 JWT + role 白名單、role 不符回 403。
 * 回傳 caller object 或 null。null 時 res 已寫了 401/403、handler 應 return。
 *
 * @param {string[]} allowedRoles - 允許通過的 role 白名單
 * @param {{ allowManager?: boolean }} [opts] - allowManager=true → is_manager=true 也通過
 */
export async function requireRole(req, res, allowedRoles, { allowManager = false } = {}) {
  const caller = await requireAuth(req, res);
  if (!caller) return null;

  const passByRole = allowedRoles.includes(caller.role);
  const passByManager = allowManager && caller.is_manager === true;

  if (!passByRole && !passByManager) {
    res.status(403).json({ error: 'Forbidden: insufficient role' });
    return null;
  }
  return caller;
}

// requireRoleOrPass 已刪除。改用 requireAuth（不限 role）或 requireRole（限定 role）。
