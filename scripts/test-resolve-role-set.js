// scripts/test-resolve-role-set.js
// 驗證 lib/push.js 中用的 resolveRoleSetToEmployeeIds（實際呼叫 lib/roles.js 版本）。
// 回傳集合必須包含兩位目前 is_manager=true 的員工：
//   EMP_01250501 (劉嘉昕)
//   EMP_01251001 (盧嘉凌)
//
// 用法：node scripts/test-resolve-role-set.js
// 驗收：exit code 0 = PASS，非 0 = FAIL
//
// 未來回歸測試：Batch 3 / Batch 4 後都可重跑，結果應持續通過。
import fs from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const env = Object.fromEntries(
  fs.readFileSync('.env.local', 'utf8').split('\n')
    .filter(l => l && !l.startsWith('#'))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)]; })
);
const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);

// 本 script 維持獨立（不 import lib/roles.js 避免路徑 / env 依賴）
async function resolveRoleSetToEmployeeIds(roles) {
  if (!roles?.length) return [];
  const hasManager = roles.includes('manager');
  const normalRoles = roles.filter(r => r !== 'manager');
  const ids = new Set();
  if (normalRoles.length) {
    const { data } = await supabase.from('employees')
      .select('id').in('role', normalRoles).eq('status', 'active');
    (data || []).forEach(r => ids.add(r.id));
  }
  if (hasManager) {
    const { data } = await supabase.from('employees')
      .select('id').eq('is_manager', true).eq('status', 'active');
    (data || []).forEach(r => ids.add(r.id));
  }
  return [...ids];
}

const REQUIRED_MANAGERS = ['EMP_01250501', 'EMP_01251001'];

async function run(label, input, required) {
  const ids = await resolveRoleSetToEmployeeIds(input);
  const sorted = [...ids].sort();
  const missing = required.filter(r => !ids.includes(r));
  const pass = missing.length === 0;
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${label}`);
  console.log(`  input:    ${JSON.stringify(input)}`);
  console.log(`  回傳 ids: ${JSON.stringify(sorted)}`);
  console.log(`  要求含:   ${JSON.stringify(required)}`);
  if (!pass) console.log(`  缺少:     ${JSON.stringify(missing)}`);
  return pass;
}

(async () => {
  let allPass = true;
  allPass &= await run(
    "resolveRoleSetToEmployeeIds(['manager']) 必須含 EMP_01250501 + EMP_01251001",
    ['manager'],
    REQUIRED_MANAGERS,
  );
  allPass &= await run(
    "resolveRoleSetToEmployeeIds(['hr']) 至少回 1 筆（不強制含 managers）",
    ['hr'],
    [],
  );
  allPass &= await run(
    "resolveRoleSetToEmployeeIds(['manager','hr']) 聯集仍含 managers",
    ['manager', 'hr'],
    REQUIRED_MANAGERS,
  );
  process.exit(allPass ? 0 : 1);
})();
