// tests/lib-employee-change-logger.test.js — Phase 1.7.2 audit log diff + write
//
// 重點:
//   1. AUDITED_FIELDS 7 欄位才 log、其他變更(avatar 等)忽略
//   2. before/after 同值 → 不 log(避免噪音)
//   3. null/undefined → '(空)'(顯式區分、防 frontend 顯示 'null' 字串)
//   4. boolean / number string-ify(型別比較對稱)
//   5. log 寫入透過注入的 repo.batchInsertChangeLogs

import { describe, it, expect, vi } from 'vitest';
import {
  AUDITED_FIELDS,
  diffEmployeeChanges,
  logEmployeeChanges,
} from '../lib/employee/change-logger.js';

describe('AUDITED_FIELDS 白名單', () => {
  it('包含 7 個關鍵欄位', () => {
    expect(AUDITED_FIELDS).toEqual([
      'name', 'dept_id', 'role', 'is_manager',
      'base_salary', 'position', 'manager_id',
    ]);
  });
});

describe('diffEmployeeChanges — 白名單 + diff 邏輯', () => {
  it('改 dept_id 一個欄位 → 1 change row', () => {
    const before = { id: 'E1', name: 'Alice', dept_id: 'D1', role: 'employee' };
    const after  = { id: 'E1', name: 'Alice', dept_id: 'D2', role: 'employee' };
    const changes = diffEmployeeChanges(before, after);
    expect(changes).toEqual([{
      changed_field: 'dept_id',
      before_value: 'D1',
      after_value: 'D2',
    }]);
  });

  it('改 name + dept_id 兩個 → 2 change row', () => {
    const before = { name: 'Alice', dept_id: 'D1' };
    const after  = { name: 'Bob',   dept_id: 'D2' };
    const changes = diffEmployeeChanges(before, after);
    expect(changes).toHaveLength(2);
    expect(changes.map(c => c.changed_field).sort()).toEqual(['dept_id', 'name']);
  });

  it('沒變化 → 0 change row', () => {
    const before = { name: 'Alice', dept_id: 'D1', role: 'employee', is_manager: false };
    const after  = { name: 'Alice', dept_id: 'D1', role: 'employee', is_manager: false };
    expect(diffEmployeeChanges(before, after)).toEqual([]);
  });

  it('只改非白名單(avatar / phone)→ 0 change row', () => {
    const before = { name: 'Alice', avatar: '🐱', phone: '0911', dept_id: 'D1' };
    const after  = { name: 'Alice', avatar: '🐶', phone: '0922', dept_id: 'D1' };
    expect(diffEmployeeChanges(before, after)).toEqual([]);
  });

  it('after 沒帶該欄位 → 不 log(部分 update 不該誤 diff)', () => {
    const before = { name: 'Alice', dept_id: 'D1' };
    const after  = { name: 'Bob' };  // 只改 name、沒帶 dept_id
    const changes = diffEmployeeChanges(before, after);
    expect(changes).toHaveLength(1);
    expect(changes[0].changed_field).toBe('name');
  });

  it('null → \'(空)\'(顯式文字化、防 frontend 顯示 null 字串)', () => {
    const before = { manager_id: null };
    const after  = { manager_id: 'M1' };
    const changes = diffEmployeeChanges(before, after);
    expect(changes[0]).toEqual({
      changed_field: 'manager_id',
      before_value: '(空)',
      after_value: 'M1',
    });
  });

  it('undefined → \'(空)\'(同 null 處理)', () => {
    const before = { position: undefined };
    const after  = { position: '工程師' };
    const changes = diffEmployeeChanges(before, after);
    expect(changes[0].before_value).toBe('(空)');
  });

  it('is_manager false → true → log "false" → "true"', () => {
    const before = { is_manager: false };
    const after  = { is_manager: true };
    expect(diffEmployeeChanges(before, after)).toEqual([{
      changed_field: 'is_manager',
      before_value: 'false',
      after_value: 'true',
    }]);
  });

  it('is_manager 同值 → 不 log(boolean 比對對稱)', () => {
    expect(diffEmployeeChanges({ is_manager: false }, { is_manager: false })).toEqual([]);
    expect(diffEmployeeChanges({ is_manager: true },  { is_manager: true  })).toEqual([]);
  });

  it('base_salary number 變更 → log 字串化', () => {
    const before = { base_salary: 50000 };
    const after  = { base_salary: 55000 };
    expect(diffEmployeeChanges(before, after)).toEqual([{
      changed_field: 'base_salary',
      before_value: '50000',
      after_value: '55000',
    }]);
  });

  it('base_salary 0 → 50000(0 邊界)', () => {
    expect(diffEmployeeChanges({ base_salary: 0 }, { base_salary: 50000 })).toEqual([{
      changed_field: 'base_salary',
      before_value: '0',
      after_value: '50000',
    }]);
  });

  it('null before/after → 空 array(safe fallback)', () => {
    expect(diffEmployeeChanges(null, { name: 'X' })).toEqual([]);
    expect(diffEmployeeChanges({ name: 'X' }, null)).toEqual([]);
    expect(diffEmployeeChanges(null, null)).toEqual([]);
  });
});

describe('logEmployeeChanges — repo 注入式寫入', () => {
  it('有變更 → 呼叫 repo.batchInsertChangeLogs、回 logged 數', async () => {
    const repo = { batchInsertChangeLogs: vi.fn(async () => {}) };
    const r = await logEmployeeChanges(repo, {
      employee_id: 'E1',
      before: { name: 'Alice', dept_id: 'D1' },
      after:  { name: 'Bob',   dept_id: 'D2' },
      changed_by: 'HR1',
    });
    expect(r.logged).toBe(2);
    expect(repo.batchInsertChangeLogs).toHaveBeenCalledTimes(1);
    const rows = repo.batchInsertChangeLogs.mock.calls[0][0];
    expect(rows).toHaveLength(2);
    expect(rows[0].employee_id).toBe('E1');
    expect(rows[0].changed_by).toBe('HR1');
    expect(rows[0].changed_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('無變更 → 不呼叫 repo、回 logged=0', async () => {
    const repo = { batchInsertChangeLogs: vi.fn(async () => {}) };
    const r = await logEmployeeChanges(repo, {
      employee_id: 'E1',
      before: { name: 'Alice' },
      after:  { name: 'Alice' },
      changed_by: 'HR1',
    });
    expect(r.logged).toBe(0);
    expect(repo.batchInsertChangeLogs).not.toHaveBeenCalled();
  });

  it('changed_by 缺 → 寫 null', async () => {
    const repo = { batchInsertChangeLogs: vi.fn(async () => {}) };
    await logEmployeeChanges(repo, {
      employee_id: 'E1',
      before: { name: 'Alice' },
      after:  { name: 'Bob' },
      changed_by: null,
    });
    const rows = repo.batchInsertChangeLogs.mock.calls[0][0];
    expect(rows[0].changed_by).toBeNull();
  });

  it('employee_id 缺 → throw', async () => {
    const repo = { batchInsertChangeLogs: vi.fn() };
    await expect(logEmployeeChanges(repo, {
      employee_id: null, before: {}, after: {}, changed_by: 'X',
    })).rejects.toThrow(/employee_id/);
  });

  it('repo 沒 batchInsertChangeLogs → throw', async () => {
    await expect(logEmployeeChanges({}, {
      employee_id: 'E1', before: { name: 'X' }, after: { name: 'Y' }, changed_by: 'HR1',
    })).rejects.toThrow(/batchInsertChangeLogs/);
  });
});
