// tests/grade-audit.test.js
// 抓 lib/salary/grade-audit.js 純函式行為:
//   - 完全相符 / 單欄差異 / 多欄差異
//   - 未指派職等 / 無對應級距
//   - 兼職(part_time):相符 / hourly_rate 差
//   - 主管:級距可主管 / 級距不可主管(衝突 flag)/ manager_allowance 差
//   - 非主管領主管加給(should mismatch)
//   - extra_allowance 永不算 mismatch

import { describe, it, expect } from 'vitest';
import { auditEmployeeGrade } from '../lib/salary/grade-audit.js';

// ─── Fixtures ────────────────────────────────────────────────
const GRADE_YIDENG_2 = {
  grade: '一等', grade_level: 2, grade_name: '專員',
  base_salary: 30000, attendance_bonus: 2000, grade_allowance: 1000,
  manager_allowance: 0, can_be_manager: false, hourly_rate: 210,
};
const GRADE_ERDENG_1 = {
  grade: '二等', grade_level: 1, grade_name: '資深/儲備/組長',
  base_salary: 30000, attendance_bonus: 2000, grade_allowance: 3000,
  manager_allowance: 4000, can_be_manager: true, hourly_rate: null,
};
const GRADE_SANDENG_1 = {
  grade: '三等', grade_level: 1, grade_name: '高階主管',
  base_salary: 30000, attendance_bonus: 0, grade_allowance: 11000,
  manager_allowance: 8000, can_be_manager: true, hourly_rate: null,
};

function makeFullTimeEmployee(overrides = {}) {
  return {
    id: 'EMP_TEST', name: 'Test',
    grade: '一等', grade_level: 2,
    base_salary: 30000, attendance_bonus: 2000, grade_allowance: 1000,
    manager_allowance: 0, extra_allowance: 0,
    is_manager: false, employment_type: 'full_time', status: 'active',
    hourly_rate: null,
    ...overrides,
  };
}

// ─── 規則 1:未指派職等 ──────────────────────────────────────
describe('auditEmployeeGrade — 未指派職等', () => {
  it('grade=null → flags=["unassigned"]、no mismatches、expected=null', () => {
    const emp = makeFullTimeEmployee({ grade: null });
    const r = auditEmployeeGrade(emp, GRADE_YIDENG_2);
    expect(r.flags).toEqual(['unassigned']);
    expect(r.mismatches).toEqual([]);
    expect(r.expected).toBeNull();
  });

  it('grade_level=null → flags=["unassigned"]', () => {
    const emp = makeFullTimeEmployee({ grade_level: null });
    const r = auditEmployeeGrade(emp, GRADE_YIDENG_2);
    expect(r.flags).toEqual(['unassigned']);
    expect(r.mismatches).toEqual([]);
  });

  it('grade=空字串 → flags=["unassigned"]', () => {
    const emp = makeFullTimeEmployee({ grade: '' });
    const r = auditEmployeeGrade(emp, GRADE_YIDENG_2);
    expect(r.flags).toContain('unassigned');
  });
});

// ─── 規則 2:無對應級距 ──────────────────────────────────────
describe('auditEmployeeGrade — 無對應級距(gradeRow=null)', () => {
  it('gradeRow=null + 已指派 → flags=["no_grade_match"]、no mismatches、expected=null', () => {
    const emp = makeFullTimeEmployee();
    const r = auditEmployeeGrade(emp, null);
    expect(r.flags).toEqual(['no_grade_match']);
    expect(r.mismatches).toEqual([]);
    expect(r.expected).toBeNull();
  });
});

// ─── 規則 3:full_time 完全相符 ──────────────────────────────
describe('auditEmployeeGrade — full_time 完全相符', () => {
  it('一等 2 員工值跟級距完全相同 → mismatches=[]、flags=[]', () => {
    const emp = makeFullTimeEmployee();  // 已對齊 GRADE_YIDENG_2
    const r = auditEmployeeGrade(emp, GRADE_YIDENG_2);
    expect(r.mismatches).toEqual([]);
    expect(r.flags).toEqual([]);
    expect(r.expected).toMatchObject({
      base_salary: 30000, attendance_bonus: 2000, grade_allowance: 1000,
    });
  });

  it('extra_allowance > 0 也不算 mismatch(個別例外)', () => {
    const emp = makeFullTimeEmployee({ extra_allowance: 5000 });
    const r = auditEmployeeGrade(emp, GRADE_YIDENG_2);
    expect(r.mismatches).toEqual([]);
    expect(r.flags).toEqual([]);
  });
});

// ─── 規則 4:full_time 單/多欄差異 ───────────────────────────
describe('auditEmployeeGrade — full_time 欄位差異', () => {
  it('單欄 base_salary 差(actual 31000 vs expected 30000)', () => {
    const emp = makeFullTimeEmployee({ base_salary: 31000 });
    const r = auditEmployeeGrade(emp, GRADE_YIDENG_2);
    expect(r.mismatches).toEqual([{ field: 'base_salary', actual: 31000, expected: 30000 }]);
    expect(r.flags).toEqual([]);
  });

  it('多欄差異(base + attendance + grade_allowance 全錯)', () => {
    const emp = makeFullTimeEmployee({
      base_salary: 35000, attendance_bonus: 0, grade_allowance: 500,
    });
    const r = auditEmployeeGrade(emp, GRADE_YIDENG_2);
    expect(r.mismatches).toHaveLength(3);
    expect(r.mismatches.map(m => m.field).sort())
      .toEqual(['attendance_bonus', 'base_salary', 'grade_allowance']);
  });

  it('grade_allowance=0 vs expected=1000(prod 真實案例 EMP_01251110)', () => {
    const emp = makeFullTimeEmployee({ grade_allowance: 0 });
    const r = auditEmployeeGrade(emp, GRADE_YIDENG_2);
    expect(r.mismatches).toEqual([{ field: 'grade_allowance', actual: 0, expected: 1000 }]);
  });
});

// ─── 規則 5:part_time ──────────────────────────────────────
describe('auditEmployeeGrade — part_time(只比 hourly_rate)', () => {
  it('hourly_rate 相符 → 0 mismatch、flags=["part_time"]', () => {
    const emp = makeFullTimeEmployee({
      employment_type: 'part_time',
      hourly_rate: 210,
      base_salary: 0, attendance_bonus: 0, grade_allowance: 999,  // 月薪欄位忽略
    });
    const r = auditEmployeeGrade(emp, GRADE_YIDENG_2);
    expect(r.flags).toEqual(['part_time']);
    expect(r.mismatches).toEqual([]);
  });

  it('hourly_rate 差 → 1 mismatch', () => {
    const emp = makeFullTimeEmployee({
      employment_type: 'part_time', hourly_rate: 180,
    });
    const r = auditEmployeeGrade(emp, GRADE_YIDENG_2);
    expect(r.flags).toEqual(['part_time']);
    expect(r.mismatches).toEqual([{ field: 'hourly_rate', actual: 180, expected: 210 }]);
  });

  it('part_time 月薪欄位差但不計 mismatch', () => {
    const emp = makeFullTimeEmployee({
      employment_type: 'part_time', hourly_rate: 210,
      base_salary: 99999, manager_allowance: 50000, is_manager: true,
    });
    const r = auditEmployeeGrade(emp, GRADE_YIDENG_2);
    expect(r.flags).toEqual(['part_time']);
    expect(r.mismatches).toEqual([]);  // 不比 base / manager_allowance
  });
});

// ─── 規則 6:主管加給三條子規則 ──────────────────────────────
describe('auditEmployeeGrade — manager_allowance 規則', () => {
  it('主管 + 級距可主管 + manager_allowance 對 → 0 mismatch', () => {
    const emp = makeFullTimeEmployee({
      grade: '二等', grade_level: 1,
      base_salary: 30000, attendance_bonus: 2000, grade_allowance: 3000,
      is_manager: true, manager_allowance: 4000,
    });
    const r = auditEmployeeGrade(emp, GRADE_ERDENG_1);
    expect(r.mismatches).toEqual([]);
    expect(r.flags).toEqual([]);
  });

  it('主管 + 級距可主管 + manager_allowance 差 → 1 mismatch', () => {
    const emp = makeFullTimeEmployee({
      grade: '二等', grade_level: 1,
      base_salary: 30000, attendance_bonus: 2000, grade_allowance: 3000,
      is_manager: true, manager_allowance: 3000,  // expected 4000
    });
    const r = auditEmployeeGrade(emp, GRADE_ERDENG_1);
    expect(r.mismatches).toEqual([{ field: 'manager_allowance', actual: 3000, expected: 4000 }]);
    expect(r.flags).toEqual([]);
  });

  it('主管但級距不可主管(can_be_manager=false)→ flags=["manager_grade_conflict"]', () => {
    const emp = makeFullTimeEmployee({
      grade: '一等', grade_level: 2,
      is_manager: true, manager_allowance: 0,
    });
    const r = auditEmployeeGrade(emp, GRADE_YIDENG_2);  // can_be_manager=false
    expect(r.flags).toEqual(['manager_grade_conflict']);
    expect(r.mismatches).toEqual([]);  // manager_allowance 都=0、無 mismatch
  });

  it('非主管但領主管加給(manager_allowance=5000)→ 1 mismatch(actual 5000 vs 0)', () => {
    const emp = makeFullTimeEmployee({
      is_manager: false, manager_allowance: 5000,
    });
    const r = auditEmployeeGrade(emp, GRADE_YIDENG_2);
    expect(r.mismatches).toEqual([{ field: 'manager_allowance', actual: 5000, expected: 0 }]);
    expect(r.flags).toEqual([]);
  });

  it('主管 + 級距不可主管 + manager_allowance 差 → 同時有 flag + mismatch', () => {
    const emp = makeFullTimeEmployee({
      grade: '一等', grade_level: 2,
      is_manager: true, manager_allowance: 4000,  // 級距 expected 0
    });
    const r = auditEmployeeGrade(emp, GRADE_YIDENG_2);
    expect(r.flags).toEqual(['manager_grade_conflict']);
    expect(r.mismatches).toEqual([{ field: 'manager_allowance', actual: 4000, expected: 0 }]);
  });
});

// ─── 邊角:null / NUMERIC 寬容 ─────────────────────────────
describe('auditEmployeeGrade — null/NUMERIC 寬容', () => {
  it('actual null vs expected 0 → 不算差(num normalize)', () => {
    const emp = makeFullTimeEmployee({ manager_allowance: null });
    const r = auditEmployeeGrade(emp, GRADE_YIDENG_2);
    expect(r.mismatches).toEqual([]);
  });

  it('字串 "30000" === Number 30000(num normalize)', () => {
    const emp = makeFullTimeEmployee({ base_salary: '30000' });
    const r = auditEmployeeGrade(emp, GRADE_YIDENG_2);
    expect(r.mismatches).toEqual([]);
  });
});

// ─── expected 結構驗證 ────────────────────────────────────
describe('auditEmployeeGrade — expected 結構', () => {
  it('expected 含 7 個欄位', () => {
    const r = auditEmployeeGrade(makeFullTimeEmployee(), GRADE_YIDENG_2);
    expect(r.expected).toMatchObject({
      grade_name: '專員',
      base_salary: 30000,
      attendance_bonus: 2000,
      grade_allowance: 1000,
      manager_allowance: 0,
      hourly_rate: 210,
      can_be_manager: false,
    });
  });
});
