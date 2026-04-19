#!/usr/bin/env node
// scripts/create-all-auth.js — 一次性腳本：為所有員工建立 Supabase Auth 帳號
// 執行方式：node scripts/create-all-auth.js
// 需要設定環境變數：SUPABASE_URL, SUPABASE_SERVICE_KEY
//
// 行為：
//   - email:  {emp_no}@chuwa.hr
//   - password: '123456'（員工首次登入後請立即修改）
//   - email_confirm: true
//   - 若 email 已存在則跳過
//   - 成功後將 auth.id 寫回 employees.auth_user_id

import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

const SUPABASE_URL     = process.env.SUPABASE_URL;
const SUPABASE_SERVICE = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE) {
  console.error('❌ 缺少環境變數 SUPABASE_URL 或 SUPABASE_SERVICE_KEY');
  console.error('   請在 .env.local 或環境中設定：');
  console.error('   SUPABASE_URL=https://xxx.supabase.co');
  console.error('   SUPABASE_SERVICE_KEY=eyJ...');
  process.exit(1);
}

const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE);

async function main() {
  console.log('📋 正在讀取員工資料…');

  const { data: employees, error } = await adminClient
    .from('employees')
    .select('id, emp_no, name, email, status, auth_user_id')
    .order('emp_no');

  if (error) { console.error('❌ 讀取員工失敗：', error.message); process.exit(1); }
  console.log(`📊 共找到 ${employees.length} 位員工`);

  // Get existing auth users (by email) to detect duplicates
  const { data: { users: existingUsers } } = await adminClient.auth.admin.listUsers({ perPage: 1000 });
  const existingEmailMap = {};
  (existingUsers || []).forEach(u => { existingEmailMap[u.email] = u.id; });

  let created = 0, skipped = 0, failed = 0, updated = 0;

  for (const emp of employees) {
    if (!emp.emp_no) {
      console.log(`  ⚠  跳過（無員工編號）: ${emp.name || emp.id}`);
      skipped++;
      continue;
    }

    const authEmail = emp.emp_no + '@chuwa.hr';

    // Check if already exists
    if (existingEmailMap[authEmail]) {
      const existingId = existingEmailMap[authEmail];
      process.stdout.write(`  ↩  已存在 ${emp.emp_no} (${emp.name})`);

      // Update auth_user_id if not set
      if (!emp.auth_user_id) {
        await adminClient.from('employees').update({ auth_user_id: existingId }).eq('id', emp.id);
        process.stdout.write(' → 已補寫 auth_user_id\n');
        updated++;
      } else {
        process.stdout.write('\n');
      }
      skipped++;
      continue;
    }

    // Create new auth user
    try {
      const { data: newUser, error: createErr } = await adminClient.auth.admin.createUser({
        email:          authEmail,
        password:       '123456',
        email_confirm:  true,
        user_metadata:  { emp_no: emp.emp_no, name: emp.name },
      });

      if (createErr) {
        console.log(`  ❌ 建立失敗 ${emp.emp_no} (${emp.name}): ${createErr.message}`);
        failed++;
        continue;
      }

      // Write back auth_user_id
      const { error: updateErr } = await adminClient
        .from('employees')
        .update({ auth_user_id: newUser.user.id })
        .eq('id', emp.id);

      if (updateErr) {
        console.log(`  ⚠  建立成功但寫回失敗 ${emp.emp_no}: ${updateErr.message}`);
      } else {
        console.log(`  ✅ 建立成功 ${emp.emp_no} (${emp.name}) → ${authEmail}`);
      }
      created++;

    } catch(e) {
      console.log(`  ❌ 例外 ${emp.emp_no}: ${e.message}`);
      failed++;
    }

    // Small delay to avoid rate limiting
    await new Promise(r => setTimeout(r, 150));
  }

  console.log('\n═══════════════════════════════');
  console.log(`✅ 新建立：${created}`);
  console.log(`↩  已存在（跳過）：${skipped}`);
  if (updated > 0) console.log(`📝 補寫 auth_user_id：${updated}`);
  if (failed  > 0) console.log(`❌ 失敗：${failed}`);
  console.log('═══════════════════════════════');
  console.log('完成！預設密碼為 123456，請通知員工盡快修改。');
}

main().catch(e => { console.error('未預期的錯誤：', e); process.exit(1); });
