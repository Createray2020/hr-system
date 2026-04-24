// tests/dept-manager-sync.test.js
// 驗 §6.2 部門主管同步 T1-T11
//
// 測試對象：syncDeptManagerFlag（從 api/employees/index.js export）
// 由於 handler-level 的 PUT 「不含 manager_id 欄位 → 不呼叫 syncDeptManagerFlag」（T7）
// 是 handler 程式碼中的 if 守衛，本測試以 syncDeptManagerFlag 角度驗：
// 「沒呼叫就什麼都沒發生」（不呼叫 = 不影響 is_manager）。
// T7 額外用 source-grep 驗 handler 確實有 managerIdChanging 守衛。

import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Stub lib/supabase.js 以免 import api/employees/index.js 時要求 env
vi.mock('../lib/supabase.js', () => ({ supabase: {} }));

const { syncDeptManagerFlag } = await import('../api/employees/index.js');

// ── Mock supabase：模擬 employees + departments 兩張表 ──
// 支援的呼叫形式：
//   from(t).select(arg, {count, head}).eq(col, val)              → 回 {data, count}
//   from(t).update(patch).eq(col, val)                           → 套用 update
function makeFakeDb(initial) {
  const state = {
    employees:   structuredClone(initial.employees   || []),
    departments: structuredClone(initial.departments || []),
  };

  function makeQuery(table, mode) {
    const ctx = { mode, eqFilters: [], wantCount: false, head: false, patch: null };
    const q = {
      eq(col, val) { ctx.eqFilters.push([col, val]); return this; },
      then(resolve) {
        const rows = state[table].filter(r =>
          ctx.eqFilters.every(([c, v]) => r[c] === v));
        if (ctx.mode === 'update') {
          for (const r of rows) Object.assign(r, ctx.patch);
          resolve({ data: null, error: null });
        } else if (ctx.wantCount) {
          resolve({ count: rows.length, data: ctx.head ? null : rows, error: null });
        } else {
          resolve({ data: rows, error: null });
        }
      },
    };
    if (mode === 'select') {
      q._configSelect = (opts = {}) => {
        ctx.head = !!opts.head;
        ctx.wantCount = opts.count === 'exact';
      };
    }
    if (mode === 'update') {
      q._setPatch = (patch) => { ctx.patch = patch; };
    }
    return q;
  }

  const sb = {
    from(table) {
      return {
        select(_arg, opts = {}) {
          const q = makeQuery(table, 'select');
          q._configSelect(opts);
          return q;
        },
        update(patch) {
          const q = makeQuery(table, 'update');
          q._setPatch(patch);
          return q;
        },
      };
    },
    _state: state,
  };
  return sb;
}

function emp(id, is_manager = false) {
  return { id, name: id, role: 'employee', is_manager, status: 'active' };
}
function dept(id, manager_id = null) {
  return { id, name: id, manager_id };
}
function isManager(sb, id) {
  return sb._state.employees.find(e => e.id === id)?.is_manager;
}

describe('syncDeptManagerFlag — §6.2 T1-T11', () => {
  // T1: POST 新部門 D1, manager_id=A → A.is_manager=true
  it('T1: 指派 A 為新部門 D1 主管 → A.is_manager=true', async () => {
    const sb = makeFakeDb({
      employees: [emp('A', false)],
      departments: [dept('D1', 'A')],   // 模擬 insert 已完成
    });
    await syncDeptManagerFlag({ oldManagerId: null, newManagerId: 'A' }, sb);
    expect(isManager(sb, 'A')).toBe(true);
  });

  // T2: PUT D1 manager_id A→B → A.is_manager=false（A 無其他部門）, B.is_manager=true
  it('T2: 換主管 A→B（A 無其他部門）→ A=false, B=true', async () => {
    const sb = makeFakeDb({
      employees: [emp('A', true), emp('B', false)],
      departments: [dept('D1', 'B')],   // 已換成 B
    });
    await syncDeptManagerFlag({ oldManagerId: 'A', newManagerId: 'B' }, sb);
    expect(isManager(sb, 'A')).toBe(false);
    expect(isManager(sb, 'B')).toBe(true);
  });

  // T3: PUT D1 manager_id B→A → B=false, A=true
  it('T3: 換回 A（B 無其他部門）→ A=true, B=false', async () => {
    const sb = makeFakeDb({
      employees: [emp('A', false), emp('B', true)],
      departments: [dept('D1', 'A')],
    });
    await syncDeptManagerFlag({ oldManagerId: 'B', newManagerId: 'A' }, sb);
    expect(isManager(sb, 'A')).toBe(true);
    expect(isManager(sb, 'B')).toBe(false);
  });

  // T4: POST D2 manager_id=A（A 已管 D1）→ A 仍 true（idempotent）
  it('T4: A 同時管 D1+D2 → A 維持 true', async () => {
    const sb = makeFakeDb({
      employees: [emp('A', true)],
      departments: [dept('D1', 'A'), dept('D2', 'A')],
    });
    await syncDeptManagerFlag({ oldManagerId: null, newManagerId: 'A' }, sb);
    expect(isManager(sb, 'A')).toBe(true);
  });

  // T5: PUT D1 manager_id A→C（A 仍管 D2）→ A 維持 true, C=true
  it('T5: 換 D1 主管為 C 但 A 仍管 D2 → A=true 不降級, C=true', async () => {
    const sb = makeFakeDb({
      employees: [emp('A', true), emp('C', false)],
      departments: [dept('D1', 'C'), dept('D2', 'A')],
    });
    await syncDeptManagerFlag({ oldManagerId: 'A', newManagerId: 'C' }, sb);
    expect(isManager(sb, 'A')).toBe(true);
    expect(isManager(sb, 'C')).toBe(true);
  });

  // T6: PUT D1 manager_id=null（清空）→ 若該主管無其他 dept 則降級
  it('T6a: 清空 D1 主管，原主管 X 無其他部門 → X=false', async () => {
    const sb = makeFakeDb({
      employees: [emp('X', true)],
      departments: [dept('D1', null)],
    });
    await syncDeptManagerFlag({ oldManagerId: 'X', newManagerId: null }, sb);
    expect(isManager(sb, 'X')).toBe(false);
  });
  it('T6b: 清空 D1 主管但 X 仍管 D3 → X 維持 true', async () => {
    const sb = makeFakeDb({
      employees: [emp('X', true)],
      departments: [dept('D1', null), dept('D3', 'X')],
    });
    await syncDeptManagerFlag({ oldManagerId: 'X', newManagerId: null }, sb);
    expect(isManager(sb, 'X')).toBe(true);
  });

  // T7: handler 有 managerIdChanging 守衛 — 用 source-grep 驗
  it('T7: handler 在 PUT 不含 manager_id 時不呼叫 syncDeptManagerFlag（source check）', () => {
    const __dir = path.dirname(fileURLToPath(import.meta.url));
    const src = fs.readFileSync(path.join(__dir, '../api/employees/index.js'), 'utf8');
    expect(src).toMatch(/managerIdChanging\s*=\s*Object\.prototype\.hasOwnProperty\.call\(req\.body,\s*'manager_id'\)/);
    expect(src).toMatch(/if\s*\(managerIdChanging\)\s*\{[^}]*syncDeptManagerFlag/s);
  });

  // T8: DELETE D2（A 只管 D2）→ A=false
  it('T8: DELETE A 唯一管的部門 → A=false', async () => {
    const sb = makeFakeDb({
      employees: [emp('A', true)],
      departments: [],   // 模擬 D2 已被 delete
    });
    await syncDeptManagerFlag({ oldManagerId: 'A', newManagerId: null }, sb);
    expect(isManager(sb, 'A')).toBe(false);
  });

  // T9: DELETE D2（A 還管 D1）→ A 維持 true
  it('T9: DELETE 一個部門但 A 還管另一個 → A 維持 true', async () => {
    const sb = makeFakeDb({
      employees: [emp('A', true)],
      departments: [dept('D1', 'A')],   // D2 已刪，D1 還在
    });
    await syncDeptManagerFlag({ oldManagerId: 'A', newManagerId: null }, sb);
    expect(isManager(sb, 'A')).toBe(true);
  });

  // T10: Excel 匯入 2 行同一主管 → idempotent
  it('T10: Excel 連續 POST 兩個部門指到同一主管 → idempotent', async () => {
    const sb = makeFakeDb({
      employees: [emp('A', false)],
      departments: [],
    });
    // 模擬第 1 個 POST
    sb._state.departments.push(dept('D1', 'A'));
    await syncDeptManagerFlag({ oldManagerId: null, newManagerId: 'A' }, sb);
    expect(isManager(sb, 'A')).toBe(true);
    // 模擬第 2 個 POST
    sb._state.departments.push(dept('D2', 'A'));
    await syncDeptManagerFlag({ oldManagerId: null, newManagerId: 'A' }, sb);
    expect(isManager(sb, 'A')).toBe(true);
  });

  // T11: Excel 匯入主管解析失敗 → manager_id=null → no-op
  it('T11: 找不到 manager_emp_no → newManagerId=null → 不影響 is_manager', async () => {
    const sb = makeFakeDb({
      employees: [emp('A', false)],
      departments: [],
    });
    await syncDeptManagerFlag({ oldManagerId: null, newManagerId: null }, sb);
    expect(isManager(sb, 'A')).toBe(false);
  });
});
