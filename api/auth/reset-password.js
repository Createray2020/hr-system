// api/auth/reset-password.js — 管理員重設員工密碼
// POST body: { emp_no, new_password, admin_emp_no }
import { createClient } from '@supabase/supabase-js';

const ALLOWED_ADMIN_ROLES = ['hr', 'chairman', 'admin'];

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { emp_no, new_password, admin_emp_no } = req.body || {};

  if (!emp_no || !new_password || !admin_emp_no) {
    return res.status(400).json({ error: '缺少必要參數' });
  }
  if (new_password.length < 6) {
    return res.status(400).json({ error: '密碼至少需要 6 個字元' });
  }

  const adminClient = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );

  // Step 1: Verify admin identity and role
  const { data: admin, error: adminErr } = await adminClient
    .from('employees')
    .select('id, role, status')
    .eq('emp_no', admin_emp_no)
    .single();

  if (adminErr || !admin) {
    return res.status(403).json({ error: '找不到管理員帳號' });
  }
  if (!ALLOWED_ADMIN_ROLES.includes(admin.role)) {
    return res.status(403).json({ error: '權限不足，僅 HR 或董事長可重設密碼' });
  }
  if (admin.status === 'resigned') {
    return res.status(403).json({ error: '管理員帳號已停用' });
  }

  // Step 2: Find target employee's auth user
  const { data: emp, error: empErr } = await adminClient
    .from('employees')
    .select('auth_user_id, name, emp_no')
    .eq('emp_no', emp_no)
    .single();

  if (empErr || !emp) {
    return res.status(404).json({ error: '找不到此員工（員工編號：' + emp_no + '）' });
  }

  // Step 3: If no auth_user_id, try to find by email
  let userId = emp.auth_user_id;
  if (!userId) {
    const email = emp_no + '@chuwa.hr';
    const { data: { users }, error: listErr } = await adminClient.auth.admin.listUsers();
    if (!listErr && users) {
      const found = users.find(u => u.email === email);
      userId = found?.id || null;
    }
  }

  if (!userId) {
    return res.status(404).json({ error: '找不到此員工的登入帳號，請先建立 Auth 帳號' });
  }

  // Step 4: Reset password
  const { error: resetErr } = await adminClient.auth.admin.updateUserById(userId, {
    password: new_password,
  });

  if (resetErr) {
    return res.status(500).json({ error: '重設密碼失敗：' + resetErr.message });
  }

  return res.status(200).json({ message: `${emp.name}（${emp_no}）密碼已重設` });
}
