// lib/dept-sync.js — employees CRUD body 的 dept_id 補強 + dept 欄位拔除
//
// C0-Hotfix-7a：employees.dept TEXT 欄位已 DROP（C0-6）。
// 本函式現只做兩件事：
//   1. 若前端只送 body.dept name 但無 body.dept_id → lookup departments 補 dept_id
//   2. 永遠拔 body.dept（避免被 spread 進 INSERT/UPDATE 撞 column does not exist）

/**
 * @param {object} supabase - supabaseAdmin client
 * @param {object} body     - 會 mutate
 * @returns {Promise<object>} 同步後的 body
 */
export async function syncDeptFields(supabase, body) {
  if (!body || typeof body !== 'object') return body;
  const hasDeptId = body.dept_id != null && body.dept_id !== '';
  const hasDept   = body.dept    != null && body.dept    !== '';

  // 只有 dept name → lookup dept_id
  if (!hasDeptId && hasDept) {
    const { data: d } = await supabase
      .from('departments').select('id').eq('name', body.dept).maybeSingle();
    body.dept_id = d?.id || null;
  }

  // 永遠拔 body.dept（schema 已 DROP、無論路徑）
  delete body.dept;
  return body;
}
