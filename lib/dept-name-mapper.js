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

/**
 * Phase 2.x:批次補 employee_manager_name + employee_dept_id flatten。
 * 對齊 canReview 期待的 reviewable shape:
 *   - employee_dept_id:rows[].employee_dept_id 確保存在(取 deptIdGetter 結果)
 *   - employee_manager_name:同部門 active is_manager=true 員工 name 串(', ' joined)
 *
 * Two-step join、不動 schema:
 *   1. 從 rows 取出 unique dept ids
 *   2. 撈 employees WHERE dept_id IN (...) AND is_manager=true AND status='active'
 *   3. 串成 string、空 → null(同部門無 manager 時 frontend 顯示 '—')
 *
 * @param {Array<object>} rows  各 row 已含或可推出 dept_id(透過 deptIdGetter)
 * @param {object} supabaseAdmin  注入 supabase client
 * @param {(row: object) => string|null} deptIdGetter  從 row 取 dept_id 的 getter
 *   leave 列表:r => r.dept_id(已 flatten)
 *   overtime 列表(無 employee 嵌套):需先 JOIN 拿 dept_id、再傳 getter
 * @returns {Promise<Array>} rows 同陣列、in-place 加 employee_dept_id + employee_manager_name
 */
export async function attachManagerNames(rows, supabaseAdmin, deptIdGetter) {
  if (!Array.isArray(rows) || rows.length === 0) return rows || [];
  const deptIds = [...new Set(rows.map(deptIdGetter).filter(Boolean))];
  if (deptIds.length === 0) {
    return rows.map(r => ({
      ...r,
      employee_dept_id: deptIdGetter(r) || null,
      employee_manager_name: null,
    }));
  }
  const { data: managers } = await supabaseAdmin
    .from('employees')
    .select('id, name, dept_id')
    .in('dept_id', deptIds)
    .eq('is_manager', true)
    .eq('status', 'active')
    .order('name');
  const deptToManagers = {};
  for (const m of managers || []) {
    if (!deptToManagers[m.dept_id]) deptToManagers[m.dept_id] = [];
    deptToManagers[m.dept_id].push(m.name);
  }
  return rows.map(r => {
    const did = deptIdGetter(r);
    return {
      ...r,
      employee_dept_id: did || null,
      employee_manager_name: did && deptToManagers[did]
        ? deptToManagers[did].join(', ')
        : null,
    };
  });
}
