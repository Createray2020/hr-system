// api/employees/index.js — GET all / POST new
import { createClient } from '@supabase/supabase-js';
import { supabase } from '../../lib/supabase.js';
import { requireRoleOrPass } from '../../lib/auth.js';

const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  // GET — 不需要權限驗證
  if (req.method === 'GET') {
    const { status, dept, search } = req.query;
    let q = supabase.from('employees').select('*').order('name');
    if (status) q = q.eq('status', status);
    if (dept)   q = q.eq('dept', dept);
    if (search) q = q.or(`name.ilike.%${search}%,email.ilike.%${search}%`);
    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json(data);
  }

  if (req.method === 'POST') {
    const caller = await requireRoleOrPass(req, res, ['hr', 'ceo', 'admin']);
    if (!caller) return;
    const body = { ...req.body };
    const id = 'E' + Date.now();

    // ── 自動產生員工編號（若未傳入）格式：01YYMMDD / 02YYMMDD，重複加 A/B/C ──
    if (!body.emp_no && body.hire_date) {
      const empType = body.employment_type === 'part_time' ? '02' : '01';
      const d  = new Date(body.hire_date);
      const yy = String(d.getFullYear()).slice(-2);
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      const base = empType + yy + mm + dd;

      // 查詢是否已有相同前綴的編號
      const { data: existing } = await supabase
        .from('employees')
        .select('emp_no')
        .like('emp_no', base + '%');
      const taken = new Set((existing || []).map(e => e.emp_no));

      if (!taken.has(base)) {
        body.emp_no = base;
      } else {
        let suffix = '';
        for (let i = 0; i < 26; i++) {
          const candidate = base + String.fromCharCode(65 + i); // A, B, C...
          if (!taken.has(candidate)) { suffix = String.fromCharCode(65 + i); break; }
        }
        body.emp_no = base + suffix;
      }
    }

    const { error } = await supabase.from('employees').insert([{ id, ...body }]);
    if (error) return res.status(500).json({ error: error.message });

    // ── 自動建立 Supabase Auth 帳號 ──
    let authEmail = null;
    if (SUPABASE_SERVICE_KEY) {
      try {
        const adminClient = createClient(process.env.SUPABASE_URL, SUPABASE_SERVICE_KEY);
        authEmail = body.email || `${body.emp_no || id}@chuwa.hr`;
        const { data: authData, error: authError } = await adminClient.auth.admin.createUser({
          email: authEmail,
          password: '123456',
          email_confirm: true,
          user_metadata: { name: body.name, emp_no: body.emp_no || id },
        });
        if (authError) {
          console.warn('[Auth] 建立帳號失敗:', authError.message);
          authEmail = null;
        } else if (authData?.user?.id) {
          await supabase.from('employees')
            .update({ auth_user_id: authData.user.id })
            .eq('id', id);
        }
      } catch (e) {
        console.warn('[Auth] 例外錯誤:', e.message);
        authEmail = null;
      }
    }

    return res.status(201).json({ id, emp_no: body.emp_no, auth_email: authEmail, message: '員工已建立' });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
