// api/leave-types/[code].js
// PATCH /api/leave-types/:code   HR/admin/ceo/chairman 更新單一假別的可編輯欄位
//
// 可編輯欄位(白名單):
//   pay_rate (0~1 或 NULL=待設定)、is_paid (bool)、
//   affects_attendance_bonus (bool)、affects_attendance_rate (bool)、is_active (bool)
//
// 行為:
//   - 對每個「實際變動」的欄位寫一筆 leave_type_change_logs(同次請求改 N 欄 → N 筆 log)
//   - 同步更新 leave_types.updated_at(對齊 expense-categories pattern)
//   - 既有值 === 新值 → 不寫 log、不算改動;若所有 patch 欄位都跟舊值相同 → 200 但 no_actual_changes
//
// 不提供 DELETE / POST(本 phase 只允許編輯既有假別、新增/刪除走 migration)。

import { requireRole } from '../../lib/auth.js';
import { BACKOFFICE_ROLES } from '../../lib/roles.js';
import { makeLeaveTypeRepo } from './_repo.js';

const ALLOWED_PATCH = new Set([
  'pay_rate',
  'is_paid',
  'affects_attendance_bonus',
  'affects_attendance_rate',
  'is_active',
]);
const BOOL_FIELDS = new Set([
  'is_paid', 'affects_attendance_bonus', 'affects_attendance_rate', 'is_active',
]);

// 規範化單欄輸入;回傳 undefined 表示「格式錯誤、不該寫入」
function normalizeValue(field, raw) {
  if (BOOL_FIELDS.has(field)) {
    if (typeof raw === 'boolean') return raw;
    if (raw === 'true')  return true;
    if (raw === 'false') return false;
    return undefined;
  }
  if (field === 'pay_rate') {
    if (raw === null || raw === '') return null;
    const n = Number(raw);
    if (!Number.isFinite(n)) return undefined;
    // NUMERIC(4,2):round 到 2 位小數
    return Math.round(n * 100) / 100;
  }
  return raw;
}

// 字串化舊/新值寫進 audit log(boolean/null/數字都統一字串)
function logValue(v) {
  if (v === null || v === undefined) return null;
  return String(v);
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'PATCH')   return res.status(405).json({ error: 'Method not allowed' });

  const caller = await requireRole(req, res, BACKOFFICE_ROLES);
  if (!caller) return;

  const code = req.query.code;
  if (!code) return res.status(400).json({ error: 'code required' });

  const repo = makeLeaveTypeRepo();
  const existing = await repo.getByCode(code);
  if (!existing) return res.status(404).json({ error: 'leave type not found', code });

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
    if (k === 'pay_rate' && v !== null && (v < 0 || v > 1)) {
      errors.push('pay_rate 必須介於 0~1(或 NULL=待設定)');
      continue;
    }
    patch[k] = v;
  }
  if (errors.length) {
    return res.status(400).json({ error: errors.join('、') });
  }
  if (Object.keys(patch).length === 0) {
    return res.status(400).json({ error: 'no allowed fields to update' });
  }

  // 收集實際變動欄位(舊值跟新值相同就跳過、不寫 log 也不算入 patch)
  const changes = [];
  const realPatch = {};
  for (const k of Object.keys(patch)) {
    const before = existing[k];
    const after  = patch[k];
    // null / boolean / number 一律 String 比較(NUMERIC(4,2) 0.5 vs "0.50" 也對得起來)
    if (String(before ?? '') === String(after ?? '')) continue;
    changes.push({
      leave_code:    code,
      changed_field: k,
      before_value:  logValue(before),
      after_value:   logValue(after),
      changed_by:    caller.id,
    });
    realPatch[k] = after;
  }

  if (changes.length === 0) {
    return res.status(200).json({
      leave_type: existing,
      message: 'no actual changes',
      change_logs_inserted: 0,
    });
  }

  realPatch.updated_at = new Date().toISOString();

  try {
    const updated = await repo.updateByCode(code, realPatch);
    await repo.insertChangeLogs(changes);
    return res.status(200).json({
      leave_type: updated,
      change_logs_inserted: changes.length,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
