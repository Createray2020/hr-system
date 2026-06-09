// api/salary-grades/[id].js
// PATCH /api/salary-grades/:id   HR/admin/ceo/chairman 更新單一級距的可編輯欄位
//
// 可編輯欄位(白名單):
//   grade_name (text)
//   base_salary (numeric)、attendance_bonus (numeric)、grade_allowance (numeric)、manager_allowance (numeric)
//   can_be_manager (boolean)
//   hourly_rate (numeric 或 NULL=該級距不適用兼職)
//
// 行為:
//   - 對每個「實際變動」(舊值≠新值)的欄位寫一筆 salary_grade_change_logs
//     (含 salary_grade_id / grade / grade_level snapshot / changed_field / before/after / changed_by)
//   - 自動重算並寫回 monthly_total = base_salary + attendance_bonus + grade_allowance
//     (manager_allowance 不計入級距基本總額;hourly_rate 不影響 monthly_total)
//   - 寫入 updated_at = now()、updated_by = caller
//   - 全沒變動 → 200 但 no_actual_changes、不寫 log
//
// 不提供 DELETE / POST(本 phase 不開放新增/刪除級距)。

import { requireRole } from '../../lib/auth.js';
import { BACKOFFICE_ROLES } from '../../lib/roles.js';
import { makeSalaryGradeRepo } from './_repo.js';

const ALLOWED_PATCH = new Set([
  'grade_name',
  'base_salary', 'attendance_bonus', 'grade_allowance', 'manager_allowance',
  'can_be_manager',
  'hourly_rate',
]);
const NUMERIC_FIELDS = new Set([
  'base_salary', 'attendance_bonus', 'grade_allowance', 'manager_allowance', 'hourly_rate',
]);
const BOOL_FIELDS = new Set(['can_be_manager']);
const NULLABLE_NUMERIC = new Set(['hourly_rate']);  // 其他金額 NULL → 0、hourly_rate 保留 NULL

function normalizeValue(field, raw) {
  if (BOOL_FIELDS.has(field)) {
    if (typeof raw === 'boolean') return raw;
    if (raw === 'true')  return true;
    if (raw === 'false') return false;
    return undefined;   // 格式錯誤
  }
  if (NUMERIC_FIELDS.has(field)) {
    if (raw === null || raw === '') {
      return NULLABLE_NUMERIC.has(field) ? null : 0;
    }
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return undefined;
    return n;
  }
  if (field === 'grade_name') {
    if (raw == null) return undefined;
    const s = String(raw).trim();
    return s || undefined;
  }
  return raw;
}

function logValue(v) {
  if (v === null || v === undefined) return null;
  return String(v);
}

// 取 patch 後值,沒設則用 existing(算 monthly_total 用)
function pick(patch, existing, field) {
  return Object.prototype.hasOwnProperty.call(patch, field) ? patch[field] : existing[field];
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'PATCH')   return res.status(405).json({ error: 'Method not allowed' });

  const caller = await requireRole(req, res, BACKOFFICE_ROLES);
  if (!caller) return;

  const id = req.query.id;
  if (!id) return res.status(400).json({ error: 'id required' });

  const repo = makeSalaryGradeRepo();
  const existing = await repo.getById(id);
  if (!existing) return res.status(404).json({ error: 'salary_grade not found', id });

  // 白名單 + 規範化
  const patch = {};
  const errors = [];
  for (const k of Object.keys(req.body || {})) {
    if (!ALLOWED_PATCH.has(k)) continue;
    const v = normalizeValue(k, req.body[k]);
    if (v === undefined) {
      errors.push(`${k} 格式錯誤`);
      continue;
    }
    patch[k] = v;
  }
  if (errors.length) return res.status(400).json({ error: errors.join('、') });
  if (Object.keys(patch).length === 0) {
    return res.status(400).json({ error: 'no allowed fields to update' });
  }

  // 收集實際變動欄位(舊值===新值就跳過;String() 比避免 NUMERIC vs Number 對不上)
  const changes = [];
  const realPatch = {};
  for (const k of Object.keys(patch)) {
    const before = existing[k];
    const after  = patch[k];
    if (String(before ?? '') === String(after ?? '')) continue;
    changes.push({
      salary_grade_id: existing.id,
      grade:           existing.grade,
      grade_level:     existing.grade_level,
      changed_field:   k,
      before_value:    logValue(before),
      after_value:     logValue(after),
      changed_by:      caller.id,
    });
    realPatch[k] = after;
  }

  if (changes.length === 0) {
    return res.status(200).json({
      grade: existing,
      message: 'no actual changes',
      change_logs_inserted: 0,
    });
  }

  // 自動重算 monthly_total = base + attendance + grade_allowance(manager_allowance 不計入)
  const newBase  = Number(pick(realPatch, existing, 'base_salary')) || 0;
  const newAtt   = Number(pick(realPatch, existing, 'attendance_bonus')) || 0;
  const newGrade = Number(pick(realPatch, existing, 'grade_allowance')) || 0;
  const newMonthlyTotal = newBase + newAtt + newGrade;

  // 只有實際變動才寫進 realPatch(避免無謂 UPDATE 同值)
  if (Number(existing.monthly_total) !== newMonthlyTotal) {
    realPatch.monthly_total = newMonthlyTotal;
  }

  realPatch.updated_at = new Date().toISOString();
  realPatch.updated_by = caller.id;

  try {
    const updated = await repo.updateById(id, realPatch);
    await repo.insertChangeLogs(changes);
    return res.status(200).json({
      grade: updated,
      change_logs_inserted: changes.length,
      monthly_total: newMonthlyTotal,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
