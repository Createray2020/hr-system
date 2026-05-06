import { describe, it, expect, vi } from 'vitest';
import {
  resolveAuthScope,
  resolveAuthScopeWithDeptIds,
} from '../lib/auth-scope.js';

const HR = { id: 'HR1', role: 'hr',       is_manager: false, dept_id: 'D_HR' };
const CEO = { id: 'C1',  role: 'ceo',      is_manager: true,  dept_id: null };
const CHAIRMAN = { id: 'CH1', role: 'chairman', is_manager: false, dept_id: null };
const ADMIN = { id: 'A1', role: 'admin',    is_manager: false, dept_id: null };
const MGR = { id: 'M1',  role: 'employee', is_manager: true,  dept_id: 'D1' };
const MGR_NO_DEPT = { id: 'M2', role: 'employee', is_manager: true, dept_id: null };
const EMP = { id: 'E1',  role: 'employee', is_manager: false, dept_id: 'D1' };

describe('resolveAuthScope — selfOrDept(default)', () => {
  it('HR → all', () => {
    expect(resolveAuthScope(HR)).toEqual({ mode: 'all' });
  });
  it('CEO → all', () => {
    expect(resolveAuthScope(CEO)).toEqual({ mode: 'all' });
  });
  it('chairman → all', () => {
    expect(resolveAuthScope(CHAIRMAN)).toEqual({ mode: 'all' });
  });
  it('admin → all', () => {
    expect(resolveAuthScope(ADMIN)).toEqual({ mode: 'all' });
  });
  it('員工 → self', () => {
    expect(resolveAuthScope(EMP)).toEqual({ mode: 'self', selfId: 'E1' });
  });
  it('純主管 + dept_id → dept', () => {
    expect(resolveAuthScope(MGR)).toEqual({
      mode: 'dept', selfId: 'M1', deptId: 'D1',
    });
  });
  it('純主管 + dept_id=null → fallback self', () => {
    expect(resolveAuthScope(MGR_NO_DEPT)).toEqual({
      mode: 'self', selfId: 'M2',
    });
  });
});

describe('resolveAuthScope — onlySelf(全 self、不分 role)', () => {
  it('HR onlySelf → self', () => {
    expect(resolveAuthScope(HR, 'onlySelf')).toEqual({ mode: 'self', selfId: 'HR1' });
  });
  it('員工 onlySelf → self', () => {
    expect(resolveAuthScope(EMP, 'onlySelf')).toEqual({ mode: 'self', selfId: 'E1' });
  });
  it('主管 onlySelf → self(不擴權)', () => {
    expect(resolveAuthScope(MGR, 'onlySelf')).toEqual({ mode: 'self', selfId: 'M1' });
  });
});

describe('resolveAuthScope — selfOrAll(主管不擴權)', () => {
  it('HR selfOrAll → all', () => {
    expect(resolveAuthScope(HR, 'selfOrAll')).toEqual({ mode: 'all' });
  });
  it('員工 selfOrAll → self', () => {
    expect(resolveAuthScope(EMP, 'selfOrAll')).toEqual({ mode: 'self', selfId: 'E1' });
  });
  it('主管 selfOrAll → self(不變 dept、跟員工同)', () => {
    expect(resolveAuthScope(MGR, 'selfOrAll')).toEqual({ mode: 'self', selfId: 'M1' });
  });
});

describe('resolveAuthScope — 邊界', () => {
  it('null caller → throw', () => {
    expect(() => resolveAuthScope(null)).toThrow(/caller/);
  });
  it('unknown policy → throw', () => {
    expect(() => resolveAuthScope(EMP, 'bogus')).toThrow(/policy/);
  });
});

describe('resolveAuthScopeWithDeptIds — async + repo', () => {
  it('mode=all → 不打 repo、原 scope 返回', async () => {
    const repo = { findActiveEmployeeIdsByDept: vi.fn() };
    const scope = await resolveAuthScopeWithDeptIds(HR, 'selfOrDept', repo);
    expect(scope).toEqual({ mode: 'all' });
    expect(repo.findActiveEmployeeIdsByDept).not.toHaveBeenCalled();
  });

  it('mode=self → 不打 repo', async () => {
    const repo = { findActiveEmployeeIdsByDept: vi.fn() };
    const scope = await resolveAuthScopeWithDeptIds(EMP, 'selfOrDept', repo);
    expect(scope).toEqual({ mode: 'self', selfId: 'E1' });
    expect(repo.findActiveEmployeeIdsByDept).not.toHaveBeenCalled();
  });

  it('mode=dept → 呼 repo、補 deptEmpIds', async () => {
    const repo = {
      findActiveEmployeeIdsByDept: vi.fn().mockResolvedValue(['E1','E2','M1']),
    };
    const scope = await resolveAuthScopeWithDeptIds(MGR, 'selfOrDept', repo);
    expect(scope).toEqual({
      mode: 'dept', selfId: 'M1', deptId: 'D1',
      deptEmpIds: ['E1','E2','M1'],
    });
    expect(repo.findActiveEmployeeIdsByDept).toHaveBeenCalledWith('D1');
  });

  it('mode=dept + repo 缺 method → throw', async () => {
    await expect(resolveAuthScopeWithDeptIds(MGR, 'selfOrDept', null))
      .rejects.toThrow(/findActiveEmployeeIdsByDept/);
  });

  it('mode=dept + repo 回 [] → deptEmpIds=[]', async () => {
    const repo = { findActiveEmployeeIdsByDept: vi.fn().mockResolvedValue([]) };
    const scope = await resolveAuthScopeWithDeptIds(MGR, 'selfOrDept', repo);
    expect(scope.deptEmpIds).toEqual([]);
  });

  it('mode=dept + repo 回 null → deptEmpIds=[]', async () => {
    const repo = { findActiveEmployeeIdsByDept: vi.fn().mockResolvedValue(null) };
    const scope = await resolveAuthScopeWithDeptIds(MGR, 'selfOrDept', repo);
    expect(scope.deptEmpIds).toEqual([]);
  });
});
