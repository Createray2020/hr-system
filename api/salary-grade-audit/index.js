// api/salary-grade-audit/index.js
// GET /api/salary-grade-audit
//   → 對所有 active 員工跑 auditEmployeeGrade,回 rows + summary
//
// 唯讀稽核、不寫 DB、不重算薪資、不會自動修正員工資料。
// 角色:BACKOFFICE_ROLES。

import { requireRole } from '../../lib/auth.js';
import { BACKOFFICE_ROLES } from '../../lib/roles.js';
import { auditEmployeeGrade } from '../../lib/salary/grade-audit.js';
import { makeGradeAuditRepo } from './_repo.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')     return res.status(405).json({ error: 'Method not allowed' });

  const caller = await requireRole(req, res, BACKOFFICE_ROLES);
  if (!caller) return;

  const repo = makeGradeAuditRepo();
  try {
    const [employees, grades, departments] = await Promise.all([
      repo.listActiveEmployees(),
      repo.listAllGrades(),
      repo.listDepartments(),
    ]);

    // grade map:`${grade}::${grade_level}` → row
    const gradeMap = {};
    for (const g of grades) gradeMap[`${g.grade}::${g.grade_level}`] = g;

    // dept map:id → name
    const deptMap = {};
    for (const d of departments) deptMap[d.id] = d.name;

    let with_mismatch = 0;
    let unassigned = 0;
    let no_grade_match = 0;
    let part_time_count = 0;
    let manager_grade_conflict = 0;

    const rows = (employees || []).map(emp => {
      const key = (emp.grade && emp.grade_level != null) ? `${emp.grade}::${emp.grade_level}` : null;
      const gradeRow = key ? (gradeMap[key] || null) : null;
      const audit = auditEmployeeGrade(emp, gradeRow);

      if (audit.mismatches.length > 0) with_mismatch++;
      if (audit.flags.includes('unassigned'))             unassigned++;
      if (audit.flags.includes('no_grade_match'))         no_grade_match++;
      if (audit.flags.includes('part_time'))              part_time_count++;
      if (audit.flags.includes('manager_grade_conflict')) manager_grade_conflict++;

      return {
        employee_id:     emp.id,
        name:            emp.name,
        dept_id:         emp.dept_id,
        dept_name:       deptMap[emp.dept_id] || null,
        position:        emp.position,
        grade:           emp.grade,
        grade_level:     emp.grade_level,
        employment_type: emp.employment_type,
        is_manager:      emp.is_manager,
        actual: {
          base_salary:       emp.base_salary,
          attendance_bonus:  emp.attendance_bonus,
          grade_allowance:   emp.grade_allowance,
          manager_allowance: emp.manager_allowance,
          extra_allowance:   emp.extra_allowance,
          hourly_rate:       emp.hourly_rate,
        },
        expected:   audit.expected,
        mismatches: audit.mismatches,
        flags:      audit.flags,
      };
    });

    return res.status(200).json({
      rows,
      summary: {
        total:                  rows.length,
        with_mismatch,
        unassigned,
        no_grade_match,
        part_time:              part_time_count,
        manager_grade_conflict,
      },
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
