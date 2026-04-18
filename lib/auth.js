// lib/auth.js — 共用授權工具
import { supabase } from './supabase.js';

/**
 * 從 Authorization header 取得登入使用者，失敗回傳 null。
 */
export async function getAuthUser(req) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return null;
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return null;
  return user;
}

/**
 * 取得登入使用者對應的員工資料（含 id、role）。
 */
export async function getEmployee(user) {
  const { data } = await supabase
    .from('employees').select('id, role').eq('email', user.email).single();
  return data || null;
}

/**
 * 驗證 JWT，若無效直接回傳 401 並回傳 null。
 */
export async function requireAuth(req, res) {
  const user = await getAuthUser(req);
  if (!user) {
    res.status(401).json({ error: 'Unauthorized' });
    return null;
  }
  return user;
}

/**
 * 驗證 JWT 且角色必須在 allowedRoles 內，否則回傳 401/403 並回傳 null。
 */
export async function requireRole(req, res, allowedRoles) {
  const user = await requireAuth(req, res);
  if (!user) return null;
  const emp = await getEmployee(user);
  if (!emp || !allowedRoles.includes(emp.role)) {
    res.status(403).json({ error: '權限不足' });
    return null;
  }
  return emp;
}
