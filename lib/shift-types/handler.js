// lib/shift-types/handler.js
// Pure handlers for /api/shift-types CRUD。
// 不做 auth 檢查（route 層負責）；只做 supabase 操作 + 商業規則。
// 回傳 { status, body } 給 route 用 res.status(r.status).json(r.body)。

const ALLOWED_NEW_FIELDS = [
  'name', 'start_time', 'end_time', 'is_flexible', 'is_off', 'color',
  'crosses_midnight', 'break_minutes', 'sort_order', 'is_active',
];
const SYSTEM_EDITABLE_FIELDS = ['color']; // is_system=true 只允許改顏色

export async function listShiftTypes(supabase) {
  const { data, error } = await supabase
    .from('shift_types')
    .select('*')
    .eq('is_active', true)
    .order('sort_order', { ascending: true })
    .order('id', { ascending: true });
  if (error) return { status: 500, body: { error: error.message } };
  return { status: 200, body: data || [] };
}

export async function createShiftType(supabase, body) {
  const { name } = body || {};
  if (!name) return { status: 400, body: { error: '班別名稱為必填' } };

  const { data: rows } = await supabase
    .from('shift_types').select('sort_order')
    .order('sort_order', { ascending: false }).limit(1);
  const nextSort = (rows?.[0]?.sort_order ?? 0) + 1;

  const id = 'ST' + Date.now();
  const row = {
    id,
    name,
    start_time:       body.start_time  || null,
    end_time:         body.end_time    || null,
    is_flexible:      !!body.is_flexible,
    is_off:           !!body.is_off,
    color:            body.color || '#5B8DEF',
    crosses_midnight: !!body.crosses_midnight,
    break_minutes:    body.break_minutes != null ? Number(body.break_minutes) : 60,
    is_system:        false,
    is_active:        true,
    sort_order:       nextSort,
  };
  const { error } = await supabase.from('shift_types').insert([row]);
  if (error) return { status: 500, body: { error: error.message } };
  return { status: 201, body: { id, message: '班別已建立' } };
}

export async function updateShiftType(supabase, id, body) {
  if (!id) return { status: 400, body: { error: 'id required' } };
  const { data: existing } = await supabase
    .from('shift_types').select('*').eq('id', id).maybeSingle();
  if (!existing) return { status: 404, body: { error: 'not found' } };

  const allowed = existing.is_system ? SYSTEM_EDITABLE_FIELDS : ALLOWED_NEW_FIELDS;
  const update = {};
  for (const k of allowed) if (body[k] !== undefined) update[k] = body[k];
  if (Object.keys(update).length === 0) {
    return { status: 400, body: { error: existing.is_system ? '系統班別只能修改 color' : '無可更新欄位' } };
  }
  if (update.break_minutes != null) update.break_minutes = Number(update.break_minutes);
  update.updated_at = new Date().toISOString();

  const { data, error } = await supabase
    .from('shift_types').update(update).eq('id', id).select().single();
  if (error) return { status: 500, body: { error: error.message } };
  return { status: 200, body: data };
}

export async function deleteShiftType(supabase, id) {
  if (!id) return { status: 400, body: { error: 'id required' } };
  const { data: existing } = await supabase
    .from('shift_types').select('*').eq('id', id).maybeSingle();
  if (!existing) return { status: 404, body: { error: 'not found' } };
  if (existing.is_system) {
    return { status: 403, body: { error: '系統班別無法刪除' } };
  }

  const { data: refs } = await supabase
    .from('schedules').select('id').eq('shift_type_id', id).limit(1);
  if (refs && refs.length > 0) {
    return { status: 409, body: { error: '班別已被排班使用、無法刪除（請改設為停用 is_active=false）' } };
  }

  const { error } = await supabase.from('shift_types').delete().eq('id', id);
  if (error) return { status: 500, body: { error: error.message } };
  return { status: 200, body: { message: '已刪除' } };
}
