#!/usr/bin/env node
// scripts/import_attendance.mjs — 歷史出勤批次匯入(2026/1-4 月)
//
// 性質:backfill — 直接寫 attendance、不經 clock.js lib、不建 schedule_periods /
// schedules、不呼叫 recompute(Excel 值即事實)。
//
// 用法:
//   # dry-run(預設、只解析印統計、不寫 DB):
//   node --env-file=.env.local scripts/import_attendance.mjs
//
//   # 真實寫入:
//   node --env-file=.env.local scripts/import_attendance.mjs --commit
//
// 需要環境變數:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY  或  SUPABASE_SERVICE_KEY
//     (繞 RLS / gate、historical backfill;對齊 .env.local 既有 + recompute script convention)
//
// 寫入策略:
//   - upsert onConflict=(employee_id, work_date) + ignoreDuplicates=true
//     → 已存在的 row 跳過、不覆寫(保護 4 月既有 63 筆真實打卡)
//   - 分批 200 筆、逐批印進度

import { createClient } from '@supabase/supabase-js';
import xlsx from 'xlsx';

// ════════════════════════════════════════════════════════════
// 設定
// ════════════════════════════════════════════════════════════
const EXCEL_PATH = './秞希_出勤_202601-04.xlsx';
const SHEET_NAME = '總出勤紀錄';
const BATCH_SIZE = 200;

// 離職員工(整人不匯)
const RESIGNED_EMP_NOS = new Set(['02251002', '02251101']);

// 請假關鍵字 — col 9 出勤狀況 / col 13 說明 含這些 → 無打卡時走 status='leave'
const LEAVE_KEYWORDS = ['特休', '病假', '事假', '生理假', '喪假', '公假', '補休', '調休', '調班'];

// CLI flag
const COMMIT = process.argv.includes('--commit');

// ════════════════════════════════════════════════════════════
// helpers
// ════════════════════════════════════════════════════════════
function parseWorkHours(s) {
  // '8時28分' → 8 + 28/60 = 8.47
  if (!s) return null;
  const m = String(s).match(/(\d+)時(\d+)分/);
  if (!m) return null;
  const hours = Number(m[1]) + Number(m[2]) / 60;
  return Math.round(hours * 100) / 100;
}

function parseFirstNumber(s) {
  // '2分鐘' / '15 mins' / '0' / null → 抽第一個數字
  if (!s) return 0;
  const m = String(s).match(/(\d+)/);
  return m ? Number(m[1]) : 0;
}

function parseOvertimeHours(col9) {
  // 出勤狀況 col 9 可能含多段、抓所有 [加班]HH:MM-HH:MM 算分鐘加總
  if (!col9) return 0;
  const re = /\[加班\](\d{2}):(\d{2})-(\d{2}):(\d{2})/g;
  let totalMin = 0;
  let m;
  while ((m = re.exec(String(col9))) !== null) {
    const startMin = Number(m[1]) * 60 + Number(m[2]);
    let endMin = Number(m[3]) * 60 + Number(m[4]);
    if (endMin <= startMin) endMin += 24 * 60;  // 跨日 + 24h
    totalMin += (endMin - startMin);
  }
  return Math.round((totalMin / 60) * 100) / 100;
}

function buildTimestamp(workDate, timeStr) {
  // work_date='YYYY-MM-DD' + 'HH:MM:SS' → 'YYYY-MM-DDTHH:MM:SS+08:00'
  if (!timeStr) return null;
  const t = String(timeStr).trim();
  if (!/^\d{2}:\d{2}:\d{2}$/.test(t)) return null;
  return `${workDate}T${t}+08:00`;
}

function determineStatus(col9, col10, lateMin, earlyLeaveMin, hasClockIn, hasClockOut, scheduledStr) {
  const c9 = String(col9 || '');
  if (c9.includes('曠職')) return 'absent';
  if (scheduledStr === '國定假日' && (hasClockIn || hasClockOut)) return 'holiday';
  if (lateMin > 0) return 'late';
  if (earlyLeaveMin > 0) return 'early_leave';
  if (hasClockIn || hasClockOut) return 'normal';
  // 完全無打卡
  const c10 = String(col10 || '');
  const leaveHit = LEAVE_KEYWORDS.some(k => c9.includes(k) || c10.includes(k));
  if (leaveHit) return 'leave';
  return null;  // 不產生 row(例假日 / 休息日 / 空班日 / 國定無上班等)
}

// ════════════════════════════════════════════════════════════
// main
// ════════════════════════════════════════════════════════════
async function main() {
  // ─── env check ───
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('❌ 缺少環境變數 SUPABASE_URL 或 SUPABASE_SERVICE_ROLE_KEY/SUPABASE_SERVICE_KEY');
    console.error('   用法:node --env-file=.env.local scripts/import_attendance.mjs [--commit]');
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
  // header:1 → array of arrays、raw:false → 數值 / 日期照字串顯示、defval:null
  const allRows = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: null, raw: false });
  const dataRows = allRows.slice(1);  // 跳過表頭
  console.log(`  Excel 總列數:${allRows.length}(含表頭)、資料列:${dataRows.length}`);

  // ─── Step 2:撈員工對照(emp_no → id) ───
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
    total_rows:       dataRows.length,
    skip_resigned:    0,
    skip_unmatched:   0,
    skip_no_emp_no:   0,
    skip_no_row:      0,    // 不產生 row(例假/休息日 等)
    parsed:           0,
    by_status:        { normal: 0, late: 0, early_leave: 0, absent: 0, leave: 0, holiday: 0 },
    with_overtime:    0,
    rows_by_month:    {},
    distinct_emps:    new Set(),
    unmatched_nos:    new Set(),
  };

  const attendanceRows = [];

  for (let i = 0; i < dataRows.length; i++) {
    const r = dataRows[i] || [];
    const empNo       = r[0] != null ? String(r[0]).trim() : '';
    const dateRaw     = r[4];
    const scheduledStr= r[5] != null ? String(r[5]).trim() : '';
    const clockInStr  = r[6];
    const clockOutStr = r[7];
    const col9        = r[9];      // 出勤狀況(含加班/請假/補登)
    const workHoursStr= r[10];     // '8時28分'
    const lateStr     = r[11];     // '2分鐘'
    const earlyStr    = r[12];     // '15分鐘'
    const col13Note   = r[13];     // 說明

    // (a) 空 emp_no
    if (!empNo) {
      stats.skip_no_emp_no++;
      continue;
    }
    // (b) 離職整人跳過
    if (RESIGNED_EMP_NOS.has(empNo)) {
      stats.skip_resigned++;
      continue;
    }
    // (c) Excel 員工編號對不到 active employee
    const emp = empByNo.get(empNo);
    if (!emp) {
      stats.skip_unmatched++;
      stats.unmatched_nos.add(empNo);
      continue;
    }

    // (d) 日期 — 取前 10 字元(YYYY-MM-DD)、換行後的假日名忽略
    const dateStr = dateRaw != null ? String(dateRaw).slice(0, 10) : '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      stats.skip_no_row++;
      continue;
    }

    const clockInIso  = buildTimestamp(dateStr, clockInStr);
    const clockOutIso = buildTimestamp(dateStr, clockOutStr);
    const hasClockIn  = !!clockInIso;
    const hasClockOut = !!clockOutIso;

    const workHours      = parseWorkHours(workHoursStr);
    const lateMinutes    = parseFirstNumber(lateStr);
    const earlyLeaveMin  = parseFirstNumber(earlyStr);
    const overtimeHours  = parseOvertimeHours(col9);

    const status = determineStatus(
      col9, col13Note, lateMinutes, earlyLeaveMin, hasClockIn, hasClockOut, scheduledStr,
    );
    if (status === null) {
      stats.skip_no_row++;
      continue;
    }

    const isHolidayWork = (scheduledStr === '國定假日') && (hasClockIn || hasClockOut);

    // note:出勤狀況 + 說明 串接(保留原文、含 \r\n 前綴)
    const noteParts = [];
    if (col9)      noteParts.push(String(col9).trim());
    if (col13Note) noteParts.push(String(col13Note).trim());
    const note = noteParts.join(' | ').slice(0, 2000);  // 防爆長

    // id pattern:A_<emp_id>_<YYYYMMDD>_1
    const idDate = dateStr.replace(/-/g, '');
    const id = `A_${emp.id}_${idDate}_1`;

    const row = {
      id,
      employee_id:         emp.id,
      work_date:           dateStr,
      clock_in:            clockInIso,
      clock_out:           clockOutIso,
      work_hours:          workHours,
      overtime_hours:      overtimeHours,
      late_minutes:        lateMinutes,
      early_leave_minutes: earlyLeaveMin,
      status,
      is_holiday_work:     isHolidayWork,
      note,
      segment_no:          1,
    };

    attendanceRows.push(row);
    stats.parsed++;
    stats.by_status[status] = (stats.by_status[status] || 0) + 1;
    if (overtimeHours > 0) stats.with_overtime++;
    stats.distinct_emps.add(emp.id);

    const month = dateStr.slice(0, 7);
    stats.rows_by_month[month] = (stats.rows_by_month[month] || 0) + 1;
  }

  // ─── Step 4:印統計 ───
  console.log('═══ 解析統計 ═══');
  console.log(`  總資料列:${stats.total_rows}`);
  console.log(`  跳過離職:${stats.skip_resigned}(02251002 / 02251101)`);
  console.log(`  跳過 emp_no 對不到 active:${stats.skip_unmatched}` +
              (stats.unmatched_nos.size ? `(編號:${[...stats.unmatched_nos].join(', ')})` : ''));
  console.log(`  跳過空 emp_no:${stats.skip_no_emp_no}`);
  console.log(`  跳過不產生 row(例假/休息日/空班/國定無上班等):${stats.skip_no_row}`);
  console.log(`  ✅ 解析出可寫入:${stats.parsed} 筆`);
  console.log();
  console.log('  Status 分布:');
  for (const [k, v] of Object.entries(stats.by_status)) {
    if (v > 0) console.log(`    ${k.padEnd(12)} ${v}`);
  }
  console.log();
  console.log(`  有加班的列:${stats.with_overtime}`);
  console.log(`  Distinct 員工:${stats.distinct_emps.size} 人`);
  console.log(`  各月分布:`);
  for (const [m, c] of Object.entries(stats.rows_by_month).sort()) {
    console.log(`    ${m}  ${c} 筆`);
  }
  console.log();

  // ─── Step 5:dry-run 收手 ───
  if (!COMMIT) {
    console.log(`[DRY-RUN] 不寫 DB。要真寫加 --commit 重跑。\n`);
    return;
  }

  // ─── Step 6:分批 upsert ───
  console.log(`🚀 開始寫入(分批 ${BATCH_SIZE} 筆、onConflict=employee_id,work_date、ignoreDuplicates=true)…\n`);
  let writtenTotal = 0;
  let batchNo = 0;
  let dbErrors = 0;
  for (let i = 0; i < attendanceRows.length; i += BATCH_SIZE) {
    batchNo++;
    const batch = attendanceRows.slice(i, i + BATCH_SIZE);
    const { data, error } = await sb
      .from('attendance')
      .upsert(batch, {
        onConflict: 'employee_id,work_date',
        ignoreDuplicates: true,
      })
      .select('id');
    if (error) {
      console.error(`  ❌ batch ${batchNo} (${batch.length} 筆):${error.message}`);
      dbErrors++;
      continue;
    }
    const insertedCount = (data || []).length;
    writtenTotal += insertedCount;
    console.log(`  ✓ batch ${batchNo}:送 ${batch.length} 筆、新寫入 ${insertedCount}、衝突跳過 ${batch.length - insertedCount}`);
  }

  console.log();
  console.log(`✅ 完成:解析 ${stats.parsed} 筆、實際新寫入 ${writtenTotal} 筆、衝突跳過 ${stats.parsed - writtenTotal} 筆、DB 錯誤 ${dbErrors} 個 batch\n`);
}

main().catch(e => {
  console.error('❌ 未捕獲錯誤:', e);
  process.exit(1);
});
