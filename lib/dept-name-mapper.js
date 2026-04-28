// lib/dept-name-mapper.js — 把 row.departments?.name 提升為 row.dept_name 並清除 nested
//
// C0-5 雙寫過渡期：endpoint GET 回傳 row 加 dept_name、保留 dept TEXT 給前端 fallback。
// dept_name 來源是 JOIN departments(name)、永遠跟 departments.name 一致（不是 employees.dept TEXT cache）。
//
// 使用：
//   addDeptName(employees);                                      // 直接 select departments(name)
//   addDeptNameNested(rows, 'employees');                        // nested *, employees(..., departments(name))
//   addDeptNameNested(rows, 'employees', 'approval_requests');   // 三層 nested
//   addDeptNameSingle(row);                                      // 單一 row（非陣列）

/**
 * 直接在 employees 陣列上補 dept_name、刪除 nested departments。
 * @param {Array<object>} emps
 */
export function addDeptName(emps) {
  if (!Array.isArray(emps)) return;
  for (const e of emps) {
    if (!e || typeof e !== 'object') continue;
    e.dept_name = e.departments?.name || null;
    delete e.departments;
  }
}

/**
 * 在 nested rows 上補 dept_name。
 * @param {Array<object>} rows
 * @param {string} empKey - 巢狀員工 key（例：'employees'）
 * @param {string} [outerKey] - 外層 wrapper key（三層巢狀用）
 */
export function addDeptNameNested(rows, empKey, outerKey = null) {
  if (!Array.isArray(rows)) return;
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    const target = outerKey ? r[outerKey]?.[empKey] : r[empKey];
    if (!target || typeof target !== 'object') continue;
    target.dept_name = target.departments?.name || null;
    delete target.departments;
  }
}

/**
 * 單一 row（非陣列）補 dept_name。
 * @param {object} row
 */
export function addDeptNameSingle(row) {
  if (!row || typeof row !== 'object') return;
  row.dept_name = row.departments?.name || null;
  delete row.departments;
}
