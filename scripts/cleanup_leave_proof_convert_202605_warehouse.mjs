#!/usr/bin/env node
// scripts/cleanup_leave_proof_convert_202605_warehouse.mjs
// 一次性 HR 後台清理 — 5 月倉儲後勤部 6 筆「cron 證明逾期轉事假」誤轉/重複單
//
// 用法:
//   # dry-run(預設,不寫入):
//   node --env-file=.env.local scripts/cleanup_leave_proof_convert_202605_warehouse.mjs --actor=<admin_id>
//
//   # 實際寫入:
//   node --env-file=.env.local scripts/cleanup_leave_proof_convert_202605_warehouse.mjs --apply --actor=<admin_id>
//
// ⚠️ 軟刪語意上限 admin/chairman:script 用 supabaseAdmin 寫得進去、
//    但 deleted_by 要掛對人(--actor 請傳真實 admin/chairman 帳號)。
//
// 目標(6 筆 emp,date):全部正規化為「一筆 sick + proof_status=submitted + attendance=leave」
//   EMP_01220301 2026-05-27 / EMP_01240301 2026-05-27 / EMP_01220301 2026-05-22 /
//   EMP_01220301 2026-05-19 / EMP_01220301 2026-05-11 / EMP_01240301 2026-05-11
//
// State-driven 規則(每筆讀現況再決定動作、不假設快照、cron 凌晨 04:00 可能已改):
//   sicks.length >= 1:
//     - 留最早建立的 sick(by id ASC、id 格式 L<epoch_ms>_<emp> 天然時序)
//     - 該 sick 若 proof_status !== 'submitted' → admin_edit 設成 'submitted'
//     - 同日其他 sick / 全部 personal → 軟刪
//   sicks.length === 0、personals.length >= 1:
//     - 留最早 personal、admin_edit:leave_type personal→sick + proof_status→'submitted'
//     - 其他 personal → 軟刪
//   都沒 → 無從清,skip+warn
//
// attendance 收尾:
//   status='absent' → UPDATE 'leave' + note PREPEND '[考勤清理 ...] absent→leave(sick) cron誤轉還原'
//   status='leave'  → skip
//   其他 → warn
//
// Audit 慣例對齊 api/leaves/[id].js:
//   admin_edit handler_note APPEND:`[YYYY-MM-DD] <actor> admin_edit: <field> <old>→<new>、...`
//   delete    handler_note APPEND:`[YYYY-MM-DD] <actor> deleted: <reason>`
//   attendance.note PREPEND(對齊 backfill script + api/schedules/[id].js cascade)

import { createClient } from '@supabase/supabase-js';

// ─── CLI ──────────────────────────────────────────────────
const args = process.argv.slice(2);
const flags = { apply: false, actor: null };
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--apply') flags.apply = true;
  else if (args[i].startsWith('--actor=')) flags.actor = args[i].slice('--actor='.length);
  else if (args[i] === '--actor' && args[i + 1]) flags.actor = args[++i];
}
if (!flags.actor) {
  console.error('Usage: node --env-file=.env.local scripts/cleanup_leave_proof_convert_202605_warehouse.mjs [--apply] --actor=<admin_id>');
  process.exit(1);
}
const MODE = flags.apply ? 'APPLY' : 'DRY-RUN';
const ACTOR = flags.actor;
const AUDIT_DATE = '2026-05-29';
const DELETE_REASON = 'cron證明逾期誤轉事假之重複單,原sick已存在,5月打卡異常清理';

// ─── env ──────────────────────────────────────────────────
const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !KEY) {
  console.error('❌ 缺 SUPABASE_URL / SUPABASE_SERVICE_KEY(或 SUPABASE_SERVICE_ROLE_KEY)');
  process.exit(1);
}
const sb = createClient(URL, KEY, { auth: { autoRefreshToken: false, persistSession: false } });

// ─── Manifest ─────────────────────────────────────────────
const TARGETS = [
  { emp: 'EMP_01220301', date: '2026-05-27' },
  { emp: 'EMP_01240301', date: '2026-05-27' },
  { emp: 'EMP_01220301', date: '2026-05-22' },
  { emp: 'EMP_01220301', date: '2026-05-19' },
  { emp: 'EMP_01220301', date: '2026-05-11' },
  { emp: 'EMP_01240301', date: '2026-05-11' },
];

const summary = {
  edit_proof: 0, edit_proof_skip: 0,
  revert_type: 0,
  soft_deleted: 0,
  att_updated: 0, att_skip_already_leave: 0, att_skip_missing: 0, att_warn_other: 0,
  warn_no_leave: 0,
};

const log = (...a) => console.log(...a);
const now = () => new Date();
const formatAuditVal = (v) => {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'string' && v.length > 30) return v.slice(0, 27) + '...';
  return String(v);
};

// ─── helpers ──────────────────────────────────────────────
async function findLeavesOnDate(emp, date) {
  const dayStart = `${date}T00:00:00+08:00`;
  const dayEnd   = `${date}T23:59:59+08:00`;
  const { data, error } = await sb
    .from('leave_requests')
    .select('id, employee_id, leave_type, status, start_at, end_at, proof_status, proof_url, attachment_url, handler_note')
    .eq('employee_id', emp)
    .is('deleted_at', null)
    .gte('start_at', dayStart)
    .lte('start_at', dayEnd)
    .order('id', { ascending: true }); // id=L<epoch_ms>_emp → 時序
  if (error) throw new Error(`查 leave_requests (${emp},${date}): ${error.message}`);
  return data || [];
}

async function findAttendance(emp, date) {
  const { data, error } = await sb
    .from('attendance')
    .select('id, status, note, work_date')
    .eq('employee_id', emp).eq('work_date', date).maybeSingle();
  if (error) throw new Error(`查 attendance (${emp},${date}): ${error.message}`);
  return data;
}

function buildAuditLine(fields) {
  // 對齊 api/leaves/[id].js:214
  const parts = fields.map(f => `${f.name} ${formatAuditVal(f.old)}→${formatAuditVal(f.new)}`);
  return `[${AUDIT_DATE}] ${ACTOR} admin_edit: ${parts.join('、')}`;
}

function buildDeleteAuditLine(reason) {
  // 對齊 api/leaves/[id].js:251
  return `[${AUDIT_DATE}] ${ACTOR} deleted: ${reason}`;
}

function appendNote(prev, line) {
  return prev ? `${prev}\n${line}` : line;
}

function prependAttNote(prev, line) {
  return prev ? `${line}\n${prev}` : line;
}

async function applyAdminEdit(row, patch, auditLine) {
  const newPatch = { ...patch, handler_note: appendNote(row.handler_note, auditLine) };
  const { error } = await sb.from('leave_requests').update(newPatch).eq('id', row.id);
  if (error) throw new Error(`admin_edit ${row.id}: ${error.message}`);
}

async function applySoftDelete(row, reason) {
  const auditLine = buildDeleteAuditLine(reason);
  const patch = {
    deleted_at: now().toISOString(),
    deleted_by: ACTOR,
    delete_reason: reason,
    handler_note: appendNote(row.handler_note, auditLine),
  };
  const { error } = await sb.from('leave_requests').update(patch).eq('id', row.id);
  if (error) throw new Error(`soft delete ${row.id}: ${error.message}`);
}

async function applyAttUpdate(att, newStatus, noteLine) {
  const newNote = prependAttNote(att.note, noteLine);
  const { error } = await sb.from('attendance')
    .update({ status: newStatus, note: newNote }).eq('id', att.id);
  if (error) throw new Error(`UPDATE attendance ${att.id}: ${error.message}`);
}

// ─── 單筆 (emp, date) 處理 ─────────────────────────────────
async function processOne(target) {
  const { emp, date } = target;
  const tag = `[${date} ${emp}]`;
  log(`\n${tag} ─────────────────────────────`);

  // 1. 撈現況
  const leaves = await findLeavesOnDate(emp, date);
  const att    = await findAttendance(emp, date);

  log(`${tag} 現況:${leaves.length} 筆 undeleted leave_request、attendance=${att ? `${att.id} status=${att.status}` : 'NULL'}`);
  for (const r of leaves) {
    log(`         ${r.leave_type.padEnd(8)} id=${r.id} status=${r.status} proof_status=${r.proof_status} proof_url=${r.proof_url ? 'set' : 'null'} attachment_url=${r.attachment_url ? 'set' : 'null'}`);
  }

  const sicks     = leaves.filter(r => r.leave_type === 'sick');
  const personals = leaves.filter(r => r.leave_type === 'personal');
  const others    = leaves.filter(r => r.leave_type !== 'sick' && r.leave_type !== 'personal');

  if (others.length) {
    log(`${tag} ⚠️ 有非 sick/personal 的 leave (${others.map(o => `${o.leave_type}:${o.id}`).join(', ')}) — 不動、請人工確認`);
  }

  // 2. 決定 sick 保留 + personal 處理計畫
  let keepRow = null;          // 最終要留的 sick
  let toEditRow = null;        // 要做 admin_edit 的 row
  let editFields = [];         // admin_edit 改的欄位
  const toSoftDelete = [];     // 要軟刪的 rows

  if (sicks.length >= 1) {
    keepRow = sicks[0]; // id ASC 排序、第一筆 = 最早建立
    // 多筆 sick 的後續也軟刪(保險,目前 manifest 應該都只一筆)
    for (let i = 1; i < sicks.length; i++) toSoftDelete.push(sicks[i]);
    // 全部 personal 軟刪
    for (const p of personals) toSoftDelete.push(p);
    // 保留的 sick:proof_status 若非 submitted → admin_edit
    if (keepRow.proof_status !== 'submitted') {
      toEditRow = keepRow;
      editFields.push({ name: 'proof_status', old: keepRow.proof_status, new: 'submitted' });
    }
  } else if (personals.length >= 1) {
    keepRow = personals[0]; // 最早一筆 personal 還原
    for (let i = 1; i < personals.length; i++) toSoftDelete.push(personals[i]);
    toEditRow = keepRow;
    editFields.push({ name: 'leave_type', old: keepRow.leave_type, new: 'sick' });
    if (keepRow.proof_status !== 'submitted') {
      editFields.push({ name: 'proof_status', old: keepRow.proof_status, new: 'submitted' });
    }
  } else {
    log(`${tag} ⚠️ 該日沒有 sick/personal leave 可清,跳過`);
    summary.warn_no_leave++;
    // 但仍要嘗試修 attendance(若 absent 且該日確實是病假但連單都沒)? 不:沒單就不該標 leave
    // 結束
    return;
  }

  // 3. 印計畫並執行
  if (toEditRow && editFields.length > 0) {
    const auditLine = buildAuditLine(editFields);
    log(`${tag} [WILL admin_edit] ${toEditRow.id} ${editFields.map(f => `${f.name} ${formatAuditVal(f.old)}→${formatAuditVal(f.new)}`).join('、')}`);
    log(`         handler_note APPEND "${auditLine}"`);
    if (MODE === 'APPLY') {
      const patch = {};
      for (const f of editFields) patch[f.name] = f.new;
      try {
        await applyAdminEdit(toEditRow, patch, auditLine);
        log(`${tag} ✓ admin_edit done`);
        if (editFields.some(f => f.name === 'leave_type')) summary.revert_type++;
        if (editFields.some(f => f.name === 'proof_status')) summary.edit_proof++;
      } catch (e) {
        log(`${tag} ✗ admin_edit failed: ${e.message}`);
      }
    } else {
      if (editFields.some(f => f.name === 'leave_type')) summary.revert_type++;
      if (editFields.some(f => f.name === 'proof_status')) summary.edit_proof++;
    }
  } else if (keepRow) {
    log(`${tag} KEEP ${keepRow.leave_type} ${keepRow.id} proof_status=${keepRow.proof_status} (已是 submitted、不動)`);
    summary.edit_proof_skip++;
  }

  for (const r of toSoftDelete) {
    log(`${tag} [WILL soft-delete] ${r.leave_type} ${r.id} (proof_status=${r.proof_status})`);
    log(`         delete_reason="${DELETE_REASON}"`);
    log(`         handler_note APPEND "${buildDeleteAuditLine(DELETE_REASON)}"`);
    if (MODE === 'APPLY') {
      try {
        await applySoftDelete(r, DELETE_REASON);
        log(`${tag} ✓ soft-deleted ${r.id}`);
        summary.soft_deleted++;
      } catch (e) {
        log(`${tag} ✗ soft-delete failed (${r.id}): ${e.message}`);
      }
    } else {
      summary.soft_deleted++;
    }
  }

  // 4. attendance
  if (!att) {
    log(`${tag} ⚠️ attendance row 不存在,skip`);
    summary.att_skip_missing++;
  } else if (att.status === 'leave') {
    log(`${tag} SKIP attendance ${att.id} 已是 leave、不動`);
    summary.att_skip_already_leave++;
  } else if (att.status === 'absent') {
    const auditLine = `[考勤清理 ${AUDIT_DATE}] absent→leave(sick) cron誤轉還原`;
    log(`${tag} [WILL UPDATE attendance] ${att.id} status absent→leave; note PREPEND "${auditLine}"`);
    if (MODE === 'APPLY') {
      try {
        await applyAttUpdate(att, 'leave', auditLine);
        log(`${tag} ✓ attendance updated`);
        summary.att_updated++;
      } catch (e) {
        log(`${tag} ✗ attendance update failed: ${e.message}`);
      }
    } else {
      summary.att_updated++;
    }
  } else {
    log(`${tag} ⚠️ attendance ${att.id} status=${att.status}(非 absent/leave),不動、請人工確認`);
    summary.att_warn_other++;
  }
}

// ─── main ─────────────────────────────────────────────────
async function main() {
  log(`\n=== [${MODE}] 5月倉儲後勤部 cron-誤轉病假清理 actor=${ACTOR} ===`);
  log(`audit prefix date: ${AUDIT_DATE}`);
  log(`目標 ${TARGETS.length} 筆 (emp,date)`);

  for (const t of TARGETS) {
    try { await processOne(t); }
    catch (e) { console.error(`✗ exception on ${t.emp} ${t.date}:`, e.message); }
  }

  const verb = MODE === 'APPLY' ? '' : 'will ';
  log(`\n=== Summary (${MODE}) ===`);
  log(`admin_edit proof_status→submitted:    ${verb}${summary.edit_proof}  (already-submitted skip: ${summary.edit_proof_skip})`);
  log(`admin_edit leave_type personal→sick:  ${verb}${summary.revert_type}`);
  log(`soft-delete duplicate personal/sick:  ${verb}${summary.soft_deleted}`);
  log(`attendance absent→leave:              ${verb}${summary.att_updated}  (already-leave: ${summary.att_skip_already_leave}, missing: ${summary.att_skip_missing}, 其他: ${summary.att_warn_other})`);
  log(`warn no sick/personal on date:        ${summary.warn_no_leave}`);
  if (MODE === 'DRY-RUN') log(`\n(沒有寫入任何資料。確認後加 --apply 才會實際執行)`);
}

main().then(() => process.exit(0)).catch(e => { console.error('fatal:', e); process.exit(1); });
