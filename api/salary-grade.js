// api/salary-grade.js
// GET  /api/salary-grade                         → 職等薪資級距
// GET  /api/salary-grade?_resource=insurance     → 員工勞健保設定清單
// GET  /api/salary-grade?_resource=insurance&brackets=labor  → 勞保級距表
// GET  /api/salary-grade?_resource=insurance&brackets=health → 健保級距表
// POST /api/salary-grade?_resource=insurance     → upsert 員工設定
import { supabaseAdmin } from '../lib/supabase.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { _resource, employee_id, brackets } = req.query;

  // ── Insurance resource ────────────────────────────────────────────────────
  if (_resource === 'insurance') {
    if (req.method === 'GET') {
      if (brackets === 'labor') {
        const { data, error } = await supabaseAdmin
          .from('labor_insurance_brackets').select('*').order('bracket_level');
        if (error) return res.status(500).json({ error: error.message });
        return res.status(200).json(data);
      }
      if (brackets === 'health') {
        const { data, error } = await supabaseAdmin
          .from('health_insurance_brackets').select('*').order('bracket_level');
        if (error) return res.status(500).json({ error: error.message });
        return res.status(200).json(data);
      }
      if (brackets === 'pending') {
        const { data, error } = await supabaseAdmin
          .from('insurance_change_requests')
          .select('*, employees(name, dept)')
          .eq('status', 'pending')
          .order('created_at', { ascending: false });
        if (error) return res.status(500).json({ error: error.message });
        return res.status(200).json(data || []);
      }
      // Insurance settings list (join employees)
      let q = supabaseAdmin.from('insurance_settings')
        .select('*, employees(name, emp_no, dept, position, base_salary, attendance_bonus, grade_allowance, manager_allowance, extra_allowance, has_insurance, employment_type)');
      if (employee_id) q = q.eq('employee_id', employee_id).single();
      const { data, error } = await q;
      if (error) return res.status(employee_id ? 404 : 500).json({ error: error.message });
      return res.status(200).json(data);
    }
    if (req.method === 'POST') {
      const body = req.body;

      // ── 核准級距變動申請 ──────────────────────────────────────────────────
      if (body.action === 'approve_change') {
        const { data: change, error: cErr } = await supabaseAdmin
          .from('insurance_change_requests').select('*').eq('id', body.change_id).single();
        if (cErr || !change) return res.status(404).json({ error: '找不到變動申請' });

        const { error: upsertErr } = await supabaseAdmin.from('insurance_settings').upsert([{
          id: 'INS_' + change.employee_id,
          employee_id:         change.employee_id,
          has_insurance:       true,
          labor_ins_bracket:   change.new_labor_bracket,
          labor_ins_employee:  change.new_labor_employee,
          labor_ins_company:   change.new_labor_company,
          health_ins_bracket:  change.new_health_bracket,
          health_ins_employee: change.new_health_employee,
          health_ins_company:  change.new_health_company,
          updated_at: new Date().toISOString(),
        }], { onConflict: 'employee_id' });
        if (upsertErr) return res.status(500).json({ error: upsertErr.message });

        const { error: updErr } = await supabaseAdmin.from('insurance_change_requests').update({
          status: 'approved',
          approved_by:    body.approved_by    || null,
          effective_date: body.effective_date || null,
          note:           body.note           || '',
          handled_at: new Date().toISOString(),
        }).eq('id', body.change_id);
        if (updErr) return res.status(500).json({ error: updErr.message });

        return res.status(200).json({ message: '級距已更新' });
      }

      // ── 拒絕級距變動申請 ──────────────────────────────────────────────────
      if (body.action === 'reject_change') {
        const { error } = await supabaseAdmin.from('insurance_change_requests').update({
          status: 'rejected',
          handled_at: new Date().toISOString(),
        }).eq('id', body.change_id);
        if (error) return res.status(500).json({ error: error.message });
        return res.status(200).json({ message: '已記錄' });
      }

      if (!body.employee_id) return res.status(400).json({ error: '缺少 employee_id' });
      const id = 'INS_' + body.employee_id;
      const { error } = await supabaseAdmin.from('insurance_settings')
        .upsert([{ id, ...body, updated_at: new Date().toISOString() }],
          { onConflict: 'employee_id' });
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ message: '已儲存' });
    }
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ── Salary grade (original) ───────────────────────────────────────────────
  if (req.method === 'GET') {
    const { data, error } = await supabaseAdmin
      .from('salary_grade').select('*').order('grade').order('grade_level');
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json(data);
  }
  return res.status(405).json({ error: 'Method not allowed' });
}
