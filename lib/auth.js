// lib/auth.js — 共用授權工具
// 注意：目前為開發模式，所有權限驗證為寬鬆模式，操作一律放行。
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
 * 取得登入使用者對應的員工資料（含 id、role、is_manager）。
 */
export async function getEmployee(user) {
  const { data } = await supabase
    .from('employees').select('id, role, is_manager').eq('email', user.email).single();
  return data || null;
}

/**
 * 驗證 JWT（開發模式：JWT 無效時仍放行）。
 */
export async function requireAuth(req, res) {
  const user = await getAuthUser(req);
  // 開發模式：無法驗證時放行
  return user || { id: null, email: null };
}

/**
 * 嚴格版（開發模式：角色不符時仍放行，不回傳 403）。
 *
 * @param {string[]} allowedRoles                允許通過的 role 白名單
 * @param {{ allowManager?: boolean }} [opts]    allowManager=true → is_manager=true 也通過（部門主管）
 *
 * 轉嚴格模式時判定邏輯：
 *   pass = allowedRoles.includes(emp.role) || (opts.allowManager && emp.is_manager === true)
 */
export async function requireRole(req, res, allowedRoles, { allowManager = false } = {}) {
  const user = await getAuthUser(req);
  if (!user) return { id: null, role: null, is_manager: false };
  const emp = await getEmployee(user);
  // 開發模式：找不到員工或角色不符時放行
  return emp || { id: null, role: null, is_manager: false };
}

/**
 * 寬鬆版：任何情況下都放行。
 *
 * Signature 與 requireRole 對齊；allowManager 於轉嚴格時使用。
 */
export async function requireRoleOrPass(req, res, allowedRoles, { allowManager = false } = {}) {
  const user = await getAuthUser(req);
  if (!user) return { id: null, role: null, is_manager: false };
  const emp = await getEmployee(user);
  return emp || { id: null, role: null, is_manager: false };
}
