#!/usr/bin/env node
// scripts/settle_warehouse_bonus_202605.mjs
// 一次性 2026-05 手動結算 4 筆 salary_records(倉儲 3 + 陳繹羽)
//
// 用法:
//   # dry-run(預設,不寫入):
//   node --env-file=.env.local scripts/settle_warehouse_bonus_202605.mjs --actor=<admin_id>
//
//   # 實際寫入:
//   node --env-file=.env.local scripts/settle_warehouse_bonus_202605.mjs --apply --actor=<admin_id>
//
// 前置:dry-run + apply 都會先查 邱子于 / 洪千雅 2026 全年累計病假(approved+archived、undeleted),
//      ≤10 才繼續(§9-1)。任一 >10 → 印警告、停。
//
// 目標 4 筆:
//   1. 邱子于 EMP_01240301:rate 0.05→0、actual 1900→2000、deduct_other 0→1166.67
//   2. 洪千雅 EMP_01220301:rate 0.10→0、actual 1800→2000、deduct_other 0→2733.33
//   3. 余靜芬 EMP_01251108:不動數值、只 append admin_audit_note
//   4. 陳繹羽 EMP_01251111:rate 0.075→0.05、actual 1850→1900
//
// 慣例:
//   - gross/net 是 GENERATED、不寫。只動組成欄位。
//   - audit_note APPEND(對齊 api/leaves/[id].js:215-217 模式):
//       '[YYYY-MM-DD] admin_edit by <actor>: <changes>; <reason>; [FORCE 本月一次性手動結算、不再跑 calculator]'
//   - idempotent:既有 admin_audit_note 已含 '[FORCE 本月一次性手動結算' marker → skip+warn

import { createClient } from '@supabase/supabase-js';

// ─── CLI ────────────────────────────────────────────
const args = process.argv.slice(2);
const flags = { apply: false, actor: null };
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--apply') flags.apply = true;
  else if (args[i].startsWith('--actor=')) flags.actor = args[i].slice('--actor='.length);
  else if (args[i] === '--actor' && args[i + 1]) flags.actor = args[++i];
}
if (!flags.actor) {
  console.error('Usage: node --env-file=.env.local scripts/settle_warehouse_bonus_202605.mjs [--apply] --actor=<admin_id>');
  process.exit(1);
}
const MODE = flags.apply ? 'APPLY' : 'DRY-RUN';
const ACTOR = flags.actor;
const AUDIT_DATE = '2026-05-30';
const FORCE_MARKER = '[FORCE 本月一次性手動結算、不再跑 calculator]';

// ─── env ────────────────────────────────────────────
const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !KEY) { console.error('❌ 缺 SUPABASE_URL / SUPABASE_SERVICE_KEY'); process.exit(1); }
const sb = createClient(URL, KEY, { auth: { autoRefreshToken: false, persistSession: false } });

// ─── helpers ────────────────────────────────────────
const fmt = (v) => {
  if (v == null) return '—';
  if (typeof v !== 'number') return String(v);
  // 小於 1 的 rate 用 String() 保留原始精度(避免 0.075 顯示 0.07);其他用 2 位小數
  if (v > 0 && v < 1) return String(v);
  return v.toFixed(2);
};
const appendNote = (prev, line) => prev ? `${prev}\n${line}` : line;
const hasMarker = (note) => !!(note && String(note).includes(FORCE_MARKER));

// ─── 前置:邱子于 / 洪千雅 2026 YTD sick ───────────────
async function ytdSickDays(empId) {
  const { data, error } = await sb.from('leave_requests')
    .select('start_at, status, hours, finalized_hours, days')
    .eq('employee_id', empId)
    .eq('leave_type', 'sick')
    .is('deleted_at', null)
    .in('status', ['approved', 'archived'])
    .gte('start_at', '2026-01-01T00:00:00+08:00')
    .lt('start_at', '2027-01-01T00:00:00+08:00');
  if (error) throw error;
  let total = 0;
  const detail = [];
  for (const r of (data || [])) {
    const d = r.finalized_hours != null ? Number(r.finalized_hours) / 8
            : r.hours != null ? Number(r.hours) / 8
            : Number(r.days) || 0;
    total += d;
    detail.push(`${r.start_at.slice(0,10)} ${d}d ${r.status}`);
  }
  return { total, detail };
}

// ─── manifest ───────────────────────────────────────
const TARGETS = [
  {
    id: 'S_EMP_01240301_2026_05',
    empId: 'EMP_01240301',
    empName: '邱子于',
    needsYtdCheck: true,
    updates: {
      attendance_bonus_deduction_rate: { from: 0.05, to: 0 },
      attendance_bonus_actual:         { from: 1900, to: 2000 },
      deduct_other:                    { from: 0,    to: 1166.67 },
      deduct_other_note: {
        from: null,
        to: '5月病假折半:2天 × 月工資總額35000/30 × 0.5 = 1166.67 (§4 病假工資折半)',
      },
    },
    reason: '§4 病假工資折半 + §9-1 病假≤10日不扣全勤',
  },
  {
    id: 'S_EMP_01220301_2026_05',
    empId: 'EMP_01220301',
    empName: '洪千雅',
    needsYtdCheck: true,
    updates: {
      attendance_bonus_deduction_rate: { from: 0.10, to: 0 },
      attendance_bonus_actual:         { from: 1800, to: 2000 },
      deduct_other:                    { from: 0,    to: 2733.33 },
      deduct_other_note: {
        from: null,
        to: '5月病假折半:4天 × 月工資總額41000/30 × 0.5 = 2733.33 (§4 病假工資折半)',
      },
    },
    reason: '§4 病假工資折半 + §9-1 病假≤10日不扣全勤',
  },
  {
    id: 'S_EMP_01251108_2026_05',
    empId: 'EMP_01251108',
    empName: '余靜芬',
    needsYtdCheck: false,
    updates: {}, // 不動數值
    customAudit: '本月全勤全額、無病假;5/15 早退已於考勤面補休處理(comp 2.5h);grade 1000 已由重跑補入',
  },
  {
    id: 'S_EMP_01251111_2026_05',
    empId: 'EMP_01251111',
    empName: '陳繹羽',
    needsYtdCheck: false,
    updates: {
      attendance_bonus_deduction_rate: { from: 0.075, to: 0.05 },
      attendance_bonus_actual:         { from: 1850,  to: 1900 },
    },
    reason: '§9-1:5/27 approved 病假 0.5d 不扣全勤、補回 50;2026 累計病假 4d≤10 受保護',
  },
];

function buildAuditLine(t) {
  let body;
  if (t.customAudit) {
    body = t.customAudit;
  } else {
    const fields = Object.entries(t.updates)
      .filter(([k]) => k !== 'deduct_other_note') // note 不列入「逐欄 from→to」
      .map(([k, v]) => `${k} ${fmt(v.from)}→${fmt(v.to)}`);
    body = fields.join(', ');
    if (t.reason) body += `; ${t.reason}`;
  }
  return `[${AUDIT_DATE}] admin_edit by ${ACTOR}: ${body}; ${FORCE_MARKER}`;
}

// ─── main ───────────────────────────────────────────
async function main() {
  console.log(`\n=== [${MODE}] 2026-05 結算 4 筆 salary_records actor=${ACTOR} ===`);

  // 1. YTD sick 前置檢查
  console.log(`\n--- 前置:§9-1 YTD 病假 ≤10 檢查 ---`);
  const ytdResults = {};
  let block = false;
  for (const t of TARGETS) {
    if (!t.needsYtdCheck) continue;
    const r = await ytdSickDays(t.empId);
    ytdResults[t.empId] = r;
    const ok = r.total <= 10;
    console.log(`  ${t.empId} ${t.empName}: 2026 累計 sick = ${r.total.toFixed(2)}d ${ok ? '✓ ≤10' : '⚠ >10'}`);
    for (const d of r.detail) console.log(`    ${d}`);
    if (!ok) block = true;
  }
  if (block) {
    console.error('\n❌ 有員工 2026 累計病假超過 10 日、§9-1 全額補全勤不適用。停。回報 Ray 重新計算。');
    process.exit(2);
  }

  // 2. 對每筆 target 印計畫(+ apply)
  console.log(`\n--- 結算 4 筆 ---\n`);
  let applied = 0, skipped = 0;
  for (const t of TARGETS) {
    console.log(`【${t.empName} (${t.id})】`);

    const { data: row, error } = await sb.from('salary_records')
      .select('id, attendance_bonus_base, attendance_bonus_deduction_rate, attendance_bonus_actual, deduct_other, deduct_other_note, grade_allowance, manager_allowance, gross_salary, net_salary, admin_audit_note')
      .eq('id', t.id).maybeSingle();
    if (error) { console.error(`  ✗ 查 row 失敗:${error.message}`); continue; }
    if (!row) { console.error(`  ✗ 找不到 row`); continue; }

    // idempotent check
    if (hasMarker(row.admin_audit_note)) {
      console.log(`  SKIP 已有 FORCE marker、視為已結算、不重複套`);
      skipped++;
      console.log();
      continue;
    }

    // 印 before(欄位現況)
    console.log(`  before:`);
    console.log(`    bonus_base=${row.attendance_bonus_base} rate=${fmt(row.attendance_bonus_deduction_rate)} actual=${fmt(row.attendance_bonus_actual)}`);
    console.log(`    deduct_other=${fmt(row.deduct_other)} note=${row.deduct_other_note || 'null'}`);
    console.log(`    grade_allowance=${fmt(row.grade_allowance)} manager_allowance=${fmt(row.manager_allowance)}`);
    console.log(`    gross=${fmt(row.gross_salary)} net=${fmt(row.net_salary)}`);

    // 計算 patch + 預期 gross/net
    const patch = {};
    let deltaBonus = 0, deltaDeductOther = 0;
    for (const [k, v] of Object.entries(t.updates)) {
      patch[k] = v.to;
      if (k === 'attendance_bonus_actual') deltaBonus = (v.to ?? 0) - Number(row.attendance_bonus_actual ?? 0);
      if (k === 'deduct_other') deltaDeductOther = (v.to ?? 0) - Number(row.deduct_other ?? 0);
    }
    const auditLine = buildAuditLine(t);
    patch.admin_audit_note = appendNote(row.admin_audit_note, auditLine);

    const expectedGross = Number(row.gross_salary || 0) + deltaBonus;
    const expectedNet   = Number(row.net_salary   || 0) + deltaBonus - deltaDeductOther;

    // 印 after
    console.log(`  WILL UPDATE:`);
    if (Object.keys(t.updates).length === 0) {
      console.log(`    (無數值變更)`);
    } else {
      for (const [k, v] of Object.entries(t.updates)) {
        if (k === 'deduct_other_note') {
          console.log(`    ${k}: ${v.from === null ? 'null' : v.from} → "${v.to}"`);
        } else {
          console.log(`    ${k}: ${fmt(v.from)} → ${fmt(v.to)}`);
        }
      }
    }
    console.log(`    admin_audit_note APPEND: "${auditLine}"`);
    console.log(`  預期 gross: ${fmt(row.gross_salary)} → ${fmt(expectedGross)} (Δ ${fmt(deltaBonus)})`);
    console.log(`  預期 net:   ${fmt(row.net_salary)} → ${fmt(expectedNet)} (Δ ${fmt(deltaBonus - deltaDeductOther)})`);

    if (MODE === 'APPLY') {
      const { error: updErr } = await sb.from('salary_records').update(patch).eq('id', t.id);
      if (updErr) {
        console.error(`  ✗ UPDATE 失敗:${updErr.message}`);
      } else {
        // 重新讀印 actual after
        const { data: after } = await sb.from('salary_records')
          .select('gross_salary, net_salary, attendance_bonus_actual, deduct_other')
          .eq('id', t.id).maybeSingle();
        console.log(`  ✓ done`);
        console.log(`  實際 after: gross=${fmt(after.gross_salary)} net=${fmt(after.net_salary)} actual=${fmt(after.attendance_bonus_actual)} deduct_other=${fmt(after.deduct_other)}`);
        applied++;
      }
    }
    console.log();
  }

  console.log(`=== Summary (${MODE}) ===`);
  if (MODE === 'APPLY') {
    console.log(`applied=${applied}, skipped=${skipped}, total=${TARGETS.length}`);
  } else {
    console.log(`will apply=${TARGETS.length - skipped}, skipped(已有 FORCE marker)=${skipped}`);
    console.log(`\n(沒寫入。確認後加 --apply 才會 UPDATE salary_records)`);
  }
}

main().then(() => process.exit(0)).catch(e => { console.error('fatal:', e); process.exit(1); });
