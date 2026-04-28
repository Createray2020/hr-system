// tests/dept-sync.test.js — lib/dept-sync.js 雙向同步覆蓋
import { describe, it, expect } from 'vitest';
import { syncDeptFields } from '../lib/dept-sync.js';

// 簡易 supabase mock：傳入 byId / byName 兩個 lookup map
function makeSb({ byId = {}, byName = {} } = {}) {
  return {
    from(_table) {
      return {
        select(_cols) {
          return {
            eq(col, val) {
              return {
                async maybeSingle() {
                  if (col === 'id')   return { data: byId[val]   || null, error: null };
                  if (col === 'name') return { data: byName[val] || null, error: null };
                  return { data: null, error: null };
                },
              };
            },
          };
        },
      };
    },
  };
}

describe('syncDeptFields', () => {
  it('1. 只有 dept_id → 補 dept name', async () => {
    const sb = makeSb({ byId: { D1: { name: '研發部' } } });
    const body = { dept_id: 'D1' };
    await syncDeptFields(sb, body);
    expect(body.dept).toBe('研發部');
    expect(body.dept_id).toBe('D1');
  });

  it('2. 只有 dept name → 補 dept_id', async () => {
    const sb = makeSb({ byName: { '研發部': { id: 'D1' } } });
    const body = { dept: '研發部' };
    await syncDeptFields(sb, body);
    expect(body.dept_id).toBe('D1');
    expect(body.dept).toBe('研發部');
  });

  it('3. 兩者並存 → dept_id 為主、覆寫 dept name 對齊', async () => {
    const sb = makeSb({ byId: { D1: { name: '研發部' } } });
    const body = { dept_id: 'D1', dept: '舊部門名' };
    await syncDeptFields(sb, body);
    expect(body.dept).toBe('研發部');
    expect(body.dept_id).toBe('D1');
  });

  it('4. 兩者皆無 → 不動 body', async () => {
    const sb = makeSb();
    const body = { name: '陳小明' };
    await syncDeptFields(sb, body);
    expect(body.dept).toBeUndefined();
    expect(body.dept_id).toBeUndefined();
    expect(body.name).toBe('陳小明');
  });

  it('5. 只有 dept name 但 departments 找不到 → dept_id NULL、保留 dept', async () => {
    const sb = makeSb();  // byName 空
    const body = { dept: '不存在的部門' };
    await syncDeptFields(sb, body);
    expect(body.dept_id).toBeNull();
    expect(body.dept).toBe('不存在的部門');
  });

  it('6. dept_id 找不到對應 row → 保留前端送的 dept、dept_id 不動', async () => {
    const sb = makeSb();  // byId 空
    const body = { dept_id: 'D_GHOST', dept: '原始 dept' };
    await syncDeptFields(sb, body);
    expect(body.dept).toBe('原始 dept');
    expect(body.dept_id).toBe('D_GHOST');
  });
});
