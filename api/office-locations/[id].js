// GPS Phase A:office_locations 單筆操作(GET / PUT / DELETE)
// - DELETE 是軟刪(set is_active=false)、不破壞既有 attendance.location_id FK

import { supabaseAdmin } from '../../lib/supabase.js';
import { requireAuth, requireRole } from '../../lib/auth.js';
import { BACKOFFICE_ROLES, isBackofficeRole } from '../../lib/roles.js';
import { validateLocationInput } from './index.js';

const SELECT_COLS =
  'id, name, lat, lng, radius_m, is_active, note, created_at, updated_at';

const PUT_WHITELIST = new Set(['name', 'lat', 'lng', 'radius_m', 'note', 'is_active']);

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  const id = req.query.id;
  if (!id) return res.status(400).json({ error: 'location id required' });

  if (req.method === 'GET') {
    const caller = await requireAuth(req, res);
    if (!caller) return;

    let q = supabaseAdmin
      .from('office_locations').select(SELECT_COLS).eq('id', id);
    // 非 HR 只能看 active(找不到回 404)
    if (!isBackofficeRole(caller)) q = q.eq('is_active', true);
    const { data, error } = await q.maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: 'location not found' });
    return res.status(200).json(data);
  }

  if (req.method === 'PUT') {
    const caller = await requireRole(req, res, BACKOFFICE_ROLES);
    if (!caller) return;

    const body = req.body || {};
    const validation = validateLocationInput(body, { isCreate: false });
    if (!validation.ok) {
      return res.status(400).json({ error: 'INVALID_INPUT', detail: validation.detail });
    }

    // 白名單 6 個欄位、其他(id / created_at)忽略
    const patch = {};
    for (const k of Object.keys(body)) {
      if (!PUT_WHITELIST.has(k)) continue;
      patch[k] = body[k];
    }
    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ error: 'no allowed fields to update' });
    }
    patch.updated_at = new Date().toISOString();

    // 確認 row 存在
    const { data: existing } = await supabaseAdmin
      .from('office_locations').select('id').eq('id', id).maybeSingle();
    if (!existing) return res.status(404).json({ error: 'location not found' });

    const { data, error } = await supabaseAdmin
      .from('office_locations').update(patch).eq('id', id)
      .select(SELECT_COLS).single();
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json(data);
  }

  if (req.method === 'DELETE') {
    const caller = await requireRole(req, res, BACKOFFICE_ROLES);
    if (!caller) return;

    // 確認 row 存在
    const { data: existing } = await supabaseAdmin
      .from('office_locations').select('id').eq('id', id).maybeSingle();
    if (!existing) return res.status(404).json({ error: 'location not found' });

    // 軟刪、保 FK history
    const { error } = await supabaseAdmin
      .from('office_locations')
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq('id', id);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true, deleted_id: id });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
