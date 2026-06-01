// api/employees/index.js — GET all / POST new
// Also handles: GET|POST|PUT|DELETE /api/departments (via ?_resource=departments)
// Also handles: POST /api/push (via ?_resource=push)
import { createClient } from '@supabase/supabase-js';
import { supabaseAdmin } from '../../lib/supabase.js';
import { requireAuth, requireRole } from '../../lib/auth.js';
import { BACKOFFICE_ROLES, isBackofficeRole } from '../../lib/roles.js';
import { syncDeptFields } from '../../lib/dept-sync.js';
import { addDeptName } from '../../lib/dept-name-mapper.js';
import { resolveAuthScopeWithDeptIds, makeDeptEmpIdsRepo } from '../../lib/auth-scope.js';
import { applyExcludeSystemAccountsQuery } from '../../lib/salary/system-accounts.js';

const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

// 同步 employees.is_manager。在 departments 表變動「之後」呼叫。
// oldManagerId / newManagerId 可為 null。
// Exported for testability; handler 內部使用 supabaseAdmin 預設值。
export async function syncDeptManagerFlag({ oldManagerId, newManagerId }, sb = supabaseAdmin) {
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

    const { error } = await supabaseAdmin.from('push_subscriptions').upsert([{
      id: 'PUSH_' + employee_id,
      employee_id,
      subscription: typeof subscription === 'string' ? subscription : JSON.stringify(subscription),
      updated_at: new Date().toISOString(),
    }], { onConflict: 'employee_id' });

    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ message: '已訂閱推播通知' });
  }

  // ── 組織圖 caller-aware filter ────────────────────────────────────────────
  // GET /api/orgchart（vercel.json rewrite → _resource=orgchart）
  // 角色：
  //   BACKOFFICE (hr/ceo/chairman/admin) → 全公司員工
  //   is_manager === true → chairman + ceo + hr/admin + 全公司主管 + caller 自己部門所有員工
  //   其他（一般員工）→ 403（前端應擋住、後端兜底）
  if (req.query._resource === 'orgchart') {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    const caller = await requireAuth(req, res);
    if (!caller) return;

    const isHR  = isBackofficeRole(caller);
    const isMgr = caller.is_manager === true;
    if (!isHR && !isMgr) return res.status(403).json({ error: 'Forbidden' });

    const ORG_FIELDS = 'id, name, position, avatar, role, dept_id, is_manager';
    const { data: all, error: eErr } = await applyExcludeSystemAccountsQuery(
      supabaseAdmin.from('employees').select(ORG_FIELDS).eq('status', 'active')
    );
    if (eErr) return res.status(500).json({ error: eErr.message });

    let employees = all || [];
    if (!isHR) {
      // 員工數小、in-memory filter（避免複雜 OR query）
      employees = employees.filter(e =>
        e.role === 'chairman' || e.role === 'ceo' ||
        e.role === 'hr'       || e.role === 'admin' ||
        e.is_manager === true ||
        (caller.dept_id && e.dept_id === caller.dept_id) ||
        e.id === caller.id // 防禦性、確保自己一定在
      );
    }

    const { data: depts, error: dErr } = await supabaseAdmin
      .from('departments').select('id, name, color').order('name');
    if (dErr) return res.status(500).json({ error: dErr.message });

    return res.status(200).json({ employees, departments: depts || [] });
  }

  // ── by_ids 子查詢(階段 C1 取代 frontend 直接 query supabase)─────────
  // GET ?_resource=by_ids&ids=A,B,C → [{ id, name, dept_id, dept_name, avatar }]
  // 套 EMP_99999999 排除 + auth-scope filter (HR 全員 / 主管 同部門 / 員工 只自己)
  if (req.query._resource === 'by_ids') {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    const caller = await requireAuth(req, res);
    if (!caller) return;

    const idsRaw = String(req.query.ids || '').trim();
    if (!idsRaw) return res.status(200).json([]);
    const ids = idsRaw.split(',').map(s => s.trim()).filter(Boolean);
    if (!ids.length) return res.status(200).json([]);

    // auth-scope filter:HR 全員 / 主管 dept-scope / 員工 only self
    const scope = await resolveAuthScopeWithDeptIds(caller, 'selfOrDept', makeDeptEmpIdsRepo(supabaseAdmin));
    let allowedIds = ids;
    if (scope.mode === 'self') {
      allowedIds = ids.filter(id => id === scope.selfId);
    } else if (scope.mode === 'dept') {
      const deptSet = new Set([scope.selfId, ...(scope.deptEmpIds || [])]);
      allowedIds = ids.filter(id => deptSet.has(id));
    }
    if (!allowedIds.length) return res.status(200).json([]);

    const { data, error } = await applyExcludeSystemAccountsQuery(
      supabaseAdmin
        .from('employees')
        .select('id, name, dept_id, avatar, departments(name)')
        .in('id', allowedIds)
    );
    if (error) return res.status(500).json({ error: error.message });
    addDeptName(data);
    return res.status(200).json(data || []);
  }

  // ── 部門管理（合併自 api/departments.js） ─────────────────────────────────
  if (req.query._resource === 'departments') {
    if (req.method === 'GET') {
      const caller = await requireAuth(req, res);
      if (!caller) return;
      try {
        const { data: depts, error } = await supabaseAdmin
          .from('departments').select('*').order('name');
        if (error) return res.status(500).json({ error: error.message });

        const { data: emps } = await applyExcludeSystemAccountsQuery(
          supabaseAdmin.from('employees').select('dept_id').eq('status', 'active')
        );
        const countMap = {};
        (emps || []).forEach(e => { if (e.dept_id) countMap[e.dept_id] = (countMap[e.dept_id] || 0) + 1; });

        const managerIds = depts.map(d => d.manager_id).filter(Boolean);
        let managerMap = {};
        if (managerIds.length) {
          const { data: mgrs } = await supabaseAdmin
            .from('employees').select('id, name').in('id', managerIds);
          (mgrs || []).forEach(m => { managerMap[m.id] = m.name; });
        }

        return res.status(200).json(depts.map(d => ({
          ...d,
          emp_count:    countMap[d.id] || 0,
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
      const { error } = await supabaseAdmin.from('departments').insert([{
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
        const { data: cur } = await supabaseAdmin.from('departments')
          .select('manager_id').eq('id', id).single();
        oldManagerId = cur?.manager_id || null;
      }

      const { error } = await supabaseAdmin.from('departments').update(update).eq('id', id);
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

      const { data: dept } = await supabaseAdmin
        .from('departments').select('manager_id').eq('id', id).single();
      if (!dept) return res.status(404).json({ error: '找不到部門' });

      // 用 dept_id 比對、擋 active + inactive、避免 FK violation
      const { data: linked } = await supabaseAdmin
        .from('employees').select('id, status').eq('dept_id', id).limit(5);
      if (linked && linked.length > 0) {
        const activeCnt   = linked.filter(e => e.status === 'active').length;
        const inactiveCnt = linked.filter(e => e.status !== 'active').length;
        const detail = activeCnt > 0
          ? `該部門仍有 ${activeCnt} 位在職員工`
          : `該部門有 ${inactiveCnt} 位歷史員工資料、無法刪除（可改名替代）`;
        return res.status(409).json({ error: detail });
      }

      const { error } = await supabaseAdmin.from('departments').delete().eq('id', id);
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
    const { status, dept, dept_id, search } = req.query;

    // 員工互看用 16 欄位白名單（排除薪資/個資/系統欄位）；後台 (hr/admin/ceo/chairman) 看全欄位
    const PUBLIC_FIELDS = 'id, emp_no, name, dept_id, position, role, is_manager, status, avatar, email, phone, hire_date, manager_id, employment_type, birth_date';
    const cols = isBackofficeRole(caller) ? '*' : PUBLIC_FIELDS;

    // C0-5a JOIN departments 補 dept_name
    const colsWithDept = (cols === '*') ? '*, departments(name)' : `${cols}, departments(name)`;
    let q = supabaseAdmin.from('employees').select(colsWithDept).order('name');
    q = applyExcludeSystemAccountsQuery(q);
    if (status) q = q.eq('status', status);
    if (dept_id) q = q.eq('dept_id', dept_id);
    if (search) q = q.or(`name.ilike.%${search}%,email.ilike.%${search}%`);

    // Phase 2:row-level scope filter(取代既有「無 row filter」、防主管 / 員工看全公司)
    // 員工本人 / 主管本部門 / HR 全部。?_resource=orgchart 已 caller-aware、不走此分支。
    const scope = await resolveAuthScopeWithDeptIds(caller, 'selfOrDept', makeDeptEmpIdsRepo(supabaseAdmin));
    if (scope.mode === 'self') {
      q = q.eq('id', scope.selfId);
    } else if (scope.mode === 'dept') {
      q = q.in('id', [scope.selfId, ...(scope.deptEmpIds || [])]);
    }
    // mode='all' 不加 filter

    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    addDeptName(data);
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

      const { data: existing } = await supabaseAdmin
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

    await syncDeptFields(supabaseAdmin, body);
    // 預設 annual_leave_seniority_start = hire_date（跟 migration backfill 邏輯一致）
    if (!body.annual_leave_seniority_start && body.hire_date) {
      body.annual_leave_seniority_start = body.hire_date;
    }
    const { error } = await supabaseAdmin.from('employees').insert([{ id, ...body }]);
    if (error) return res.status(500).json({ error: error.message });

    let authEmail = null;
    if (SUPABASE_SERVICE_KEY) {
      try {
        const adminClient = createClient(process.env.SUPABASE_URL, SUPABASE_SERVICE_KEY);
        // Auth 帳號一律用 {emp_no}@chuwa.hr 後綴(對齊 api/auth.js L21
        // change-password 的 email 拼裝;body.email 仍寫進 employees.email 聯絡用、
        // 但不再當 Auth 登入帳號、避免兩端 email 不一致導致簽入失敗)
        authEmail = `${body.emp_no || id}@chuwa.hr`;
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
          await supabaseAdmin.from('employees')
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
