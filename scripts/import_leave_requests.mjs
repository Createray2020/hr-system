#!/usr/bin/env node
// scripts/import_leave_requests.mjs — 歷史請假批次匯入(2026/1-4 月)
//
// 性質:同 import_attendance.mjs backfill — 直接 INSERT leave_requests、
//   不走 lib/leave/request-flow.js、status 直接 'approved'、不動餘額表
//   (annual_leave_records / comp_time_balance 完全不碰、餘額之後從系統重拉)。
//
// 來源:./秞希_出勤_202601-04.xlsx「總出勤紀錄」工作表第 10 欄(出勤狀況)
//   抓「假別+時段」regex match、一格可能多段(\n 分隔)。
//
// 用法:
//   # dry-run(預設、只解析印統計、不寫 DB):
//   node --env-file=.env.local scripts/import_leave_requests.mjs
//
//   # 真實寫入:
//   node --env-file=.env.local scripts/import_leave_requests.mjs --commit
//
// 需要環境變數:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY  或  SUPABASE_SERVICE_KEY

import { createClient } from '@supabase/supabase-js';
import xlsx from 'xlsx';

// ════════════════════════════════════════════════════════════
// 設定
// ════════════════════════════════════════════════════════════
const EXCEL_PATH = './秞希_出勤_202601-04.xlsx';
const SHEET_NAME = '總出勤紀錄';
const BATCH_SIZE = 200;

// 離職跳過(同 import_attendance.mjs:2 已知離職 + 2 對不到 active)
const RESIGNED_EMP_NOS = new Set(['02251002', '02251101', '01251101', '01251103']);

// 假別中文 → leave_type code 映射;null = 排除(調班非請假)
const LEAVE_TYPE_MAP = {
  '特休':            'annual',
  '病假':            'sick',
  '事假':            'personal',
  '生理假':          'menstrual',
  '喪假':            'funeral',
  '公假':            'public',
  '補休/調休':       'comp',
  '補休(手動匯入用)': 'comp',
  '補休':            'comp',
  '調班(休)':        null,
  '調班':            null,
};

// 抓「假別+時段」regex(/g 一格可能多段)。alternation 左→右、長的在前避免 prefix overlap。
const LEAVE_EVENT_RE = /(特休|病假|事假|生理假|喪假|公假|補休\/調休|補休\(手動匯入用\)|補休|調班\(休\)|調班)(\d{2}):(\d{2})-(\d{2}):(\d{2})/g;

const COMMIT = process.argv.includes('--commit');

// ════════════════════════════════════════════════════════════
// helpers
// ════════════════════════════════════════════════════════════
function calcHours(h1, m1, h2, m2) {
  const startMin = h1 * 60 + m1;
  let endMin = h2 * 60 + m2;
  if (endMin <= startMin) endMin += 24 * 60;   // 跨日
  const dur = endMin - startMin;
  // 扣午休 overlap(12:00-13:00 = [720, 780])
  const lunchOverlap = Math.max(0, Math.min(endMin, 780) - Math.max(startMin, 720));
  const netMin = dur - lunchOverlap;
  return Math.round((netMin / 60) * 100) / 100;
}

function addOneDayStr(dateStr) {
  // 'YYYY-MM-DD' → 隔天 'YYYY-MM-DD'
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function buildIsoTaipei(dateStr, hh, mm) {
  return `${dateStr}T${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}:00+08:00`;
}

// ════════════════════════════════════════════════════════════
// main
// ════════════════════════════════════════════════════════════
async function main() {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('❌ 缺少環境變數 SUPABASE_URL 或 SUPABASE_SERVICE_ROLE_KEY/SUPABASE_SERVICE_KEY');
    console.error('   用法:node --env-file=.env.local scripts/import_leave_requests.mjs [--commit]');
    process.exit(1);
  }
  const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

  console.log(`\n📋 ${COMMIT ? '[COMMIT MODE] ' : '[DRY-RUN] '}讀取 ${EXCEL_PATH}…\n`);

  // ─── Step 1:讀 Excel ───
  const wb = xlsx.readFile(EXCEL_PATH);
  const sheet = wb.Sheets[SHEET_NAME];
  if (!sheet) {
    console.error(`❌ 找不到工作表「${SHEET_NAME}」、可用工作表:${wb.SheetNames.join(', ')}`);
    process.exit(1);
  }
  const allRows = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: null, raw: false });
  const dataRows = allRows.slice(1);
  console.log(`  Excel 資料列:${dataRows.length}`);

  // ─── Step 2:撈員工對照 ───
  const { data: emps, error: empErr } = await sb
    .from('employees')
    .select('id, emp_no, name, status')
    .eq('status', 'active');
  if (empErr) {
    console.error('❌ 撈 employees 失敗:', empErr.message);
    process.exit(1);
  }
  const empByNo = new Map();
  for (const e of (emps || [])) {
    if (e.emp_no) empByNo.set(String(e.emp_no).trim(), e);
  }
  console.log(`  Active 員工數:${emps?.length || 0}、其中 ${empByNo.size} 人有 emp_no\n`);

  // ─── Step 3:逐 row 解析 ───
  const stats = {
    total_rows:        dataRows.length,
    rows_with_leave:   0,    // 有 matched 的列數
    skip_resigned:     0,    // 列數
    skip_unmatched:    0,
    skip_no_emp_no:    0,
    events_total:      0,    // 假別事件總數(含被排除的 調班)
    events_excluded:   0,    // 調班 / 調班(休)
    events_kept:       0,    // 實際進 leave_requests
    by_type:           {},
    by_employee_days:  new Map(),   // emp_id → total days
    rows_by_month:     {},
    id_conflicts:      0,    // 同 (emp+date+type) 出現第2/3筆 + 後綴
    unmatched_nos:     new Set(),
  };

  const leaveRows = [];
  const seenIds = new Map();  // baseId → already used count

  for (let i = 0; i < dataRows.length; i++) {
    const r = dataRows[i] || [];
    const empNo    = r[0] != null ? String(r[0]).trim() : '';
    const dateRaw  = r[4];
    const col9     = r[9];

    if (!empNo) { stats.skip_no_emp_no++; continue; }
    if (!col9)  continue;            // 無出勤狀況 → 無請假事件
    if (!String(col9).match(LEAVE_EVENT_RE)) continue;  // 沒任何假別事件

    stats.rows_with_leave++;

    if (RESIGNED_EMP_NOS.has(empNo)) {
      stats.skip_resigned++;
      continue;
    }
    const emp = empByNo.get(empNo);
    if (!emp) {
      stats.skip_unmatched++;
      stats.unmatched_nos.add(empNo);
      continue;
    }

    const dateStr = dateRaw != null ? String(dateRaw).slice(0, 10) : '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) continue;

    // 用 matchAll 抓所有事件
    const c9 = String(col9);
    const matches = [...c9.matchAll(LEAVE_EVENT_RE)];
    stats.events_total += matches.length;

    for (const m of matches) {
      const typeZh = m[1];
      const h1 = Number(m[2]), m1 = Number(m[3]);
      const h2 = Number(m[4]), m2 = Number(m[5]);

      const code = LEAVE_TYPE_MAP[typeZh];
      if (code === null) {
        // 排除(調班)
        stats.events_excluded++;
        continue;
      }
      if (code === undefined) {
        // 不在 map(理論不可能、regex 跟 map 對齊)
        console.warn(`  ⚠ 未映射的假別「${typeZh}」、跳過(row ${i+2})`);
        continue;
      }

      const hours = calcHours(h1, m1, h2, m2);
      const days  = Math.round((hours / 8) * 100) / 100;

      // 跨日判定:end <= start 視為跨日
      const startMin = h1 * 60 + m1;
      const endMin   = h2 * 60 + m2;
      const crossesMidnight = endMin <= startMin;
      const endDateStr = crossesMidnight ? addOneDayStr(dateStr) : dateStr;

      const startAt = buildIsoTaipei(dateStr,    h1, m1);
      const endAt   = buildIsoTaipei(endDateStr, h2, m2);

      // id:`L_HIST_{emp_id}_{YYYYMMDD}_{leave_type}`,同 baseId 第 2 筆起加 _2 / _3
      const idDate = dateStr.replace(/-/g, '');
      const baseId = `L_HIST_${emp.id}_${idDate}_${code}`;
      const cur = (seenIds.get(baseId) || 0) + 1;
      seenIds.set(baseId, cur);
      const id = cur === 1 ? baseId : `${baseId}_${cur}`;
      if (cur > 1) stats.id_conflicts++;

      // applied_at / reviewed_at / handled_at:用 start_date 當天 09:00+08:00(歷史時間)
      const histTs = `${dateStr}T09:00:00+08:00`;

      const row = {
        id,
        employee_id:      emp.id,
        leave_type:       code,
        start_at:         startAt,
        end_at:           endAt,
        start_date:       dateStr,
        end_date:         endDateStr,
        hours,
        finalized_hours:  hours,
        days,
        status:           'approved',
        reason:           '歷史資料補登(2026/1-4 月舊系統轉移)',
        handler_note:     '系統批次匯入歷史請假',
        applied_at:       histTs,
        reviewed_at:      histTs,
        handled_at:       histTs,
        late_application: false,
        proof_status:     'not_required',
      };

      leaveRows.push(row);
      stats.events_kept++;
      stats.by_type[code] = (stats.by_type[code] || 0) + 1;
      stats.by_employee_days.set(emp.id,
        Math.round(((stats.by_employee_days.get(emp.id) || 0) + days) * 100) / 100);
      const month = dateStr.slice(0, 7);
      stats.rows_by_month[month] = (stats.rows_by_month[month] || 0) + 1;
    }
  }

  // ─── Step 4:印統計 ───
  console.log('═══ 解析統計 ═══');
  console.log(`  Excel 資料列:        ${stats.total_rows}`);
  console.log(`  有請假事件的列:      ${stats.rows_with_leave}`);
  console.log(`  跳過離職員工(列):    ${stats.skip_resigned}`);
  console.log(`  跳過 emp_no 對不到:  ${stats.skip_unmatched}` +
              (stats.unmatched_nos.size ? `(編號:${[...stats.unmatched_nos].join(', ')})` : ''));
  console.log();
  console.log(`  假別事件總數:        ${stats.events_total}`);
  console.log(`  排除(調班/調班(休)):${stats.events_excluded}`);
  console.log(`  ✅ 實際進 leave_requests: ${stats.events_kept} 筆`);
  console.log(`  同 (emp+date+type) 多段 → 加序號後綴: ${stats.id_conflicts} 次`);
  console.log();
  console.log('  各 leave_type 分布:');
  for (const [code, c] of Object.entries(stats.by_type).sort((a,b)=>b[1]-a[1])) {
    console.log(`    ${code.padEnd(12)} ${c}`);
  }
  console.log();
  console.log('  各月分布:');
  for (const [m, c] of Object.entries(stats.rows_by_month).sort()) {
    console.log(`    ${m}  ${c} 筆`);
  }
  console.log();
  console.log(`  Distinct 員工:       ${stats.by_employee_days.size}`);
  console.log(`  各員工總天數(top 10):`);
  const empDaysSorted = [...stats.by_employee_days.entries()].sort((a,b)=>b[1]-a[1]).slice(0,10);
  for (const [eid, d] of empDaysSorted) {
    console.log(`    ${eid.padEnd(20)} ${d} 天`);
  }
  console.log();

  // ─── Step 5:dry-run 收手 ───
  if (!COMMIT) {
    console.log(`[DRY-RUN] 不寫 DB。要真寫加 --commit 重跑。\n`);
    return;
  }

  // ─── Step 6:分批 upsert ───
  console.log(`🚀 開始寫入(分批 ${BATCH_SIZE} 筆、onConflict=id、ignoreDuplicates=true)…\n`);
  let writtenTotal = 0;
  let batchNo = 0;
  let dbErrors = 0;
  for (let i = 0; i < leaveRows.length; i += BATCH_SIZE) {
    batchNo++;
    const batch = leaveRows.slice(i, i + BATCH_SIZE);
    const { data, error } = await sb
      .from('leave_requests')
      .upsert(batch, { onConflict: 'id', ignoreDuplicates: true })
      .select('id');
    if (error) {
      console.error(`  ❌ batch ${batchNo} (${batch.length} 筆):${error.message}`);
      dbErrors++;
      continue;
    }
    const insertedCount = (data || []).length;
    writtenTotal += insertedCount;
    console.log(`  ✓ batch ${batchNo}:送 ${batch.length}、新寫入 ${insertedCount}、衝突跳過 ${batch.length - insertedCount}`);
  }

  console.log();
  console.log(`✅ 完成:解析 ${stats.events_kept} 筆、實際新寫入 ${writtenTotal}、衝突跳過 ${stats.events_kept - writtenTotal}、DB 錯誤 ${dbErrors} 個 batch\n`);
}

main().catch(e => {
  console.error('❌ 未捕獲錯誤:', e);
  process.exit(1);
});
