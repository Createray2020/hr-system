// GPS Phase A:office_locations CRUD endpoint(HR 後台據點管理)
// - GET:list;HR 看全部、員工/主管只看 is_active=true(打卡時前端拿來算 GPS)
// - POST:HR only、create new location
// 對應前端:attendance-locations-admin.html(A.4)+ 員工 attendance.html / employee-app.html 拉清單

import { supabaseAdmin } from '../../lib/supabase.js';
import { requireAuth, requireRole } from '../../lib/auth.js';
import { BACKOFFICE_ROLES, isBackofficeRole } from '../../lib/roles.js';

const SELECT_COLS =
  'id, name, lat, lng, radius_m, is_active, note, created_at, updated_at';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') {
    const caller = await requireAuth(req, res);
    if (!caller) return;

    let q = supabaseAdmin
      .from('office_locations')
      .select(SELECT_COLS)
      .order('is_active', { ascending: false })
      .order('name', { ascending: true });

    // 非 HR 只看 active(打卡時拉清單用)
    if (!isBackofficeRole(caller)) {
      q = q.eq('is_active', true);
    }

    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json(data || []);
  }

  if (req.method === 'POST') {
    const caller = await requireRole(req, res, BACKOFFICE_ROLES);
    if (!caller) return;

    const body = req.body || {};
    const validation = validateLocationInput(body, { isCreate: true });
    if (!validation.ok) {
      return res.status(400).json({ error: 'INVALID_INPUT', detail: validation.detail });
    }

    const row = {
      id:         body.id.trim(),
      name:       body.name.trim(),
      lat:        Number(body.lat),
      lng:        Number(body.lng),
      radius_m:   body.radius_m == null ? 150 : parseInt(body.radius_m),
      is_active:  body.is_active === false ? false : true,
      note:       body.note ?? null,
    };

    // id 重複 → 409
    const { data: existing } = await supabaseAdmin
      .from('office_locations').select('id').eq('id', row.id).maybeSingle();
    if (existing) {
      return res.status(409).json({ error: 'DUPLICATE_ID', id: row.id });
    }

    const { data, error } = await supabaseAdmin
      .from('office_locations').insert([row]).select(SELECT_COLS).single();
    if (error) return res.status(500).json({ error: error.message });
    return res.status(201).json(data);
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

// ─── shared validation(POST + PUT 用)─────────────────────────
// isCreate=true:id / name / lat / lng 必填
// isCreate=false(PUT partial):欄位有給才驗、白名單外無視
export function validateLocationInput(body, { isCreate = false } = {}) {
  // id(只 POST 驗)
  if (isCreate) {
    if (!body.id || typeof body.id !== 'string') return fail('id 必填');
    const id = body.id.trim();
    if (id.length === 0) return fail('id 不可為空');
    if (id.length > 50) return fail('id 不可超過 50 字');
    if (/\s/.test(id))  return fail('id 不可有空白');
  }
  // name
  if (isCreate || body.name !== undefined) {
    if (!body.name || typeof body.name !== 'string') return fail('name 必填');
    const name = body.name.trim();
    if (name.length === 0)   return fail('name 不可為空');
    if (name.length > 100)   return fail('name 不可超過 100 字');
  }
  // lat
  if (isCreate || body.lat !== undefined) {
    const lat = Number(body.lat);
    if (!Number.isFinite(lat))           return fail('lat 必須為數字');
    if (lat < -90 || lat > 90)           return fail('lat 必須 ∈ [-90, 90]');
  }
  // lng
  if (isCreate || body.lng !== undefined) {
    const lng = Number(body.lng);
    if (!Number.isFinite(lng))           return fail('lng 必須為數字');
    if (lng < -180 || lng > 180)         return fail('lng 必須 ∈ [-180, 180]');
  }
  // radius_m(可選、有給才驗)
  if (body.radius_m !== undefined && body.radius_m !== null) {
    const r = Number(body.radius_m);
    if (!Number.isInteger(r))            return fail('radius_m 必須為整數');
    if (r < 1 || r > 5000)               return fail('radius_m 必須 ∈ [1, 5000]');
  }
  return { ok: true };
}

function fail(detail) {
  return { ok: false, detail };
}
