// api/schedule-templates/index.js
// GET  /api/schedule-templates           list (own + share-to-me + is_shared=true)
// GET  /api/schedule-templates?owner_id=X  backoffice 看任一 owner
// POST /api/schedule-templates { name, description?, pattern, is_shared? }
//
// C8-1：班表模板 CRUD（Shape A weekly only）

import { supabaseAdmin } from '../../lib/supabase.js';
import { requireAuth } from '../../lib/auth.js';
import { isBackofficeRole } from '../../lib/roles.js';

// pattern shape 驗證（weekly only）
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
  if (req.method === 'GET')  return handleGet(req, res, caller);
  if (req.method === 'POST') return handlePost(req, res, caller);
  return res.status(405).json({ error: 'Method not allowed' });
}

async function handleGet(req, res, caller) {
  const { owner_id } = req.query;
  const isHR = isBackofficeRole(caller);

  // backoffice 查任一 owner
  if (owner_id) {
    if (!isHR) return res.status(403).json({ error: 'NOT_BACKOFFICE' });
    const { data, error } = await supabaseAdmin
      .from('schedule_templates').select('*')
      .eq('owner_id', owner_id)
      .order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json(data || []);
  }

  // 一般查詢：own + is_shared=true + share-to-me
  const [
    { data: owned, error: oErr },
    { data: globalShared, error: gErr },
    { data: myShares },
  ] = await Promise.all([
    supabaseAdmin.from('schedule_templates').select('*').eq('owner_id', caller.id),
    supabaseAdmin.from('schedule_templates').select('*').eq('is_shared', true).neq('owner_id', caller.id),
    supabaseAdmin.from('schedule_template_shares').select('template_id').eq('shared_to_id', caller.id),
  ]);
  if (oErr) return res.status(500).json({ error: oErr.message });
  if (gErr) return res.status(500).json({ error: gErr.message });

  const sharedIds = (myShares || []).map(s => s.template_id);
  let individualShared = [];
  if (sharedIds.length) {
    const { data } = await supabaseAdmin
      .from('schedule_templates').select('*').in('id', sharedIds);
    individualShared = data || [];
  }

  const all = [...(owned || []), ...(globalShared || []), ...individualShared];
  const dedupe = new Map(all.map(t => [t.id, t]));
  const result = [...dedupe.values()].sort((a, b) =>
    (b.created_at || '').localeCompare(a.created_at || '')
  );
  return res.status(200).json(result);
}

async function handlePost(req, res, caller) {
  const { name, description, pattern, is_shared } = req.body || {};
  if (!name || typeof name !== 'string') return res.status(400).json({ error: 'NAME_REQUIRED' });
  const patternErr = validatePattern(pattern);
  if (patternErr) return res.status(400).json({ error: patternErr });

  // is_shared=true 限主管/HR/CEO
  if (is_shared && !isBackofficeRole(caller) && !caller.is_manager) {
    return res.status(403).json({ error: 'CANNOT_SHARE_GLOBALLY' });
  }

  const id = `TPL_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const row = {
    id,
    owner_id: caller.id,
    name,
    description: description || '',
    pattern,
    is_shared: !!is_shared,
  };

  const { data, error } = await supabaseAdmin
    .from('schedule_templates').insert([row]).select().single();
  if (error) return res.status(500).json({ error: error.message });
  return res.status(201).json({ template: data });
}
