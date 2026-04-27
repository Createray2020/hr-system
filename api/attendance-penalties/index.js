// api/attendance-penalties/index.js
// GET  /api/attendance-penalties[?trigger_type&is_active]   列表
// POST /api/attendance-penalties                             HR 新增規則

import { requireAuth, requireRole } from '../../lib/auth.js';
import { BACKOFFICE_ROLES } from '../../lib/roles.js';
import { makeAttendancePenaltyRepo } from './_repo.js';

const TRIGGERS = new Set(['late', 'early_leave', 'absent', 'other']);
const PENALTY_TYPES = new Set([
  'deduct_money', 'deduct_money_per_min',
  'deduct_attendance_bonus', 'deduct_attendance_bonus_pct',
  'warning', 'custom',
]);

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') {
    // 規則查詢:HR / admin / manager 都可看(便於部門主管了解規則)
    const caller = await requireAuth(req, res);
    if (!caller) return;
    const repo = makeAttendancePenaltyRepo();
    try {
      const rules = await repo.listPenalties({
        trigger_type: req.query.trigger_type,
        is_active:    req.query.is_active,
      });
      return res.status(200).json({ rules });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (req.method === 'POST') {
    const caller = await requireRole(req, res, BACKOFFICE_ROLES);
    if (!caller) return;

    const body = req.body || {};
    const {
      trigger_type, trigger_label,
      threshold_minutes_min, threshold_minutes_max,
      monthly_count_threshold,
      penalty_type, penalty_amount, penalty_cap,
      custom_action_note, is_active,
      display_order, effective_from, effective_to,
      description,
    } = body;

    if (!TRIGGERS.has(trigger_type)) return res.status(400).json({ error: 'invalid trigger_type' });
    if (!trigger_label) return res.status(400).json({ error: 'trigger_label required' });
    if (!PENALTY_TYPES.has(penalty_type)) return res.status(400).json({ error: 'invalid penalty_type' });

    const row = {
      trigger_type, trigger_label,
      threshold_minutes_min: parseInt(threshold_minutes_min) || 0,
      threshold_minutes_max: threshold_minutes_max == null || threshold_minutes_max === '' ? null : parseInt(threshold_minutes_max),
      monthly_count_threshold: monthly_count_threshold == null || monthly_count_threshold === '' ? null : parseInt(monthly_count_threshold),
      penalty_type,
      penalty_amount: penalty_amount == null ? 0 : Number(penalty_amount),
      penalty_cap: penalty_cap == null || penalty_cap === '' ? null : Number(penalty_cap),
      custom_action_note: custom_action_note || null,
      is_active: is_active !== false,
      display_order: parseInt(display_order) || 0,
      effective_from: effective_from || new Date().toISOString().slice(0, 10),
      effective_to: effective_to || null,
      description: description || null,
      created_by: caller.id || null,
    };

    const repo = makeAttendancePenaltyRepo();
    try {
      const created = await repo.insertPenalty(row);
      return res.status(201).json({ rule: created });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
