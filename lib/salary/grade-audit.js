// lib/salary/grade-audit.js
// Phase 2 #2:職等↔薪資對應稽核(純函式、無 repo 注入需求)
//
// 用途:給定單一 employee row + 對應的 salary_grade row,回報:
//   - expected:該員預期應發各欄位(從 gradeRow 抓)
//   - mismatches:實發 vs 應發不同的欄位列表(每筆 { field, actual, expected })
//   - flags:特殊狀態旗標(unassigned / no_grade_match / part_time / manager_grade_conflict)
//
// 不重算薪資、不寫 DB、不會自動修正員工資料,只給 HR 排查用。
// 對應頁面:public/salary-grade-audit.html、API:api/salary-grade-audit/index.js
//
// 比對規則(spec):
//   1. employee.grade 或 grade_level 為 NULL → flags=['unassigned'],不比金額
//   2. 找不到對應 gradeRow(caller pass null)→ flags=['no_grade_match'],不比金額
//   3. employment_type === 'part_time' → flags 含 'part_time';只比 hourly_rate,不比月薪
//   4. full_time:比 base_salary / attendance_bonus / grade_allowance(actual vs gradeRow);
//      manager_allowance 三條規則:
//        a. is_manager=true + can_be_manager=false → flags 含 'manager_grade_conflict'
//        b. is_manager=true → 比對 manager_allowance(actual vs gradeRow.manager_allowance)
//        c. is_manager=false 但 actual.manager_allowance > 0 → mismatch(actual vs 0)
//   5. extra_allowance:永不算 mismatch(個別加給屬正常例外、由 UI 從 actual 取值顯示)

/**
 * @param {Object} employee  employees row 子集
 * @param {Object|null} gradeRow  對應 (grade, grade_level) 的 salary_grade row;null=查不到
 * @returns {{ expected: Object|null, mismatches: Array<{field,actual,expected}>, flags: string[] }}
 */
export function auditEmployeeGrade(employee, gradeRow) {
  const flags = [];
  const mismatches = [];

  // 規則 1:未指派職等
  if (!employee || !employee.grade || employee.grade_level == null) {
    flags.push('unassigned');
    return { expected: null, mismatches, flags };
  }

  // 規則 2:gradeRow 不存在
  if (!gradeRow) {
    flags.push('no_grade_match');
    return { expected: null, mismatches, flags };
  }

  const expected = {
    grade_name:        gradeRow.grade_name,
    base_salary:       gradeRow.base_salary,
    attendance_bonus:  gradeRow.attendance_bonus,
    grade_allowance:   gradeRow.grade_allowance,
    manager_allowance: gradeRow.manager_allowance,
    hourly_rate:       gradeRow.hourly_rate,
    can_be_manager:    gradeRow.can_be_manager,
  };

  // 規則 3:兼職只比 hourly_rate
  if (employee.employment_type === 'part_time') {
    flags.push('part_time');
    if (num(employee.hourly_rate) !== num(gradeRow.hourly_rate)) {
      mismatches.push({
        field:    'hourly_rate',
        actual:   employee.hourly_rate,
        expected: gradeRow.hourly_rate,
      });
    }
    return { expected, mismatches, flags };
  }

  // 規則 4 — full_time:base / attendance / grade_allowance
  for (const f of ['base_salary', 'attendance_bonus', 'grade_allowance']) {
    if (num(employee[f]) !== num(gradeRow[f])) {
      mismatches.push({ field: f, actual: employee[f], expected: gradeRow[f] });
    }
  }

  // 規則 4 — full_time:manager_allowance(三條子規則)
  if (employee.is_manager === true) {
    if (gradeRow.can_be_manager === false) {
      flags.push('manager_grade_conflict');
    }
    if (num(employee.manager_allowance) !== num(gradeRow.manager_allowance)) {
      mismatches.push({
        field:    'manager_allowance',
        actual:   employee.manager_allowance,
        expected: gradeRow.manager_allowance,
      });
    }
  } else {
    // 非主管但領主管加給
    if (num(employee.manager_allowance) > 0) {
      mismatches.push({
        field:    'manager_allowance',
        actual:   employee.manager_allowance,
        expected: 0,
      });
    }
  }

  // 規則 5:extra_allowance 從不算 mismatch(略過、UI 自取 actual 顯示)

  return { expected, mismatches, flags };
}

// null / undefined / 字串 → 0;NUMERIC vs Number 統一比較
function num(v) {
  if (v == null) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
