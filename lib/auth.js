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
 *
 * 主要路徑：用 auth_user_id（uuid）反查（嚴格、可靠、永遠對得上）。
 *
 * Fallback：auth_user_id 找不到時改用 email 反查。這個 fallback 處理
 * 「舊員工 row 沒 backfill auth_user_id」的歷史包袱 —— 早期建立員工的流程
 * 沒寫入 auth_user_id 欄位、或新增員工時 supabase auth user 跟 employees row
 * 不同步的 case。找到後會自動寫回 auth_user_id,下次直接走快速路徑。
 *
 * 用 supabaseAdmin 是因為 employees 表上 RLS 後、anon 看不到別人的 row。
 *
 * 回傳含 id, role, is_manager, dept_id, manager_id, status。
 */
export async function getEmployee(user) {
  if (!user || !user.id) return null;

  let { data } = await supabaseAdmin
    .from('employees')
    .select('id, role, is_manager, dept_id, manager_id, status, auth_user_id')
    .eq('auth_user_id', user.id)
    .maybeSingle();

  // Fallback：auth_user_id 沒對到時用 email 找,並自我修復
  if (!data && user.email) {
    const r = await supabaseAdmin
      .from('employees')
      .select('id, role, is_manager, dept_id, manager_id, status, auth_user_id')
      .eq('email', user.email)
      .maybeSingle();
    if (r.data) {
      data = r.data;
      // 自我修復:寫回 auth_user_id,下次直接走快速路徑。
      // 失敗不影響本次回傳(盡力而為)。
      if (!data.auth_user_id) {
        try {
          await supabaseAdmin.from('employees')
            .update({ auth_user_id: user.id })
            .eq('id', data.id);
        } catch (_) { /* 自我修復失敗不影響本次認證結果 */ }
      }
    }
  }

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
