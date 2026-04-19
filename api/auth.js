// api/auth.js — 密碼管理（合併自 change-password + reset-password）
// POST /api/auth?action=change-password  → 員工修改自己密碼
// POST /api/auth?action=reset-password   → 管理員重設員工密碼
import { createClient } from '@supabase/supabase-js';

const ALLOWED_ADMIN_ROLES = ['hr', 'chairman', 'admin'];

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action } = req.query;

  // ── change-password ────────────────────────────────────────────────────────
  if (action === 'change-password') {
    const { emp_no, old_password, new_password } = req.body || {};

    if (!emp_no || !old_password || !new_password)
      return res.status(400).json({ error: '缺少必要參數' });
    if (new_password.length < 6)
      return res.status(400).json({ error: '新密碼至少需要 6 個字元' });

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
    const email = emp_no + '@chuwa.hr';

    // Step 1: verify old password
    const { data: signInData, error: signInErr } = await supabase.auth.signInWithPassword({
      email, password: old_password,
    });
    if (signInErr || !signInData.session)
      return res.status(401).json({ error: '目前密碼不正確' });

    // Step 2: update with authenticated session
    const authClient = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_ANON_KEY,
      { global: { headers: { Authorization: `Bearer ${signInData.session.access_token}` } } }
    );
    const { error: updateErr } = await authClient.auth.updateUser({ password: new_password });
    if (updateErr)
      return res.status(500).json({ error: '密碼更新失敗：' + updateErr.message });

    return res.status(200).json({ message: '密碼已更新，下次登入生效' });
  }

  // ── reset-password ─────────────────────────────────────────────────────────
  if (action === 'reset-password') {
    const { emp_no, new_password, admin_emp_no } = req.body || {};

    if (!emp_no || !new_password || !admin_emp_no)
      return res.status(400).json({ error: '缺少必要參數' });
    if (new_password.length < 6)
      return res.status(400).json({ error: '密碼至少需要 6 個字元' });

    const adminClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    // Step 1: verify admin role
    const { data: admin, error: adminErr } = await adminClient
      .from('employees').select('id, role, status').eq('emp_no', admin_emp_no).single();
    if (adminErr || !admin)
      return res.status(403).json({ error: '找不到管理員帳號' });
    if (!ALLOWED_ADMIN_ROLES.includes(admin.role))
      return res.status(403).json({ error: '權限不足，僅 HR 或董事長可重設密碼' });
    if (admin.status === 'resigned')
      return res.status(403).json({ error: '管理員帳號已停用' });

    // Step 2: find target employee
    const { data: emp, error: empErr } = await adminClient
      .from('employees').select('auth_user_id, name, emp_no').eq('emp_no', emp_no).single();
    if (empErr || !emp)
      return res.status(404).json({ error: '找不到此員工（員工編號：' + emp_no + '）' });

    // Step 3: resolve auth user id
    let userId = emp.auth_user_id;
    if (!userId) {
      const { data: { users } } = await adminClient.auth.admin.listUsers();
      const found = (users || []).find(u => u.email === emp_no + '@chuwa.hr');
      userId = found?.id || null;
    }
    if (!userId)
      return res.status(404).json({ error: '找不到此員工的登入帳號，請先建立 Auth 帳號' });

    // Step 4: reset password
    const { error: resetErr } = await adminClient.auth.admin.updateUserById(userId, {
      password: new_password,
    });
    if (resetErr)
      return res.status(500).json({ error: '重設密碼失敗：' + resetErr.message });

    return res.status(200).json({ message: `${emp.name}（${emp_no}）密碼已重設` });
  }

  return res.status(400).json({ error: '未知的 action，請傳入 ?action=change-password 或 ?action=reset-password' });
}
