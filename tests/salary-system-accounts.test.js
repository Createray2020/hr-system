// tests/salary-system-accounts.test.js
//
// 抓 hot fix 行為:EMP_99999999 系統管理員不進薪資計算。
// 涵蓋:
//   - SYSTEM_ACCOUNT_IDS 常數內容
//   - isSystemAccount() pure judgement
//   - excludeSystemAccounts() pure filter(belt-and-suspenders、防 query 漏接)
//   - applyExcludeSystemAccountsQuery() supabase chain manipulation
//   - 整合驗證: batch_v2 模擬 enum 後 results 不含 EMP_99999999

import { describe, it, expect } from 'vitest';
import {
  SYSTEM_ACCOUNT_IDS,
  isSystemAccount,
  excludeSystemAccounts,
  applyExcludeSystemAccountsQuery,
} from '../lib/salary/system-accounts.js';

describe('SYSTEM_ACCOUNT_IDS', () => {
  it('含 EMP_99999999', () => {
    expect(SYSTEM_ACCOUNT_IDS).toContain('EMP_99999999');
  });
  it('frozen 防修改', () => {
    expect(Object.isFrozen(SYSTEM_ACCOUNT_IDS)).toBe(true);
  });
});

describe('isSystemAccount', () => {
  it('EMP_99999999 → true', () => {
    expect(isSystemAccount('EMP_99999999')).toBe(true);
  });
  it('真實員工(EMP_01xxx 正職)→ false', () => {
    expect(isSystemAccount('EMP_01250501')).toBe(false);
    expect(isSystemAccount('EMP_01200115')).toBe(false);
  });
  it('真實兼職(EMP_02xxx)→ false(不能誤擋)', () => {
    expect(isSystemAccount('EMP_02240301')).toBe(false);
    expect(isSystemAccount('EMP_02230710')).toBe(false);
  });
  it('null / undefined / 空字串 → false(不該爆)', () => {
    expect(isSystemAccount(null)).toBe(false);
    expect(isSystemAccount(undefined)).toBe(false);
    expect(isSystemAccount('')).toBe(false);
  });
});

describe('excludeSystemAccounts', () => {
  it('過濾 EMP_99999999、保留其他', () => {
    const list = [
      { id: 'EMP_01250501', name: '劉嘉昕' },
      { id: 'EMP_99999999', name: '系統管理員' },
      { id: 'EMP_02240301', name: '兼職 A' },
    ];
    const r = excludeSystemAccounts(list);
    expect(r).toHaveLength(2);
    expect(r.map(e => e.id)).toEqual(['EMP_01250501', 'EMP_02240301']);
  });
  it('null / undefined / 空 array → []', () => {
    expect(excludeSystemAccounts(null)).toEqual([]);
    expect(excludeSystemAccounts(undefined)).toEqual([]);
    expect(excludeSystemAccounts([])).toEqual([]);
  });
  it('list 全部都是系統帳號 → []', () => {
    expect(excludeSystemAccounts([{ id: 'EMP_99999999' }])).toEqual([]);
  });
  it('list element 沒 id → 不擋(寬容、防 schema 變動)', () => {
    expect(excludeSystemAccounts([{ name: 'no-id' }])).toEqual([{ name: 'no-id' }]);
  });
});

describe('applyExcludeSystemAccountsQuery', () => {
  it('串 supabase chain .neq("id", "EMP_99999999")', () => {
    const calls = [];
    const q = {
      neq: (col, val) => { calls.push({ col, val }); return q; },
    };
    const result = applyExcludeSystemAccountsQuery(q);
    expect(calls).toEqual([{ col: 'id', val: 'EMP_99999999' }]);
    expect(result).toBe(q);  // chainable
  });
});

describe('整合: batch_v2 enum 模擬 → 結果不含 EMP_99999999', () => {
  // 模擬 handleNewBatch 撈員工後跑 calc loop 的行為:
  //   1. listActiveEmployees 已先 .neq() 過濾(repo 層)
  //   2. excludeSystemAccounts 再 client-side 過濾(handleNewBatch 防禦)
  //   3. loop 對每個 emp 跑 calculator、收集 results
  it('repo 已過濾 + client 再過濾 → results 全是真員工', () => {
    // 模擬 repo 已用 .neq() 過濾後的回傳
    const fromRepo = [
      { id: 'EMP_01250501' },
      { id: 'EMP_02240301' },
      { id: 'EMP_01200115' },
    ];
    const targets = excludeSystemAccounts(fromRepo);
    const results = targets.map(emp => ({ employee_id: emp.id, ok: true }));
    expect(results.map(r => r.employee_id)).not.toContain('EMP_99999999');
    expect(results).toHaveLength(3);
  });

  it('repo 漏接(假設 .neq 沒生效)→ client 還是擋下', () => {
    // 假設 repo 漏了 .neq、回傳含系統帳號的 list
    const fromRepoUnfiltered = [
      { id: 'EMP_01250501' },
      { id: 'EMP_99999999' },
      { id: 'EMP_02240301' },
    ];
    const targets = excludeSystemAccounts(fromRepoUnfiltered);
    const results = targets.map(emp => ({ employee_id: emp.id, ok: true }));
    expect(results.map(r => r.employee_id)).not.toContain('EMP_99999999');
    expect(results).toHaveLength(2);
  });

  it('explicit employee_id = EMP_99999999 → guard 擋下(模擬 handleNewBatch / recalculate)', () => {
    // 模擬 endpoint 對 explicit employee_id 的 guard:
    //   if (isSystemAccount(employee_id)) return 400
    const explicitId = 'EMP_99999999';
    expect(isSystemAccount(explicitId)).toBe(true);  // → endpoint 該回 400
  });
});
