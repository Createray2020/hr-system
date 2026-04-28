// tests/dept-name-mapper.test.js
import { describe, it, expect } from 'vitest';
import { addDeptName, addDeptNameNested, addDeptNameSingle } from '../lib/dept-name-mapper.js';

describe('addDeptName (直接 array)', () => {
  it('補 dept_name、刪 nested departments', () => {
    const emps = [{ id: 'E1', name: 'A', departments: { name: '前線部' } }];
    addDeptName(emps);
    expect(emps[0].dept_name).toBe('前線部');
    expect(emps[0].departments).toBeUndefined();
  });

  it('departments 為 null 時 dept_name 也是 null', () => {
    const emps = [{ id: 'E1', name: 'A', departments: null }];
    addDeptName(emps);
    expect(emps[0].dept_name).toBeNull();
  });

  it('空陣列不炸', () => {
    expect(() => addDeptName([])).not.toThrow();
  });

  it('非陣列輸入不炸', () => {
    expect(() => addDeptName(null)).not.toThrow();
    expect(() => addDeptName(undefined)).not.toThrow();
  });
});

describe('addDeptNameNested (兩層)', () => {
  it('在 r.employees 上補 dept_name', () => {
    const rows = [{ id: 'L1', employees: { name: 'A', departments: { name: '前線部' } } }];
    addDeptNameNested(rows, 'employees');
    expect(rows[0].employees.dept_name).toBe('前線部');
    expect(rows[0].employees.departments).toBeUndefined();
  });

  it('r.employees 為 null 時不炸', () => {
    const rows = [{ id: 'L1', employees: null }];
    expect(() => addDeptNameNested(rows, 'employees')).not.toThrow();
  });
});

describe('addDeptNameNested (三層 nested)', () => {
  it('approval_steps → approval_requests → employees', () => {
    const rows = [{
      id: 'S1',
      approval_requests: {
        id: 'R1',
        employees: { name: 'A', departments: { name: '前線部' } },
      },
    }];
    addDeptNameNested(rows, 'employees', 'approval_requests');
    expect(rows[0].approval_requests.employees.dept_name).toBe('前線部');
    expect(rows[0].approval_requests.employees.departments).toBeUndefined();
  });
});

describe('addDeptNameSingle', () => {
  it('在單一 row 上補 dept_name', () => {
    const r = { id: 'E1', departments: { name: '前線部' } };
    addDeptNameSingle(r);
    expect(r.dept_name).toBe('前線部');
    expect(r.departments).toBeUndefined();
  });

  it('null/undefined 不炸', () => {
    expect(() => addDeptNameSingle(null)).not.toThrow();
    expect(() => addDeptNameSingle(undefined)).not.toThrow();
  });
});
