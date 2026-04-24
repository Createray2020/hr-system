import { describe, it, expect } from 'vitest';
import {
  canManageAuthAccounts,
  canAccessBackoffice,
  canViewAllApprovals,
  canEditApprovalConfig,
  canManageAnnouncements,
  canWriteDepartments,
  isDepartmentManager,
  skipAttendanceBonus,
  effectiveApprovalRole,
  resolveRoleSetToEmployeeIds,
  resolveApproverRoleToEmployeeIds,
} from '../lib/roles.js';

const ROLES = ['employee', 'hr', 'ceo', 'chairman', 'admin'];
const emp = (role, is_manager = false) => ({ role, is_manager });

describe('canManageAuthAccounts', () => {
  it('只允許 hr / chairman / admin', () => {
    expect(canManageAuthAccounts(emp('hr'))).toBe(true);
    expect(canManageAuthAccounts(emp('chairman'))).toBe(true);
    expect(canManageAuthAccounts(emp('admin'))).toBe(true);
    expect(canManageAuthAccounts(emp('ceo'))).toBe(false);
    expect(canManageAuthAccounts(emp('employee'))).toBe(false);
  });
  it('is_manager 不影響', () => {
    expect(canManageAuthAccounts(emp('employee', true))).toBe(false);
    expect(canManageAuthAccounts(emp('ceo', true))).toBe(false);
  });
  it('null/undefined 回 false', () => {
    expect(canManageAuthAccounts(null)).toBe(false);
    expect(canManageAuthAccounts(undefined)).toBe(false);
  });
});

describe('canAccessBackoffice', () => {
  it('hr / ceo / chairman / admin 可進', () => {
    for (const r of ['hr', 'ceo', 'chairman', 'admin']) {
      expect(canAccessBackoffice(emp(r))).toBe(true);
    }
  });
  it('employee 不可進', () => {
    expect(canAccessBackoffice(emp('employee'))).toBe(false);
  });
  it('is_manager=true 可進（不論 role）', () => {
    expect(canAccessBackoffice(emp('employee', true))).toBe(true);
    expect(canAccessBackoffice(emp('hr', true))).toBe(true);
  });
  it('null 回 false', () => {
    expect(canAccessBackoffice(null)).toBe(false);
  });
});

describe('canViewAllApprovals', () => {
  it('僅 hr / ceo / chairman / admin', () => {
    for (const r of ['hr', 'ceo', 'chairman', 'admin']) {
      expect(canViewAllApprovals(emp(r))).toBe(true);
    }
    expect(canViewAllApprovals(emp('employee'))).toBe(false);
  });
  it('is_manager 不影響（employee+is_manager 仍不行）', () => {
    expect(canViewAllApprovals(emp('employee', true))).toBe(false);
  });
});

describe('canEditApprovalConfig', () => {
  it('僅 hr / admin', () => {
    expect(canEditApprovalConfig(emp('hr'))).toBe(true);
    expect(canEditApprovalConfig(emp('admin'))).toBe(true);
    expect(canEditApprovalConfig(emp('ceo'))).toBe(false);
    expect(canEditApprovalConfig(emp('chairman'))).toBe(false);
    expect(canEditApprovalConfig(emp('employee'))).toBe(false);
  });
  it('is_manager 不影響', () => {
    expect(canEditApprovalConfig(emp('employee', true))).toBe(false);
  });
});

describe('canManageAnnouncements（決策：不認 is_manager）', () => {
  it('hr / ceo / chairman / admin 可', () => {
    for (const r of ['hr', 'ceo', 'chairman', 'admin']) {
      expect(canManageAnnouncements(emp(r))).toBe(true);
    }
  });
  it('employee 不可', () => {
    expect(canManageAnnouncements(emp('employee'))).toBe(false);
  });
  it('employee+is_manager 不可（關鍵 case：劉嘉昕遷移後）', () => {
    expect(canManageAnnouncements(emp('employee', true))).toBe(false);
  });
  it('hr+is_manager 仍可（盧嘉凌遷移後）', () => {
    expect(canManageAnnouncements(emp('hr', true))).toBe(true);
  });
});

describe('canWriteDepartments', () => {
  it('與 canAccessBackoffice 一致', () => {
    for (const r of ROLES) {
      for (const im of [true, false]) {
        expect(canWriteDepartments(emp(r, im))).toBe(canAccessBackoffice(emp(r, im)));
      }
    }
  });
});

describe('isDepartmentManager', () => {
  it('僅 is_manager=true 回 true，與 role 無關', () => {
    for (const r of ROLES) {
      expect(isDepartmentManager(emp(r, true))).toBe(true);
      expect(isDepartmentManager(emp(r, false))).toBe(false);
    }
  });
  it('null 回 false', () => {
    expect(isDepartmentManager(null)).toBe(false);
  });
});

describe('skipAttendanceBonus', () => {
  it('ceo / chairman 一律跳過', () => {
    expect(skipAttendanceBonus(emp('ceo'))).toBe(true);
    expect(skipAttendanceBonus(emp('chairman'))).toBe(true);
  });
  it('is_manager=true 跳過', () => {
    expect(skipAttendanceBonus(emp('employee', true))).toBe(true);
    expect(skipAttendanceBonus(emp('hr', true))).toBe(true);
  });
  it('employee / hr / admin 不跳過', () => {
    expect(skipAttendanceBonus(emp('employee'))).toBe(false);
    expect(skipAttendanceBonus(emp('hr'))).toBe(false);
    expect(skipAttendanceBonus(emp('admin'))).toBe(false);
  });
});

describe('effectiveApprovalRole', () => {
  it('is_manager=true 優先回 manager（不論 role）', () => {
    expect(effectiveApprovalRole(emp('employee', true))).toBe('manager');
    expect(effectiveApprovalRole(emp('hr', true))).toBe('manager');
    expect(effectiveApprovalRole(emp('ceo', true))).toBe('manager');
  });
  it('is_manager=false 回 role 本值', () => {
    expect(effectiveApprovalRole(emp('employee'))).toBe('employee');
    expect(effectiveApprovalRole(emp('hr'))).toBe('hr');
    expect(effectiveApprovalRole(emp('chairman'))).toBe('chairman');
  });
  it('null 回空字串', () => {
    expect(effectiveApprovalRole(null)).toBe('');
  });
});

// ── resolveRoleSetToEmployeeIds：用 mock supabase，確保查詢邏輯正確 ──
function makeMockSupabase(employees) {
  return {
    from(_table) {
      const state = { filters: {}, eqChain: [] };
      const result = {
        select() { return this; },
        in(col, values) { state.filters[col] = { op: 'in', values }; return this; },
        eq(col, value) { state.eqChain.push([col, value]); return this; },
        then(resolve) {
          let filtered = employees;
          if (state.filters.role?.op === 'in') {
            filtered = filtered.filter(e => state.filters.role.values.includes(e.role));
          }
          for (const [col, value] of state.eqChain) {
            filtered = filtered.filter(e => e[col] === value);
          }
          resolve({ data: filtered.map(e => ({ id: e.id })) });
        },
      };
      return result;
    },
  };
}

describe('resolveRoleSetToEmployeeIds', () => {
  const roster = [
    { id: 'A', role: 'employee', is_manager: true,  status: 'active' },
    { id: 'B', role: 'hr',       is_manager: true,  status: 'active' },
    { id: 'C', role: 'hr',       is_manager: false, status: 'active' },
    { id: 'D', role: 'ceo',      is_manager: false, status: 'active' },
    { id: 'E', role: 'employee', is_manager: false, status: 'active' },
    { id: 'F', role: 'employee', is_manager: true,  status: 'resigned' },
  ];
  const mockSb = makeMockSupabase(roster);

  it("['manager'] → 所有 is_manager=true 且 active 的人", async () => {
    const ids = await resolveRoleSetToEmployeeIds(['manager'], mockSb);
    expect(ids.sort()).toEqual(['A', 'B']);
  });
  it("['hr'] → 所有 role=hr 且 active 的人", async () => {
    const ids = await resolveRoleSetToEmployeeIds(['hr'], mockSb);
    expect(ids.sort()).toEqual(['B', 'C']);
  });
  it("['manager','hr'] → 聯集（去重）", async () => {
    const ids = await resolveRoleSetToEmployeeIds(['manager', 'hr'], mockSb);
    expect(ids.sort()).toEqual(['A', 'B', 'C']);
  });
  it('空陣列 → []', async () => {
    const ids = await resolveRoleSetToEmployeeIds([], mockSb);
    expect(ids).toEqual([]);
  });
});

describe('resolveApproverRoleToEmployeeIds', () => {
  const roster = [
    { id: 'A', role: 'employee', is_manager: true,  status: 'active' },
    { id: 'B', role: 'hr',       is_manager: false, status: 'active' },
    { id: 'C', role: 'ceo',      is_manager: false, status: 'active' },
  ];
  const mockSb = makeMockSupabase(roster);

  it("'manager' → is_manager=true", async () => {
    const ids = await resolveApproverRoleToEmployeeIds('manager', mockSb);
    expect(ids).toEqual(['A']);
  });
  it("'hr' → role=hr", async () => {
    const ids = await resolveApproverRoleToEmployeeIds('hr', mockSb);
    expect(ids).toEqual(['B']);
  });
  it("'ceo' → role=ceo", async () => {
    const ids = await resolveApproverRoleToEmployeeIds('ceo', mockSb);
    expect(ids).toEqual(['C']);
  });
});
