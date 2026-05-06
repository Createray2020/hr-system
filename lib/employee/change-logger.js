// lib/employee/change-logger.js — 員工關鍵欄位變更 audit(純函式 + repo 注入式)
//
// 對應 schema:employee_change_logs(Phase 1.7.2 加)
// 對應 endpoint:api/employees/[id].js PUT 自動 hook
//
// 設計:
//   1. 白名單 7 欄位、其他變更不 log(避免噪音、tight audit)
//   2. before/after 文字化(null/undefined → '(空)')、boolean → 'true'/'false'、
//      number → String(n)、避免型別比較踩雷
//   3. 純函式 diff、寫入分開(repo.batchInsertChangeLogs 注入)
//   4. log 失敗不擋 update(caller 自行 try/catch、log 是 audit、不該卡業務)

export const AUDITED_FIELDS = Object.freeze([
  'name', 'dept_id', 'role', 'is_manager',
  'base_salary', 'position', 'manager_id',
]);

/**
 * 把 before / after 比對、回傳變更清單(只含白名單欄位)。
 *
 * @param {object} before  update 前的 employee row
 * @param {object} after   update 後的 employee row(或 PUT body merge before 的結果)
 * @returns {Array<{ changed_field: string, before_value: string|null, after_value: string|null }>}
 */
export function diffEmployeeChanges(before, after) {
  if (!before || !after) return [];
  const changes = [];
  for (const field of AUDITED_FIELDS) {
    if (!(field in after)) continue;  // after 沒帶該欄位 → 沒改
    const b = stringify(before[field]);
    const a = stringify(after[field]);
    if (b === a) continue;
    changes.push({
      changed_field: field,
      before_value: b,
      after_value: a,
    });
  }
  return changes;
}

/**
 * 寫 audit log。失敗不 throw(audit 不該卡業務、由 caller 決定 log 重要性)。
 *
 * @param {{ batchInsertChangeLogs: (rows) => Promise<void> }} repo
 * @param {{ employee_id, before, after, changed_by }} args
 * @returns {Promise<{ logged: number }>}
 */
export async function logEmployeeChanges(repo, { employee_id, before, after, changed_by }) {
  if (!employee_id) throw new Error('employee_id required');
  if (!repo || typeof repo.batchInsertChangeLogs !== 'function') {
    throw new Error('repo.batchInsertChangeLogs required');
  }
  const changes = diffEmployeeChanges(before, after);
  if (changes.length === 0) return { logged: 0 };
  const now = new Date().toISOString();
  const rows = changes.map(c => ({
    employee_id,
    changed_field: c.changed_field,
    before_value:  c.before_value,
    after_value:   c.after_value,
    changed_by:    changed_by || null,
    changed_at:    now,
  }));
  await repo.batchInsertChangeLogs(rows);
  return { logged: rows.length };
}

// ─── helpers ─────────────────────────────────────────────────

/**
 * 把任何值文字化(給 before_value/after_value TEXT 欄位)。
 *   null / undefined → '(空)'(顯式區分,避免 frontend 顯示 'null' 字串)
 *   boolean          → 'true' / 'false'
 *   number           → String(n)(包含 0 / NaN 邊界)
 *   其他             → String(v) trimmed
 */
function stringify(v) {
  if (v === null || v === undefined) return '(空)';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number')  return String(v);
  return String(v);
}
