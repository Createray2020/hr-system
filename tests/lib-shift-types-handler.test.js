// Unit tests for lib/shift-types/handler.js — pure handler、不需 mock auth。
// 用最小化 supabase fake：from(table) 回 chainable + 預設 response queue。

import { describe, it, expect } from 'vitest';
import {
  listShiftTypes, createShiftType, updateShiftType, deleteShiftType,
} from '../lib/shift-types/handler.js';

// 建立一個可以 stub response 的 supabase fake。
// usage:
//   const sb = makeFakeSupabase({
//     'shift_types': { selectRows: [...], maybeSingle: {...}, insertError: null, updateRow: {...} },
//     'schedules':   { selectRows: [...] },
//   });
function makeFakeSupabase(tables = {}) {
  const calls = { from: [], inserted: [], updated: [], deleted: [], lastTable: null };
  function chain(table) {
    const t = tables[table] || {};
    const c = {};
    const passthrough = ['select', 'order', 'eq', 'gte', 'lte', 'in', 'is', 'limit'];
    for (const k of passthrough) c[k] = (..._args) => c;
    c.insert = (rows) => { calls.inserted.push({ table, rows }); return c; };
    c.update = (patch) => { calls.updated.push({ table, patch }); return c; };
    c.delete = () => { calls.deleted.push({ table }); return c; };
    c.maybeSingle = () => Promise.resolve({ data: t.maybeSingle ?? null, error: null });
    c.single = () => Promise.resolve({ data: t.singleRow ?? null, error: null });
    c.then = (onF, onR) => Promise.resolve(
      t.error ? { data: null, error: t.error } : { data: t.selectRows ?? [], error: null }
    ).then(onF, onR);
    return c;
  }
  return {
    calls,
    from: (table) => { calls.from.push(table); calls.lastTable = table; return chain(table); },
  };
}

describe('listShiftTypes', () => {
  it('回傳 active=true、按 sort_order 排序的清單', async () => {
    const sb = makeFakeSupabase({
      shift_types: {
        selectRows: [
          { id: 'ST003', name: '休假日', sort_order: 1, is_active: true },
          { id: 'ST001', name: '早班',   sort_order: 3, is_active: true },
        ],
      },
    });
    const r = await listShiftTypes(sb);
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body)).toBe(true);
    expect(r.body.length).toBe(2);
    expect(sb.calls.from[0]).toBe('shift_types');
  });
});

describe('createShiftType', () => {
  it('缺 name → 400', async () => {
    const sb = makeFakeSupabase();
    const r = await createShiftType(sb, {});
    expect(r.status).toBe(400);
  });

  it('正常 → 201、insert 一筆 with is_system=false / sort_order=max+1', async () => {
    const sb = makeFakeSupabase({
      // 第一次 query: 取 max sort_order — 走 thenable resolve selectRows
      shift_types: { selectRows: [{ sort_order: 5 }] },
    });
    const r = await createShiftType(sb, { name: '夜班', color: '#FF0000', is_off: false });
    expect(r.status).toBe(201);
    expect(r.body.id).toMatch(/^ST/);
    expect(sb.calls.inserted.length).toBe(1);
    const row = sb.calls.inserted[0].rows[0];
    expect(row.name).toBe('夜班');
    expect(row.is_system).toBe(false);
    expect(row.is_active).toBe(true);
    expect(row.sort_order).toBe(6); // 5 + 1
    expect(row.color).toBe('#FF0000');
    expect(row.break_minutes).toBe(60); // default
  });

  it('沒任何現有 sort_order → 從 1 開始', async () => {
    const sb = makeFakeSupabase({ shift_types: { selectRows: [] } });
    const r = await createShiftType(sb, { name: '彈性班' });
    expect(r.status).toBe(201);
    expect(sb.calls.inserted[0].rows[0].sort_order).toBe(1);
  });
});

describe('updateShiftType', () => {
  it('id 不存在 → 404', async () => {
    const sb = makeFakeSupabase({ shift_types: { maybeSingle: null } });
    const r = await updateShiftType(sb, 'ST999', { name: 'X' });
    expect(r.status).toBe(404);
  });

  it('系統班別只允許改 color', async () => {
    const sb = makeFakeSupabase({
      shift_types: {
        maybeSingle: { id: 'ST001', is_system: true, name: '早班' },
        singleRow:   { id: 'ST001', is_system: true, name: '早班', color: '#000000' },
      },
    });
    // 嘗試改 name 應被忽略、留下 0 個 update field → 400
    const r1 = await updateShiftType(sb, 'ST001', { name: '改名' });
    expect(r1.status).toBe(400);
    expect(r1.body.error).toMatch(/系統班別/);

    // 改 color OK
    const r2 = await updateShiftType(sb, 'ST001', { color: '#000000' });
    expect(r2.status).toBe(200);
    expect(sb.calls.updated[0].patch.color).toBe('#000000');
    expect(sb.calls.updated[0].patch.name).toBeUndefined();
  });

  it('非系統班別 → 全欄位可改', async () => {
    const sb = makeFakeSupabase({
      shift_types: {
        maybeSingle: { id: 'ST_custom', is_system: false },
        singleRow:   { id: 'ST_custom', name: '新名' },
      },
    });
    const r = await updateShiftType(sb, 'ST_custom', { name: '新名', is_active: false });
    expect(r.status).toBe(200);
    expect(sb.calls.updated[0].patch.name).toBe('新名');
    expect(sb.calls.updated[0].patch.is_active).toBe(false);
  });
});

describe('deleteShiftType', () => {
  it('id 不存在 → 404', async () => {
    const sb = makeFakeSupabase({ shift_types: { maybeSingle: null } });
    const r = await deleteShiftType(sb, 'ST999');
    expect(r.status).toBe(404);
  });

  it('系統班別 → 403', async () => {
    const sb = makeFakeSupabase({
      shift_types: { maybeSingle: { id: 'ST001', is_system: true } },
    });
    const r = await deleteShiftType(sb, 'ST001');
    expect(r.status).toBe(403);
  });

  it('被 schedules 引用 → 409', async () => {
    // 第一個 from('shift_types') 取 existing；第二個 from('schedules') 取 refs。
    // makeFakeSupabase 對所有 table 共用同 selectRows，所以拆開。
    const sb = {
      calls: { from: [] },
      from(table) {
        sb.calls.from.push(table);
        const c = {};
        const passthrough = ['select','order','eq','gte','lte','in','is','limit'];
        for (const k of passthrough) c[k] = () => c;
        c.maybeSingle = () => Promise.resolve({
          data: { id: 'ST_custom', is_system: false }, error: null,
        });
        c.then = (onF, onR) => Promise.resolve({
          data: table === 'schedules' ? [{ id: 'SCH1' }] : [],
          error: null,
        }).then(onF, onR);
        c.delete = () => c;
        return c;
      },
    };
    const r = await deleteShiftType(sb, 'ST_custom');
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/已被排班使用/);
  });

  it('未被引用 + 非系統 → 200', async () => {
    const sb = {
      from(table) {
        const c = {};
        const passthrough = ['select','order','eq','gte','lte','in','is','limit'];
        for (const k of passthrough) c[k] = () => c;
        c.maybeSingle = () => Promise.resolve({
          data: { id: 'ST_custom', is_system: false }, error: null,
        });
        c.then = (onF, onR) => Promise.resolve({ data: [], error: null }).then(onF, onR);
        c.delete = () => c;
        return c;
      },
    };
    const r = await deleteShiftType(sb, 'ST_custom');
    expect(r.status).toBe(200);
  });
});
