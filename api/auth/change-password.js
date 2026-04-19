// api/auth/change-password.js — 員工修改自己的密碼
// POST body: { emp_no, old_password, new_password }
import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { emp_no, old_password, new_password } = req.body || {};

  if (!emp_no || !old_password || !new_password) {
    return res.status(400).json({ error: '缺少必要參數' });
  }
  if (new_password.length < 6) {
    return res.status(400).json({ error: '新密碼至少需要 6 個字元' });
  }

  // Create a fresh anon client to verify old password
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY
  );

  const email = emp_no + '@chuwa.hr';

  // Step 1: verify old password
  const { data: signInData, error: signInErr } = await supabase.auth.signInWithPassword({
    email,
    password: old_password,
  });

  if (signInErr || !signInData.session) {
    return res.status(401).json({ error: '目前密碼不正確' });
  }

  // Step 2: update password using the authenticated client
  const authClient = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY,
    { global: { headers: { Authorization: `Bearer ${signInData.session.access_token}` } } }
  );

  const { error: updateErr } = await authClient.auth.updateUser({ password: new_password });

  if (updateErr) {
    return res.status(500).json({ error: '密碼更新失敗：' + updateErr.message });
  }

  return res.status(200).json({ message: '密碼已更新，下次登入生效' });
}
