// api/schedule-templates/[id].js
// GET    /api/schedule-templates/:id  → single（含 shares list、owner/HR 才看）
// PUT    /api/schedule-templates/:id  → owner-only update（HR 也可以）
// DELETE /api/schedule-templates/:id  → owner-only delete（HR 也可以、shares 自動 CASCADE）

import { supabaseAdmin } from '../../lib/supabase.js';
import { requireAuth } from '../../lib/auth.js';
import { isBackofficeRole } from '../../lib/roles.js';

function validatePattern(pattern) {
  if (!pattern || typeof pattern !== 'object') return 'PATTERN_NOT_OBJECT';
  if (pattern.type !== 'weekly') return 'PATTERN_TYPE_INVALID';
  if (!pattern.shifts || typeof pattern.shifts !== 'object') return 'PATTERN_SHIFTS_INVALID';
  for (let day = 0; day <= 6; day++) {
    const v = pattern.shifts[String(day)];
    if (v === undefined || v === null) return `PATTERN_DAY_${day}_MISSING`;
    if (typeof v !== 'string') return `PATTERN_DAY_${day}_NOT_STRING`;
  }
  return null;
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  const caller = await requireAuth(req, res);
  if (!caller) return;

  const id = req.query.id;
  if (!id) return res.status(400).json({ error: 'NO_TEMPLATE_ID' });

  const { data: template, error: tErr } = await supabaseAdmin
    .from('schedule_templates').select('*').eq('id', id).maybeSingle();
  if (tErr) return res.status(500).json({ error: tErr.message });
  if (!template) return res.status(404).json({ error: 'TEMPLATE_NOT_FOUND' });

  const isOwner = template.owner_id === caller.id;
  const isHR = isBackofficeRole(caller);

  if (req.method === 'GET') {
    // 讀權限：owner / HR / is_shared=true / share-to-me
    if (!isOwner && !isHR && !template.is_shared) {
      const { data: share } = await supabaseAdmin
        .from('schedule_template_shares')
        .select('id').eq('template_id', id).eq('shared_to_id', caller.id).maybeSingle();
      if (!share) return res.status(403).json({ error: 'NO_ACCESS' });
    }
    // shares list（owner / HR 看得到）
    let shares = [];
    if (isOwner || isHR) {
      const { data } = await supabaseAdmin
        .from('schedule_template_shares').select('*').eq('template_id', id);
      shares = data || [];
    }
    return res.status(200).json({ template, shares });
  }

  if (req.method === 'PUT') {
    if (!isOwner && !isHR) return res.status(403).json({ error: 'NOT_OWNER' });
    const { name, description, pattern, is_shared } = req.body || {};
    const patch = {};
    if (name !== undefined) {
      if (typeof name !== 'string' || !name) return res.status(400).json({ error: 'NAME_INVALID' });
      patch.name = name;
    }
    if (description !== undefined) patch.description = description;
    if (pattern !== undefined) {
      const patternErr = validatePattern(pattern);
      if (patternErr) return res.status(400).json({ error: patternErr });
      patch.pattern = pattern;
    }
    if (is_shared !== undefined) {
      if (is_shared && !isHR && !caller.is_manager) {
        return res.status(403).json({ error: 'CANNOT_SHARE_GLOBALLY' });
      }
      patch.is_shared = !!is_shared;
    }
    if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'NO_FIELDS' });
    patch.updated_at = new Date().toISOString();

    const { data, error } = await supabaseAdmin
      .from('schedule_templates').update(patch).eq('id', id).select().single();
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ template: data });
  }

  if (req.method === 'DELETE') {
    if (!isOwner && !isHR) return res.status(403).json({ error: 'NOT_OWNER' });
    // shares 透過 FK CASCADE 自動清
    const { error } = await supabaseAdmin
      .from('schedule_templates').delete().eq('id', id);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ deleted: true });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
