#!/usr/bin/env node
// scripts/apply-june-2026-schedule.mjs
//
// 把連線前線部 7 人 2026/06 最終 Excel 班表(A=早班/L=晚班/休=休假)
// 覆寫到 schedules(已 published 的佔位資料蓋過去)。
//
// 性質:走 supabaseAdmin、繞 /api/schedules endpoint、不發 wish-override 通知。
// 對該 7 人 × 6/1-6/30 × segment_no=1 共 210 列做 upsert。
//
// 用法:
//   # dry-run(預設、印 diff、不寫 DB):
//   node --env-file=.env.local scripts/apply-june-2026-schedule.mjs
//
//   # 真實寫入 + 寫稽核(每位員工一筆 manager_adjust):
//   node --env-file=.env.local scripts/apply-june-2026-schedule.mjs --apply

import { createClient } from '@supabase/supabase-js';
import { calculateScheduleWorkMinutes } from '../lib/schedule/work-hours.js';
import { logScheduleChange } from '../lib/schedule/change-logger.js';

// ════════════════════════════════════════════════════════════
// 來源資料(7 人 × 6/1..6/30 共 30 天、逗號分隔)
// ════════════════════════════════════════════════════════════
const SOURCE = {
  EMP_01250501: { name:'劉嘉昕', codes:'A,休,A,休,A,A,休,A,L,L,休,A,A,休,A,L,L,休,休,A,休,A,A,A,A,A,A,休,A,A' },
  EMP_01251111: { name:'陳繹羽', codes:'A,A,A,A,A,休,休,A,A,A,L,A,休,A,A,A,A,A,休,休,休,A,A,休,A,A,休,休,A,A' },
  EMP_01251106: { name:'徐嘉翎', codes:'A,A,休,休,A,休,A,A,L,L,L,L,休,A,A,A,A,A,休,L,L,休,A,A,休,休,A,休,A,A' },
  EMP_01251001: { name:'盧嘉凌', codes:'A,A,A,A,A,休,A,A,A,A,休,L,L,L,休,A,A,休,休,A,L,休,L,L,休,A,A,休,休,A' },
  EMP_01251105: { name:'翁莘惠', codes:'休,休,A,A,A,A,休,A,A,A,A,A,L,休,L,L,L,L,休,L,休,A,L,休,A,A,A,休,休,A' },
  EMP_01251003: { name:'陳郡葳', codes:'A,A,A,A,A,休,A,A,A,A,A,A,休,L,L,L,L,L,A,休,休,休,休,休,休,A,A,休,A,A' },
  EMP_01251002: { name:'黃筠庭', codes:'A,A,A,A,休,休,休,A,A,A,休,A,A,休,A,A,A,A,休,休,休,A,A,A,A,A,A,休,A,A' },
};

const YEAR  = 2026;
const MONTH = 6;
const DAYS  = 30;
const SEG   = 1;
const ACTOR = 'EMP_01250901';  // Ray、created_by / updated_by / changed_by

// 代碼 → schedules 欄位(寫死、勿臆測)
const CODE_MAP = {
  'A': { shift_type_id:'ST001', start_time:'09:00:00', end_time:'18:00:00', crosses_midnight:false, break_minutes:60, label:'早班 ST001 09:00-18:00' },
  'L': { shift_type_id:'ST007', start_time:'19:00:00', end_time:'03:00:00', crosses_midnight:true,  break_minutes:0,  label:'晚班 ST007 19:00-03:00 跨日' },
  '休': { shift_type_id:'ST003', start_time:null,       end_time:null,       crosses_midnight:false, break_minutes:0,  label:'休假 ST003' },
};

const APPLY = process.argv.includes('--apply');

// ════════════════════════════════════════════════════════════
// helpers
// ════════════════════════════════════════════════════════════
function pad2(n) { return String(n).padStart(2, '0'); }

function workDateOf(day) {
  return `${YEAR}-${pad2(MONTH)}-${pad2(day)}`;
}

// id pattern:SEMP_{empid去EMP_}{YYYYMMDD}_{seg}(對齊 prod 現有 row、emp 跟日期間「無下劃線」、
// 例 SEMP_0125050120260601_1)。若用我的舊版「SEMP_01250501_20260601_1」格式 upsert,
// UNIQUE(emp,date,seg) 匹配後 PG 會嘗試把 PK 改名 → 觸發 schedule_change_logs FK 擋下。
function buildId(employee_id, day, seg) {
  const empPart = employee_id.replace(/^EMP_/, '');
  return `SEMP_${empPart}${YEAR}${pad2(MONTH)}${pad2(day)}_${seg}`;
}

function parseCodes(csv) {
  const arr = String(csv).split(',').map(s => s.trim());
  if (arr.length !== DAYS) throw new Error(`codes 長度 ${arr.length} != ${DAYS}`);
  for (let i = 0; i < arr.length; i++) {
    if (!CODE_MAP[arr[i]]) throw new Error(`day ${i+1}: 未知代碼 '${arr[i]}'`);
  }
  return arr;
}

// 「實質排班內容」比較(不看 status)— 用於判 content-changed vs status-only
function rowsContentEqual(cur, tgt) {
  if (!cur) return false;
  const norm = v => v == null ? '' : String(v);
  return cur.shift_type_id === tgt.shift_type_id
      && norm(cur.start_time)  === norm(tgt.start_time)
      && norm(cur.end_time)    === norm(tgt.end_time)
      && !!cur.crosses_midnight === !!tgt.crosses_midnight
      && norm(cur.note)        === norm(tgt.note)
      && Number(cur.scheduled_work_minutes||0) === Number(tgt.scheduled_work_minutes||0);
}
// 全等(含 status、scheduled_work_minutes)— 判 真正 NO-OP(不寫 DB 也沒差)
function rowsFullyEqual(cur, tgt) {
  if (!rowsContentEqual(cur, tgt)) return false;
  const norm = v => v == null ? '' : String(v);
  return norm(cur.status) === norm(tgt.status);
}

function describeRow(r) {
  if (!r) return '(無)';
  const stid = r.shift_type_id || '(null)';
  const time = r.start_time && r.end_time ? `${String(r.start_time).slice(0,5)}-${String(r.end_time).slice(0,5)}` : '';
  const cm = r.crosses_midnight ? ' 跨日' : '';
  const note = r.note ? ` note=${JSON.stringify(r.note)}` : '';
  const st = ` [${r.status || '?'}]`;
  return `${stid}${time?' '+time:''}${cm}${note}${st}`;
}

// ════════════════════════════════════════════════════════════
// main
// ════════════════════════════════════════════════════════════
const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !KEY) { console.error('🔴 missing SUPABASE_URL / SERVICE_KEY'); process.exit(1); }
const sb = createClient(URL, KEY, { auth:{ autoRefreshToken:false, persistSession:false } });

const EMP_IDS = Object.keys(SOURCE);

// ─── 1. 載入 7 人 period 對照 ─────────────────────────────────
console.log(`\n═══ ${APPLY ? '🔴 APPLY MODE' : '📋 DRY-RUN'} | ${YEAR}/${pad2(MONTH)} | 7 人 × ${DAYS} 天 × seg ${SEG} ═══\n`);
const { data: periods, error: pErr } = await sb.from('schedule_periods')
  .select('id, employee_id, status, period_start, period_end')
  .in('employee_id', EMP_IDS).eq('period_year', YEAR).eq('period_month', MONTH);
if (pErr) { console.error('🔴 載入 periods 失敗:', pErr.message); process.exit(1); }
const periodMap = Object.fromEntries((periods || []).map(p => [p.employee_id, p]));
const missing = EMP_IDS.filter(id => !periodMap[id]);
if (missing.length) {
  console.error('🔴 缺以下員工 6 月 period:', missing.join(', '));
  process.exit(1);
}
console.log('📅 period 對照(7 人皆已存在):');
for (const id of EMP_IDS) {
  const p = periodMap[id];
  console.log(`  ${id} ${SOURCE[id].name}: ${p.id} status=${p.status} ${p.period_start}~${p.period_end}`);
}

// ─── 2. 組目標 210 列 ───────────────────────────────────────
const targets = [];
for (const empId of EMP_IDS) {
  const codes = parseCodes(SOURCE[empId].codes);
  const periodId = periodMap[empId].id;
  for (let day = 1; day <= DAYS; day++) {
    const cfg = CODE_MAP[codes[day-1]];
    const swm = calculateScheduleWorkMinutes(
      cfg.start_time, cfg.end_time, cfg.break_minutes, cfg.crosses_midnight,
    );
    targets.push({
      id: buildId(empId, day, SEG),
      employee_id: empId,
      period_id: periodId,
      work_date: workDateOf(day),
      shift_type_id: cfg.shift_type_id,
      segment_no: SEG,
      start_time: cfg.start_time,
      end_time: cfg.end_time,
      crosses_midnight: cfg.crosses_midnight,
      scheduled_work_minutes: swm,
      note: '',
      status: 'confirmed',
      created_by: ACTOR,
      updated_by: ACTOR,
    });
  }
}
console.log(`\n✓ 已組 ${targets.length} 列目標(7 × ${DAYS} × seg ${SEG})`);

// ─── 3. 載入現況 ─────────────────────────────────────────────
const { data: existing, error: eErr } = await sb.from('schedules')
  .select('id, employee_id, work_date, segment_no, shift_type_id, start_time, end_time, crosses_midnight, scheduled_work_minutes, note, status, period_id')
  .in('employee_id', EMP_IDS)
  .gte('work_date', workDateOf(1)).lte('work_date', workDateOf(DAYS))
  .eq('segment_no', SEG);
if (eErr) { console.error('🔴 載入現況失敗:', eErr.message); process.exit(1); }
const curByKey = Object.fromEntries(
  (existing || []).map(r => [`${r.employee_id}|${r.work_date}`, r]),
);
console.log(`📊 現況 schedules(7 人 × 6 月 × seg ${SEG}):${existing?.length || 0} 列\n`);

// ─── 4. 逐人 diff + 統計 ──────────────────────────────────────
// 4 種類別:
//   ✓ NO-OP        — 全等(連 status 都對)、不需寫
//   • STATUS-only  — 實質內容相同、僅 status 升 draft→confirmed
//   🔄 CONTENT      — shift_type / time / note / cm / swm 實質有變
//   + INSERT       — 現況無 row
const stats = { content: 0, statusOnly: 0, insert: 0, noop: 0, byCode: { A: 0, L: 0, '休': 0 } };
const perEmpStats = {};

for (const empId of EMP_IDS) {
  const codes = parseCodes(SOURCE[empId].codes);
  let content = 0, statusOnly = 0, ins = 0, nop = 0;
  const changeLines = [];
  for (let day = 1; day <= DAYS; day++) {
    const code = codes[day-1];
    stats.byCode[code]++;
    const wd = workDateOf(day);
    const cur = curByKey[`${empId}|${wd}`];
    const tgt = targets.find(t => t.employee_id === empId && t.work_date === wd);
    if (rowsFullyEqual(cur, tgt)) {
      nop++; stats.noop++;
    } else if (cur && rowsContentEqual(cur, tgt)) {
      statusOnly++; stats.statusOnly++;
      // status-only 不印明細(會洗版 158 行)、summary 統一報
    } else if (cur) {
      content++; stats.content++;
      changeLines.push(`  🔄 ${wd}  ${describeRow(cur).padEnd(56)} → ${describeRow(tgt)}`);
    } else {
      ins++; stats.insert++;
      changeLines.push(`  + ${wd}  (無 row、INSERT)                                          → ${describeRow(tgt)}`);
    }
  }
  perEmpStats[empId] = { content, statusOnly, ins, nop };
  console.log(`─── ${empId} ${SOURCE[empId].name} ───`);
  console.log(`  ✓ NO-OP ${nop}  • STATUS-only ${statusOnly}(draft→confirmed)  🔄 CONTENT ${content}  + INSERT ${ins}`);
  if (changeLines.length) {
    console.log(`  實質變動明細:`);
    for (const l of changeLines) console.log(l);
  }
  console.log();
}

// ─── 5. 總計 ─────────────────────────────────────────────────
console.log('═══ 總計 ═══');
console.log(`各代碼張數: A(早) ${stats.byCode.A} · L(晚) ${stats.byCode.L} · 休 ${stats.byCode['休']}  Σ=${stats.byCode.A + stats.byCode.L + stats.byCode['休']}`);
console.log(`🔄 CONTENT     : ${stats.content} 列(shift_type / time / note 實質變動)`);
console.log(`• STATUS-only  : ${stats.statusOnly} 列(draft→confirmed,實質內容沒動)`);
console.log(`+ INSERT       : ${stats.insert} 列  ${stats.insert > 0 ? '🔴 警告:出現非預期 INSERT' : '✓'}`);
console.log(`✓ NO-OP        : ${stats.noop} 列(全等、不需寫)`);
console.log(`Σ 真實會寫 upsert:${stats.content + stats.statusOnly + stats.insert} 列 / 應動 210 列`);

if (!APPLY) {
  console.log('\n💡 此為 dry-run、未寫 DB。確認 diff OK 後加 --apply 才會真寫入 + 寫稽核');
  console.log('   change_type 將寫:manager_adjust(本批=主管調整 published period 已存在 row,符合狀態機 published+adjust→published 規則)');
  process.exit(0);
}

// ─── 6. APPLY:upsert + 寫稽核 ────────────────────────────────
console.log('\n🔴 APPLY:upsert schedules + 寫稽核 ...');
const { error: upErr } = await sb.from('schedules')
  .upsert(targets, { onConflict: 'employee_id,work_date,segment_no' });
if (upErr) { console.error('🔴 upsert 失敗:', upErr.message); process.exit(1); }
console.log(`✓ upsert 完成、${targets.length} 列已寫入`);

// 每位員工一筆 manager_adjust(對齊 lib/schedule/change-logger.js CHECK + 狀態機
// RULES published+adjust→published)
const repo = {
  async insertScheduleChangeLog(row) {
    const { data, error } = await sb.from('schedule_change_logs').insert([row]).select().single();
    if (error) throw error;
    return data;
  },
};
const reason = '2026-06 最終班表批次覆寫,來源 Excel,操作者 EMP_01250901';
let logOk = 0, logFail = 0;
for (const empId of EMP_IDS) {
  const s = perEmpStats[empId];
  try {
    await logScheduleChange(repo, {
      schedule_id: null,
      employee_id: empId,
      change_type: 'manager_adjust',
      changed_by: ACTOR,
      before_data: { source: 'placeholder_schedules', month: '2026-06' },
      after_data:  { source: 'excel_batch', month: '2026-06',
                     content_changed: s.content, status_only: s.statusOnly,
                     inserted: s.ins, noop: s.nop },
      reason,
      isLateChange: false,
    });
    logOk++;
  } catch (e) {
    console.error(`  🔴 ${empId} log 失敗:`, e.message);
    logFail++;
  }
}
console.log(`✓ 稽核寫入:${logOk} 成功 / ${logFail} 失敗`);
console.log(`\n完成。`);
