// lib/dept-sync.js — 雙向同步 employees body 的 dept TEXT 跟 dept_id
//
// C0-3 過渡期：employees 表既有 dept TEXT 又有 dept_id FK，前端可能只送其中一個。
// 寫入前呼叫 syncDeptFields() 補另一邊、保證從哪個欄位讀都對。
//
// 規則：
//   - 只有 dept_id  → 查 departments 補 dept name（找不到不覆寫、保留前端送的 dept）
//   - 只有 dept     → 查 departments 補 dept_id（找不到不阻擋、dept_id NULL、保留 dept）
//   - 兩者並存      → dept_id 為主、覆寫 dept name 對齊（找不到不覆寫）
//   - 兩者皆無      → 不動

/**
 * @param {object} supabase - supabaseAdmin client
 * @param {object} body     - 會 mutate
 * @returns {Promise<object>} 同步後的 body
 */
export async function syncDeptFields(supabase, body) {
  if (!body || typeof body !== 'object') return body;
  const hasDeptId = body.dept_id != null && body.dept_id !== '';
  const hasDept   = body.dept    != null && body.dept    !== '';
  if (!hasDeptId && !hasDept) return body;

  if (hasDeptId) {
    const { data: d } = await supabase
      .from('departments').select('name').eq('id', body.dept_id).maybeSingle();
    if (d) body.dept = d.name;
    // 找不到 → 保留前端送的 dept（可能員工剛被搬部門、舊 dept_id 失效）
  } else if (hasDept) {
    const { data: d } = await supabase
      .from('departments').select('id').eq('name', body.dept).maybeSingle();
    body.dept_id = d?.id || null;
  }
  return body;
}
