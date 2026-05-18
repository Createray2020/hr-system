// api/attendance/[id].js
// PUT    /api/attendance/:id  → HR / admin 修改 attendance（限定欄位白名單）
// DELETE /api/attendance/:id  → HR / admin 刪除 attendance
//
// 對應設計文件：docs/attendance-system-design-v1.md §4.2.4
// 對應實作計畫：docs/attendance-system-implementation-plan-v1.md §6.4
//
// Routing 假設（Vercel file-system routing）：
//   `api/attendance/anomaly.js` 跟本檔同目錄共存,Vercel 慣例「靜態檔名優先」會
//   把 /api/attendance/anomaly 路由到 anomaly.js,/api/attendance/{其他} 路由到本檔。
//   本 repo precedent: api/holidays/{[id].js, import.js, index.js} 已驗證 work
//   (holidays-admin.html L231/247 PUT/DELETE 走 [id].js,L262 import 走 import.js)。
//   Batch 10 上 prod 後手測再次確認。
//
// vercel.json 中既有的 /api/attendance/:id rewrite 已在 Batch 4 移除,
// 否則本檔永遠不會被 hit(會被 rewrite 到 index.js?_id=...)。

import { supabaseAdmin } from '../../lib/supabase.js';
import { requireRole } from '../../lib/auth.js';
import { BACKOFFICE_ROLES } from '../../lib/roles.js';
import { recomputeAttendanceStatus } from '../../lib/attendance/recompute.js';
import { makeRepo } from './index.js';

const ALLOWED_PUT_FIELDS = new Set([
  'clock_in', 'clock_out',
  'late_minutes', 'early_leave_minutes',
  'work_hours', 'overtime_hours',
  'status',
  'is_anomaly', 'anomaly_note',
  'note',
]);

const ALLOWED_STATUSES = new Set(['normal', 'late', 'early_leave', 'absent', 'leave', 'holiday']);

// P4.1:只有 caller 直接送這些欄位才 fetch schedule + recompute(其他欄位改不需要)
const RECOMPUTE_TRIGGER_FIELDS = new Set(['clock_in', 'clock_out', 'status']);
// P4.1:recompute 自動算的欄位、caller 送也會被覆寫、audit 不寫(避免雜訊)
const RECOMPUTE_MANAGED_FIELDS = new Set(['late_minutes', 'early_arrival_minutes', 'early_leave_minutes']);

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  const id = req.query.id;
  if (!id || id === 'anomaly') {
    // 'anomaly' 不該透過此檔處理(file-system routing 應該優先匹配 anomaly.js)。
    // 防呆:若 query.id === 'anomaly' 表示路由出錯,直接 400。
    return res.status(400).json({ error: 'invalid id' });
  }

  const caller = await requireRole(req, res, BACKOFFICE_ROLES);
  if (!caller) return;

  const { data: existing, error: gErr } = await supabaseAdmin
    .from('attendance').select('*').eq('id', id).maybeSingle();
  if (gErr) return res.status(500).json({ error: gErr.message });
  if (!existing) return res.status(404).json({ error: 'attendance not found' });

  if (req.method === 'PUT') {
    // 1. caller patch (白名單過濾)
    const callerPatch = {};
    for (const k of Object.keys(req.body || {})) {
      if (!ALLOWED_PUT_FIELDS.has(k)) continue;
      callerPatch[k] = req.body[k];
    }
    if (Object.keys(callerPatch).length === 0) {
      return res.status(400).json({ error: 'no allowed fields to update' });
    }
    if (callerPatch.status !== undefined && !ALLOWED_STATUSES.has(callerPatch.status)) {
      return res.status(400).json({ error: 'invalid status' });
    }

    // 2. 決定是否要 recompute (caller 動了 clock_in / clock_out / status 任一)
    const shouldRecompute = Object.keys(callerPatch).some(k => RECOMPUTE_TRIGGER_FIELDS.has(k));

    let finalPatch = { ...callerPatch };

    // 3. recompute cascade(只在需要時 fetch schedule、省 query)
    if (shouldRecompute) {
      const repo = makeRepo();
      const schedules = await repo.findSchedulesForDate(existing.employee_id, existing.work_date);
      const schedule = schedules.find(s => s.segment_no === existing.segment_no) || schedules[0] || null;
      const merged = { ...existing, ...callerPatch };
      const r = recomputeAttendanceStatus(merged, schedule);
      finalPatch.late_minutes          = r.late_minutes;
      finalPatch.early_arrival_minutes = r.early_arrival_minutes;
      finalPatch.early_leave_minutes   = r.early_leave_minutes;
      finalPatch.status                = r.status;  // PRESERVED_STATUSES 已內建處理(leave/holiday/absent 保留)
    }

    // 4. audit log:只記 caller 直接改變的欄位(排除 recompute managed、避免 cascade 雜訊)
    const auditChanges = [];
    for (const k of Object.keys(callerPatch)) {
      if (RECOMPUTE_MANAGED_FIELDS.has(k)) continue;
      const oldVal = existing[k];
      const newVal = callerPatch[k];
      // null / undefined / string 對比用 String 簡化
      if (String(oldVal ?? '') === String(newVal ?? '')) continue;
      auditChanges.push(`${k} ${formatAuditVal(oldVal)}→${formatAuditVal(newVal)}`);
    }
    if (auditChanges.length > 0) {
      const nowDate = new Date().toISOString().slice(0, 10);
      const auditLine = `[${nowDate}] admin_edit by ${caller.id}: ${auditChanges.join(', ')}`;
      finalPatch.note = existing.note
        ? `${auditLine}\n${existing.note}`
        : auditLine;
    }

    // 5. update DB
    const { data, error } = await supabaseAdmin
      .from('attendance').update(finalPatch).eq('id', id).select().maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ attendance: data });
  }

  if (req.method === 'DELETE') {
    const { error } = await supabaseAdmin.from('attendance').delete().eq('id', id);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ deleted: true, id });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

function formatAuditVal(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return String(v);
  return String(v);
}
