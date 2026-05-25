// api/resignation-checklists.js
//
// GET   /api/resignation-checklists?employee_id=X  → 撈員工最新一筆 checklist + items + employee
// GET   /api/resignation-checklists?id=Y            → 撈該 checklist + items + employee
// PATCH /api/resignation-checklists?item_id=Z       → 修一筆 item(status/note)、自動更新母 checklist
//
// 對應實作:
//   migrations/2026_05_26_resignation_checklist.sql(schema + 8 RLS policy)
//   api/approvals.js applyResignation cascade Enhancement #2(自動建 checklist + 46 items)
//
// 設計重點:
//   * HR-only(isBackofficeRole gate、approval / payroll / Insurance 等敏感資訊集中地)
//   * 走 supabaseAdmin = service_role bypass RLS、policy 是 defense-in-depth
//   * 無 DELETE endpoint(對齊 RLS 設計、items 用 status='n_a' 替代刪除)
//   * 不暴露 signatures(F2-F5 backlog 補)
//   * F6:lock 機制(locked_at / locked_by / status='locked')MVP 不開、註解預留

import { supabaseAdmin } from '../lib/supabase.js';
import { requireAuth } from '../lib/auth.js';
import { isBackofficeRole } from '../lib/roles.js';

const VALID_ITEM_STATUS = new Set(['pending', 'done', 'n_a']);

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  const caller = await requireAuth(req, res);
  if (!caller) return;

  // HR-only 守(對齊 approval / leave-admin / salary 既有 isBackofficeRole pattern)
  if (!isBackofficeRole(caller)) {
    return res.status(403).json({
      error: 'Forbidden: 僅 HR / admin / CEO / chairman 可使用離職檢核表',
    });
  }

  if (req.method === 'GET') {
    const { employee_id, id } = req.query;
    if (id) return handleGetById(req, res, id);
    if (employee_id) return handleGetByEmployee(req, res, employee_id);
    return res.status(400).json({ error: 'employee_id or id required' });
  }

  if (req.method === 'PATCH') {
    const { item_id /*, id, action */ } = req.query;
    // F6:if (id && action === 'lock') return handleLockChecklist(req, res, caller, id);
    if (!item_id) return res.status(400).json({ error: 'item_id required' });
    return handlePatchItem(req, res, caller, item_id);
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

// ─── GET ?employee_id=X(撈最新一筆、員工尚未建 checklist 也回 employee 基本資料)──
async function handleGetByEmployee(req, res, employee_id) {
  try {
    // 員工 latest checklist(按 created_at DESC、未來可能有 reopen 場景多筆)
    const { data: checklist } = await supabaseAdmin
      .from('resignation_checklists')
      .select('*')
      .eq('employee_id', employee_id)
      .order('created_at', { ascending: false })
      .limit(1).maybeSingle();

    // 員工基本資料(含 dept_name)
    const employee = await fetchEmployeeBasic(employee_id);

    // 撈 items(僅在 checklist 存在時)
    let items = [];
    if (checklist) {
      const { data } = await supabaseAdmin
        .from('resignation_checklist_items')
        .select('*')
        .eq('checklist_id', checklist.id)
        .order('item_seq', { ascending: true });
      items = data || [];
    }

    return res.status(200).json({
      checklist: checklist || null,
      items,
      employee,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// ─── GET ?id=Y(直接用 checklist.id 找、404 if not exist)──
async function handleGetById(req, res, id) {
  try {
    const { data: checklist } = await supabaseAdmin
      .from('resignation_checklists').select('*').eq('id', id).maybeSingle();
    if (!checklist) return res.status(404).json({ error: '找不到該檢核表' });

    const [itemsRes, employee] = await Promise.all([
      supabaseAdmin.from('resignation_checklist_items').select('*')
        .eq('checklist_id', id).order('item_seq', { ascending: true }),
      fetchEmployeeBasic(checklist.employee_id),
    ]);

    return res.status(200).json({
      checklist,
      items: itemsRes.data || [],
      employee,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// ─── PATCH ?item_id=Z(改 status / note、自動同步母 checklist 狀態)──
async function handlePatchItem(req, res, caller, item_id) {
  const { status, note } = req.body || {};

  // 至少要傳 status 或 note 之一
  if (status === undefined && note === undefined) {
    return res.status(400).json({ error: 'status or note required' });
  }
  if (status !== undefined && !VALID_ITEM_STATUS.has(status)) {
    return res.status(400).json({
      error: 'invalid status',
      valid: [...VALID_ITEM_STATUS],
    });
  }

  // 撈現況(needed for checklist_id + status transition 判斷)
  const { data: existing } = await supabaseAdmin
    .from('resignation_checklist_items')
    .select('id, checklist_id, status')
    .eq('id', item_id).maybeSingle();
  if (!existing) return res.status(404).json({ error: '找不到該檢核項目' });

  // ── 組 patch ──
  const nowIso = new Date().toISOString();
  const patch = {};
  if (status !== undefined) {
    patch.status = status;
    if (status === 'done' || status === 'n_a') {
      patch.completed_at = nowIso;
      patch.completed_by = caller.id;
    } else {
      // 'pending' = 取消完成、清掉 audit 痕跡(完成日期 / 完成人)
      patch.completed_at = null;
      patch.completed_by = null;
    }
  }
  if (note !== undefined) patch.note = String(note || '');

  // ── UPDATE item ──
  const { data: updated, error: updErr } = await supabaseAdmin
    .from('resignation_checklist_items')
    .update(patch).eq('id', item_id).select().maybeSingle();
  if (updErr) return res.status(500).json({ error: updErr.message });

  // ── 自動同步母 checklist.status + updated_at ──
  //   全 pending  → 'draft'
  //   混合       → 'in_progress'
  //   全 done/na → 'completed' + completed_at = NOW
  //   從 completed 退回 → completed_at 設 NULL(語意:不再 completed)
  let newChecklistStatus = null;
  if (status !== undefined) {
    const { data: allItems } = await supabaseAdmin
      .from('resignation_checklist_items')
      .select('status').eq('checklist_id', existing.checklist_id);
    const all = allItems || [];
    const hasPending = all.some(i => i.status === 'pending');
    const hasDoneOrNa = all.some(i => i.status === 'done' || i.status === 'n_a');

    if (!hasPending && hasDoneOrNa) newChecklistStatus = 'completed';
    else if (hasPending && hasDoneOrNa) newChecklistStatus = 'in_progress';
    else newChecklistStatus = 'draft';

    const cpatch = {
      status: newChecklistStatus,
      updated_at: nowIso,
    };
    cpatch.completed_at = newChecklistStatus === 'completed' ? nowIso : null;
    await supabaseAdmin
      .from('resignation_checklists')
      .update(cpatch).eq('id', existing.checklist_id);
  } else {
    // 只改 note:bump 母 updated_at(audit 上「最後動到」時間)
    await supabaseAdmin
      .from('resignation_checklists')
      .update({ updated_at: nowIso }).eq('id', existing.checklist_id);
  }

  return res.status(200).json({
    item: updated,
    checklist_status: newChecklistStatus, // null 代表本次只改 note、母 status 不變
  });
}

// ─── helper:撈員工基本資料、flatten departments.name → dept_name ──
async function fetchEmployeeBasic(employee_id) {
  const { data } = await supabaseAdmin
    .from('employees')
    .select('id, name, dept_id, hire_date, resigned_at, resigned_reason, departments(name)')
    .eq('id', employee_id).maybeSingle();
  if (!data) return null;
  if (data.departments) {
    data.dept_name = data.departments.name;
    delete data.departments;
  }
  return data;
}
