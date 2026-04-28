// tests/dept-sync.test.js — lib/dept-sync.js 的 dept_id lookup + body.dept 拔除
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
  it('1. 只有 dept_id → 不查 departments、body.dept undefined', async () => {
    const sb = makeSb({ byId: { D1: { name: '研發部' } } });
    const body = { dept_id: 'D1' };
    await syncDeptFields(sb, body);
    expect(body.dept_id).toBe('D1');
    expect(body.dept).toBeUndefined();
  });

  it('2. 只有 dept name → 補 dept_id、body.dept deleted', async () => {
    const sb = makeSb({ byName: { '研發部': { id: 'D1' } } });
    const body = { dept: '研發部' };
    await syncDeptFields(sb, body);
    expect(body.dept_id).toBe('D1');
    expect(body.dept).toBeUndefined();
  });

  it('3. 兩者並存 → dept_id 為主、body.dept deleted', async () => {
    const sb = makeSb({ byId: { D1: { name: '研發部' } } });
    const body = { dept_id: 'D1', dept: '舊部門名' };
    await syncDeptFields(sb, body);
    expect(body.dept_id).toBe('D1');
    expect(body.dept).toBeUndefined();
  });

  it('4. 兩者皆無 → body unchanged (dept undefined)', async () => {
    const sb = makeSb();
    const body = { name: '陳小明' };
    await syncDeptFields(sb, body);
    expect(body.dept_id).toBeUndefined();
    expect(body.dept).toBeUndefined();
    expect(body.name).toBe('陳小明');
  });

  it('5. dept name 找不到 → dept_id null、body.dept deleted', async () => {
    const sb = makeSb();  // byName 空
    const body = { dept: '不存在的部門' };
    await syncDeptFields(sb, body);
    expect(body.dept_id).toBeNull();
    expect(body.dept).toBeUndefined();
  });

  it('6. body 無 dept 屬性 → 不炸 (safety)', async () => {
    const sb = makeSb();
    const body = { name: '陳小明', email: 'test@test.com' };
    await syncDeptFields(sb, body);
    expect(body.name).toBe('陳小明');
    expect(body.email).toBe('test@test.com');
    expect(body.dept).toBeUndefined();
    expect(body.dept_id).toBeUndefined();
  });
});
