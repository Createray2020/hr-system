#!/usr/bin/env node
// scripts/import_schedules.mjs — 歷史排班批次匯入(2026/1-4 月)
//
// 性質:同 import_attendance.mjs / import_leave_requests.mjs backfill —
//   走 supabaseAdmin 繞 API gate、直接 upsert schedule_periods + schedules。
//
// 來源:./秞希_出勤_202601-04.xlsx「總出勤紀錄」工作表第 6 欄(表定時間)。
//
// 用法:
//   # dry-run(預設、印統計、不寫 DB):
//   node --env-file=.env.local scripts/import_schedules.mjs
//
//   # 真實寫入:
//   node --env-file=.env.local scripts/import_schedules.mjs --commit
//
// 需要環境變數:SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY 或 SUPABASE_SERVICE_KEY

import { createClient } from '@supabase/supabase-js';
import xlsx from 'xlsx';

// ════════════════════════════════════════════════════════════
// 設定
// ════════════════════════════════════════════════════════════
const EXCEL_PATH = './秞希_出勤_202601-04.xlsx';
const SHEET_NAME = '總出勤紀錄';
const BATCH_SIZE = 200;

// 離職員工(整人跳過、對齊 import_attendance / import_leave_requests)
const RESIGNED_EMP_NOS = new Set(['02251002', '02251101', '01251101', '01251103']);

// 假日類映射(整欄文字 → shift_type_id、is_off=true、start/end=null)
const HOLIDAY_MAP = {
  '休息日': 'ST003',
  '例假日': 'ST004',
  '國定假日': 'ST008',
};

// 工作班 (start_time, end_time) → shift_type_id(完全相同才綁、其餘 null + custom 時段)
const WORK_SHIFT_LOOKUP = {
  '09:00-18:00': 'ST001',
  '10:00-19:00': 'ST005',
  '15:00-23:00': 'ST006',
  '19:00-03:00': 'ST007',
  '10:00-18:00': 'ST009',
};

// 開頭可能混入的「假別」字、要剝掉(同一格可能 '\n喪假0900-1800' 之類)
const LEADING_LEAVE_RE = /^[\s\r\n]*(?:喪假|特休|病假|事假|生理假|公假|補休\/調休|補休\(手動匯入用\)|補休|調休|調班\(休\)|調班)[\s\r\n]*/;

const COMMIT = process.argv.includes('--commit');

// ════════════════════════════════════════════════════════════
// helpers
// ════════════════════════════════════════════════════════════
function pad2(n) { return String(n).padStart(2, '0'); }

function lastDayOfMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

function parseScheduledTime(rawStr) {
  if (rawStr == null) return { kind: 'skip' };
  let s = String(rawStr).trim();
  if (!s) return { kind: 'skip' };

  // 剝開頭混入的假別字(repeat 直到沒得剝)
  let prev;
  do { prev = s; s = s.replace(LEADING_LEAVE_RE, '').trim(); } while (s !== prev);
  if (!s) return { kind: 'skip' };

  // 假日類
  if (HOLIDAY_MAP[s]) {
    return { kind: 'holiday', shift_type_id: HOLIDAY_MAP[s] };
  }
  if (s === '空班日') return { kind: 'skip' };

  // 剝後綴(取第一個逗號前;半形 + 全形都看)
  const cut1 = s.indexOf(',');
  const cut2 = s.indexOf('，');
  let cut = -1;
  if (cut1 >= 0 && cut2 >= 0) cut = Math.min(cut1, cut2);
  else if (cut1 >= 0) cut = cut1;
  else if (cut2 >= 0) cut = cut2;
  if (cut >= 0) s = s.substring(0, cut).trim();

  // 抓所有 HHMM-HHMM 段(spec:多段壓成一整段、start=第一段起、end=最後一段迄)
  const re = /(\d{4})-(\d{4})/g;
  const segs = [...s.matchAll(re)];
  if (!segs.length) return { kind: 'skip' };

  const first = segs[0];
  const last  = segs[segs.length - 1];
  const sH = first[1].slice(0, 2), sM = first[1].slice(2, 4);
  const eH = last[2].slice(0, 2),  eM = last[2].slice(2, 4);

  const startMin = Number(sH) * 60 + Number(sM);
  const endMin   = Number(eH) * 60 + Number(eM);
  const crosses  = endMin <= startMin;

  const key = `${sH}:${sM}-${eH}:${eM}`;
  const shift_type_id = WORK_SHIFT_LOOKUP[key] || null;

  return {
    kind: 'work',
    shift_type_id,
    start_time: `${sH}:${sM}:00`,
    end_time:   `${eH}:${eM}:00`,
    crosses_midnight: crosses,
  };
}

// ════════════════════════════════════════════════════════════
// main
// ════════════════════════════════════════════════════════════
async function main() {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('❌ 缺少環境變數 SUPABASE_URL 或 SUPABASE_SERVICE_ROLE_KEY/SUPABASE_SERVICE_KEY');
    console.error('   用法:node --env-file=.env.local scripts/import_schedules.mjs [--commit]');
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

  // ─── Step 3:解析 + 收集 schedules row + periods ───
  const stats = {
    total_rows:      dataRows.length,
    skip_resigned:   0,
    skip_unmatched:  0,
    skip_no_emp_no:  0,
    skip_empty:      0,     // 空班日 / null / 空字串
    skip_bad_date:   0,
    holidays:        { ST003: 0, ST004: 0, ST008: 0 },
    worked_matched:  0,
    worked_custom:   0,
    rows_by_month:   {},
    rows_apr:        0,
    distinct_emps:   new Set(),
    unmatched_nos:   new Set(),
    custom_samples:  [],    // 抽樣記前 5 筆自訂時段(spot-check 用)
  };

  const scheduleRows = [];
  const periodMap = new Map();    // 'emp_id_YYYY_MM' → period row

  for (let i = 0; i < dataRows.length; i++) {
    const r = dataRows[i] || [];
    const empNo    = r[0] != null ? String(r[0]).trim() : '';
    const dateRaw  = r[4];
    const schedStr = r[5];

    if (!empNo) { stats.skip_no_emp_no++; continue; }
    if (RESIGNED_EMP_NOS.has(empNo)) { stats.skip_resigned++; continue; }
    const emp = empByNo.get(empNo);
    if (!emp) {
      stats.skip_unmatched++;
      stats.unmatched_nos.add(empNo);
      continue;
    }

    const dateStr = dateRaw != null ? String(dateRaw).slice(0, 10) : '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      stats.skip_bad_date++;
      continue;
    }

    const parsed = parseScheduledTime(schedStr);
    if (parsed.kind === 'skip') { stats.skip_empty++; continue; }

    // 組 schedule row
    const idDate = dateStr.replace(/-/g, '');
    const year   = Number(dateStr.slice(0, 4));
    const month  = Number(dateStr.slice(5, 7));
    const periodId = `s_period_${emp.id}_${year}_${pad2(month)}`;

    const row = {
      id:           `S${emp.id}${idDate}_1`,
      employee_id:  emp.id,
      work_date:    dateStr,
      segment_no:   1,
      shift_type_id: parsed.shift_type_id || null,
      start_time:   parsed.kind === 'work' ? parsed.start_time : null,
      end_time:     parsed.kind === 'work' ? parsed.end_time   : null,
      crosses_midnight: parsed.kind === 'work' ? parsed.crosses_midnight : false,
      status:       'confirmed',
      period_id:    periodId,
      note:         '',
    };
    scheduleRows.push(row);

    // 統計
    if (parsed.kind === 'holiday') {
      stats.holidays[parsed.shift_type_id] = (stats.holidays[parsed.shift_type_id] || 0) + 1;
    } else {
      if (parsed.shift_type_id) stats.worked_matched++;
      else {
        stats.worked_custom++;
        if (stats.custom_samples.length < 5) {
          stats.custom_samples.push(`${dateStr} ${emp.id}: ${parsed.start_time}-${parsed.end_time}${parsed.crosses_midnight ? ' (跨日)' : ''}`);
        }
      }
    }
    stats.distinct_emps.add(emp.id);
    const ym = dateStr.slice(0, 7);
    stats.rows_by_month[ym] = (stats.rows_by_month[ym] || 0) + 1;
    if (month === 4) stats.rows_apr++;

    // 收 period(同 emp + 年 + 月 dedupe)
    const pKey = `${emp.id}_${year}_${pad2(month)}`;
    if (!periodMap.has(pKey)) {
      const periodStart = `${year}-${pad2(month)}-01`;
      const periodEnd   = `${year}-${pad2(month)}-${pad2(lastDayOfMonth(year, month))}`;
      periodMap.set(pKey, {
        id:           periodId,
        employee_id:  emp.id,
        period_year:  year,
        period_month: month,
        period_start: periodStart,
        period_end:   periodEnd,
        start_date:   periodStart,
        end_date:     periodEnd,
        status:       'draft',
      });
    }
  }

  // ─── Step 4:印統計 ───
  const holidaysTotal = stats.holidays.ST003 + stats.holidays.ST004 + stats.holidays.ST008;
  console.log('═══ 解析統計 ═══');
  console.log(`  Excel 資料列:             ${stats.total_rows}`);
  console.log(`  跳過離職:                 ${stats.skip_resigned}`);
  console.log(`  跳過 emp_no 對不到 active:${stats.skip_unmatched}` +
              (stats.unmatched_nos.size ? `(${[...stats.unmatched_nos].join(', ')})` : ''));
  console.log(`  跳過空 emp_no:            ${stats.skip_no_emp_no}`);
  console.log(`  跳過空班/空白:            ${stats.skip_empty}`);
  console.log(`  跳過日期格式錯:           ${stats.skip_bad_date}`);
  console.log();
  console.log(`  ✅ 要寫入的 schedules:    ${scheduleRows.length} 筆`);
  console.log(`     - 假日類:               ${holidaysTotal}(ST003:${stats.holidays.ST003}/ST004:${stats.holidays.ST004}/ST008:${stats.holidays.ST008})`);
  console.log(`     - 工作班(對到既有班別):${stats.worked_matched}`);
  console.log(`     - 工作班(自訂時段):    ${stats.worked_custom}`);
  console.log();
  console.log(`  Schedule_periods 要建:    ${periodMap.size} 筆(每員工每月一筆 draft、4 月既有 locked 會被 ignoreDuplicates 擋)`);
  console.log();
  console.log('  各月分布(schedules):');
  for (const [m, c] of Object.entries(stats.rows_by_month).sort()) {
    console.log(`    ${m}  ${c} 筆`);
  }
  console.log();
  console.log(`  Distinct 員工:            ${stats.distinct_emps.size}`);
  console.log(`  4 月 schedules row 數:    ${stats.rows_apr}(預期會被 ignoreDuplicates 擋下)`);
  console.log();
  if (stats.custom_samples.length) {
    console.log('  自訂時段抽樣(前 5):');
    for (const s of stats.custom_samples) console.log(`    ${s}`);
    console.log();
  }

  if (!COMMIT) {
    console.log(`[DRY-RUN] 不寫 DB。要真寫加 --commit 重跑。\n`);
    return;
  }

  // ─── Step 5:upsert schedule_periods ───
  console.log(`🚀 Step 1:upsert schedule_periods(${periodMap.size} 筆、onConflict=employee_id,period_year,period_month、ignoreDuplicates)…`);
  const periodRows = [...periodMap.values()];
  let pWritten = 0, pBatch = 0, pErr = 0;
  for (let i = 0; i < periodRows.length; i += BATCH_SIZE) {
    pBatch++;
    const b = periodRows.slice(i, i + BATCH_SIZE);
    const { data, error } = await sb
      .from('schedule_periods')
      .upsert(b, { onConflict: 'employee_id,period_year,period_month', ignoreDuplicates: true })
      .select('id');
    if (error) { console.error(`  ❌ period batch ${pBatch}:${error.message}`); pErr++; continue; }
    const n = (data || []).length;
    pWritten += n;
    console.log(`  ✓ period batch ${pBatch}:送 ${b.length}、新寫入 ${n}、衝突跳過 ${b.length - n}`);
  }

  // ─── Step 6:upsert schedules ───
  console.log(`\n🚀 Step 2:upsert schedules(${scheduleRows.length} 筆、onConflict=employee_id,work_date,segment_no、ignoreDuplicates)…`);
  let sWritten = 0, sBatch = 0, sErr = 0;
  for (let i = 0; i < scheduleRows.length; i += BATCH_SIZE) {
    sBatch++;
    const b = scheduleRows.slice(i, i + BATCH_SIZE);
    const { data, error } = await sb
      .from('schedules')
      .upsert(b, { onConflict: 'employee_id,work_date,segment_no', ignoreDuplicates: true })
      .select('id');
    if (error) { console.error(`  ❌ schedule batch ${sBatch}:${error.message}`); sErr++; continue; }
    const n = (data || []).length;
    sWritten += n;
    console.log(`  ✓ schedule batch ${sBatch}:送 ${b.length}、新寫入 ${n}、衝突跳過 ${b.length - n}`);
  }

  // ─── Step 7:UPDATE 1-3 月 draft period → locked ───
  console.log(`\n🚀 Step 3:UPDATE schedule_periods SET status='locked'、locked_at=NOW() WHERE 2026/1-3 月 + status='draft'…`);
  const { data: updRows, error: updErr } = await sb
    .from('schedule_periods')
    .update({ status: 'locked', locked_at: new Date().toISOString() })
    .eq('period_year', 2026)
    .in('period_month', [1, 2, 3])
    .eq('status', 'draft')
    .select('id');
  if (updErr) {
    console.error(`  ❌ lock update 失敗:${updErr.message}`);
  } else {
    console.log(`  ✓ locked ${(updRows || []).length} 個 schedule_periods`);
  }

  console.log();
  console.log(`✅ 完成:`);
  console.log(`   periods:   解析 ${periodMap.size}、新寫入 ${pWritten}、衝突跳過 ${periodMap.size - pWritten}、batch 錯誤 ${pErr}`);
  console.log(`   schedules:解析 ${scheduleRows.length}、新寫入 ${sWritten}、衝突跳過 ${scheduleRows.length - sWritten}、batch 錯誤 ${sErr}`);
  console.log(`   locked:    ${(updRows || []).length} 個 1-3 月 draft 已轉 locked\n`);
}

main().catch(e => {
  console.error('❌ 未捕獲錯誤:', e);
  process.exit(1);
});
