// api/employees/index.js — GET all / POST new
// Also handles: GET|POST|PUT|DELETE /api/departments (via ?_resource=departments)
// Also handles: POST /api/push (via ?_resource=push)
import { createClient } from '@supabase/supabase-js';
import { supabase } from '../../lib/supabase.js';
import { requireAuth, requireRole } from '../../lib/auth.js';
import { BACKOFFICE_ROLES } from '../../lib/roles.js';

const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

// 同步 employees.is_manager。在 departments 表變動「之後」呼叫。
// oldManagerId / newManagerId 可為 null。
// Exported for testability; handler 內部使用 supabase 預設值。
export async function syncDeptManagerFlag({ oldManagerId, newManagerId }, sb = supabase) {
  if (oldManagerId === newManagerId) return;

  if (newManagerId) {
    await sb.from('employees')
      .update({ is_manager: true }).eq('id', newManagerId);
  }

  if (oldManagerId) {
    // 若原主管已無其他部門在帶，降級為一般員工
    const { count } = await sb.from('departments')
      .select('id', { count: 'exact', head: true })
      .eq('manager_id', oldManagerId);
    if (!count) {
      await sb.from('employees')
        .update({ is_manager: false }).eq('id', oldManagerId);
    }
  }
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── Web Push 推播（合併自 api/push.js） ──────────────────────────────────
  if (req.query._resource === 'push') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const caller = await requireAuth(req, res);
    if (!caller) return;

    const { action } = req.body || {};
    if (action !== 'subscribe') {
      return res.status(400).json({ error: 'Only subscribe action is supported via HTTP' });
    }

    const { employee_id, subscription } = req.body;
    if (!employee_id || !subscription) {
      return res.status(400).json({ error: 'employee_id and subscription required' });
    }

    // 安全檢查：只能為自己訂閱（不能代別人訂閱）
    if (caller.id !== employee_id) {
      return res.status(403).json({ error: 'Cannot subscribe for another employee' });
    }

    const { error } = await supabase.from('push_subscriptions').upsert([{
      id: 'PUSH_' + employee_id,
      employee_id,
      subscription: typeof subscription === 'string' ? subscription : JSON.stringify(subscription),
      updated_at: new Date().toISOString(),
    }], { onConflict: 'employee_id' });

    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ message: '已訂閱推播通知' });
  }

  // ── 部門管理（合併自 api/departments.js） ─────────────────────────────────
  if (req.query._resource === 'departments') {
    if (req.method === 'GET') {
      const caller = await requireAuth(req, res);
      if (!caller) return;
      try {
        const { data: depts, error } = await supabase
          .from('departments').select('*').order('name');
        if (error) return res.status(500).json({ error: error.message });

        const { data: emps } = await supabase
          .from('employees').select('dept').eq('status', 'active');
        const countMap = {};
        (emps || []).forEach(e => { countMap[e.dept] = (countMap[e.dept] || 0) + 1; });

        const managerIds = depts.map(d => d.manager_id).filter(Boolean);
        let managerMap = {};
        if (managerIds.length) {
          const { data: mgrs } = await supabase
            .from('employees').select('id, name').in('id', managerIds);
          (mgrs || []).forEach(m => { managerMap[m.id] = m.name; });
        }

        return res.status(200).json(depts.map(d => ({
          ...d,
          emp_count:    countMap[d.name] || 0,
          manager_name: managerMap[d.manager_id] || null,
        })));
      } catch (e) {
        return res.status(500).json({ error: e.message });
      }
    }

    if (req.method === 'POST') {
      const caller = await requireRole(req, res, BACKOFFICE_ROLES);
      if (!caller) return;
      const { name, description, color, manager_id } = req.body;
      if (!name) return res.status(400).json({ error: '缺少部門名稱' });
      const id = 'D' + Date.now();
      const newManagerId = manager_id || null;
      const { error } = await supabase.from('departments').insert([{
        id, name,
        description: description || '',
        color:       color || '#5B8DEF',
        manager_id:  newManagerId,
      }]);
      if (error) return res.status(500).json({ error: error.message });
      await syncDeptManagerFlag({ oldManagerId: null, newManagerId });
      return res.status(201).json({ id, message: '部門已建立' });
    }

    if (req.method === 'PUT') {
      const caller = await requireRole(req, res, BACKOFFICE_ROLES);
      if (!caller) return;
      const { id } = req.query;
      if (!id) return res.status(400).json({ error: '缺少 id' });
      const allowed = ['name', 'description', 'color', 'manager_id'];
      const update = {};
      allowed.forEach(k => { if (req.body[k] !== undefined) update[k] = req.body[k]; });

      // 只有當 body 帶 manager_id 時才做同步（PUT 支援部分更新）
      const managerIdChanging = Object.prototype.hasOwnProperty.call(req.body, 'manager_id');
      let oldManagerId = null;
      if (managerIdChanging) {
        const { data: cur } = await supabase.from('departments')
          .select('manager_id').eq('id', id).single();
        oldManagerId = cur?.manager_id || null;
      }

      const { error } = await supabase.from('departments').update(update).eq('id', id);
      if (error) return res.status(500).json({ error: error.message });

      if (managerIdChanging) {
        await syncDeptManagerFlag({ oldManagerId, newManagerId: req.body.manager_id || null });
      }
      return res.status(200).json({ message: '已更新' });
    }

    if (req.method === 'DELETE') {
      const caller = await requireRole(req, res, BACKOFFICE_ROLES);
      if (!caller) return;
      const { id } = req.query;
      if (!id) return res.status(400).json({ error: '缺少 id' });

      const { data: dept } = await supabase
        .from('departments').select('name, manager_id').eq('id', id).single();
      if (!dept) return res.status(404).json({ error: '找不到部門' });

      const { data: active } = await supabase
        .from('employees').select('id').eq('dept', dept.name).eq('status', 'active').limit(1);
      if (active && active.length > 0)
        return res.status(409).json({ error: '該部門仍有在職員工，無法刪除' });

      const { error } = await supabase.from('departments').delete().eq('id', id);
      if (error) return res.status(500).json({ error: error.message });
      await syncDeptManagerFlag({ oldManagerId: dept.manager_id || null, newManagerId: null });
      return res.status(200).json({ message: '已刪除' });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ── 員工列表 GET ─────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    const caller = await requireAuth(req, res);
    if (!caller) return;
    const { status, dept, search } = req.query;
    let q = supabase.from('employees').select('*').order('name');
    if (status) q = q.eq('status', status);
    if (dept)   q = q.eq('dept', dept);
    if (search) q = q.or(`name.ilike.%${search}%,email.ilike.%${search}%`);
    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json(data);
  }

  // ── 新增員工 POST ────────────────────────────────────────────────────────
  if (req.method === 'POST') {
    const caller = await requireRole(req, res, BACKOFFICE_ROLES);
    if (!caller) return;
    const body = { ...req.body };
    const id = 'E' + Date.now();

    if (!body.emp_no && body.hire_date) {
      const empType = body.employment_type === 'part_time' ? '02' : '01';
      const d  = new Date(body.hire_date);
      const yy = String(d.getFullYear()).slice(-2);
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      const base = empType + yy + mm + dd;

      const { data: existing } = await supabase
        .from('employees').select('emp_no').like('emp_no', base + '%');
      const taken = new Set((existing || []).map(e => e.emp_no));

      if (!taken.has(base)) {
        body.emp_no = base;
      } else {
        let suffix = '';
        for (let i = 0; i < 26; i++) {
          const candidate = base + String.fromCharCode(65 + i);
          if (!taken.has(candidate)) { suffix = String.fromCharCode(65 + i); break; }
        }
        body.emp_no = base + suffix;
      }
    }

    const { error } = await supabase.from('employees').insert([{ id, ...body }]);
    if (error) return res.status(500).json({ error: error.message });

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
